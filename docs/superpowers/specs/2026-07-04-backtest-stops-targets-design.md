# Backtest stop-loss / take-profit / trailing exits — design

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Problem

The backtest engine today supports exactly one class of strategy: a single
instrument, one position per side, where **both** the entry and the exit are
rule conditions. An exit only happens when a rule is true. You cannot express
"buy with a 2% stop" — one of the most common patterns in real trading.

This adds **price-level exits** — stop-loss, take-profit, and trailing stop —
as a new exit class that coexists with the existing rule-based exits.

## Non-goals (explicit scope boundaries)

Out of scope for this spec; each is a separate follow-up:

- Risk-based / volatility-based position sizing (size from stop distance).
- Pyramiding / partial (scaled) exits.
- A full trade-list table UI.
- Multi-timeframe ATR.
- Any change to how entries or rule-based exits work.

## Background: current architecture

- **Frontend computes all indicator math**, posts candles + precomputed series
  + rules to the backend. The **engine does zero indicator math** — it only
  evaluates posted series and simulates fills. This keeps the traded candles
  identical to the ones indicators were computed on (no re-fetch drift).
- Engine: `backend/auto_trader/engine/backtest.py` — event-driven, fills a
  signal from bar `t` at bar `t+1`'s **open**, marks to market at the **close**.
  It never inspects a bar's high/low today.
- Strategy: `backend/auto_trader/strategy/rule.py` (`RuleStrategy`) — per-side
  entry/exit rule groups, one position per side (long + short buckets can be
  held together). Fixed `quantity` sizing. No stops/targets.
- Config mirror: `frontend/src/lib/backtestConfig.ts`. Modal:
  `frontend/src/BacktestSettingsModal.tsx`. Series compute:
  `frontend/src/lib/backtestSeries.ts`. API DTOs + endpoint:
  `backend/auto_trader/api/app.py` (`POST /api/backtest`).

## Design

### 1. Data model

Add one optional block **per side**, `RiskConfig`, sitting below the exit rules.
The stop is a single choice with several *kinds*; the target is a separate
choice. "Trailing" is a kind of stop, not a separate field — you pick **one**
stop behavior and **one** target.

```ts
// frontend/src/lib/backtestConfig.ts (mirrored as a backend DTO)

type StopKind =
  | 'none'
  | 'pct'        // fixed: value % from entry
  | 'price'      // fixed: absolute price level
  | 'atr'        // fixed: mult × ATR(length) at entry
  | 'trailPct'   // trailing: value % below the running extreme
  | 'trailAtr'   // trailing: mult × ATR(length) below the running extreme

type TargetKind =
  | 'none'
  | 'pct'
  | 'price'
  | 'atr'

interface StopSpec {
  kind: StopKind
  value?: number    // pct value, or absolute price
  mult?: number     // ATR multiple
  length?: number   // ATR length (default 14)
}

interface TargetSpec {
  kind: TargetKind
  value?: number
  mult?: number
  length?: number
}

interface RiskConfig {
  stop: StopSpec       // default { kind: 'none' }
  target: TargetSpec   // default { kind: 'none' }
}

// BacktestConfig gains:
//   longRisk?:  RiskConfig
//   shortRisk?: RiskConfig
// Both default to none-configured => behaves exactly as today.
```

**ATR becomes a real posted series.** Whenever a `RiskConfig` references ATR
(kinds `atr` / `trailAtr`), the frontend computes an `ATR_{length}` series
(Wilder's ATR) and posts it. The engine only *reads* it — `%` is arithmetic on
the fill price, ATR is a series lookup. This preserves the "engine does zero
indicator math" rule.

### 2. Engine fill mechanics (the core)

The engine becomes stop-aware. Level computation lives in the **engine** (not
the strategy) because only the engine knows the actual fill price and can see
intra-bar. `RuleStrategy` is unchanged.

Per-bar order of operations:

1. **Fill pending entries** at this bar's open *(as today)*. On fill, compute
   the stop/target **levels from the actual fill price** and store them on the
   position, plus a trailing `extreme` (highest high for a long / lowest low for
   a short, seeded to the fill bar).
   - `pct` stop (long): `stop = fill * (1 - value/100)`.
   - `atr` stop (long): `stop = fill - mult * ATR_length[entry_bar]`.
   - `price` stop: the absolute level as given.
   - Target computed symmetrically (upside for a long).
   - Shorts mirror all of the above.
2. **Fill pending rule-exits** at this bar's open *(as today)*. These happen at
   the open, so they take precedence over an intra-bar stop on the same bar,
   which is chronologically correct.
3. **Check stop/target intra-bar (NEW).** For each still-open position, test
   this bar's low/high against the stored levels. All conventions **pessimistic**:
   - **Long stop** triggers if `low <= stop`. Fill at `min(open, stop)` — a
     gap-down through the stop fills at the worse open, not the stop.
   - **Long target** triggers if `high >= target`. Fill exactly at `target` — no
     positive slippage from a favorable gap.
   - **The open resolves order when it can.** If the bar *opens* at/through the
     target (long: `open >= target`), the target filled first — book the target,
     not the stop. Only when the open sits *between* the two levels is the order
     genuinely ambiguous, and **there the stop wins** (pessimistic; OHLC can't
     say which came first). Symmetric for the stop side, already handled by
     `min(open, stop)`. (Without this, a bar that gaps open past the target but
     later dips through the stop would book a winner as a loss.)
   - **Short** is the mirror image: stop triggers if `high >= stop`, fill at
     `max(open, stop)`; target triggers if `low <= target`, fill at `target`.
   - The existing `slippage` cost still applies to the fill, against you.
   - Booked trade gets `reason` = `stop` | `target` | `trail`.
4. **Trailing update — no lookahead.** The stop level *entering* a bar is based
   on the `extreme` through the **previous** bar. In step 3 we test this bar's
   low/high against that level **first**. Only *after* (if not stopped) do we
   extend `extreme` with this bar's high/low and recompute the trailing stop for
   the next bar. A bar can never both raise the stop and be saved by that raise.
   - `trailPct` (long): `stop = extreme * (1 - value/100)`.
   - `trailAtr` (long): `stop = extreme - mult * ATR_length[current_bar]`.
   - Trailing stops only ever ratchet in the favorable direction. Because the
     `trailAtr` distance rides on ATR (which is not monotone), the recomputed
     level is clamped so it never loosens — the stop is `max(prev, new)` for a
     long, `min(prev, new)` for a short. This also means a momentarily cold ATR
     never wipes an existing trailing stop.
5. **Mark to market at close** and **ask the strategy for the next signal**
   *(as today)*. A position can open and hit its stop on the **same** bar
   (step 1 then step 3). A stopped-out bucket is flat again and free to re-enter
   on the next signal.

Consequence to accept: stops make results **path-dependent within a bar**, so on
very large bars the fill is an assumption, not a fact. The pessimistic
convention keeps that assumption honest rather than flattering.

### 3. UI

Each side panel (`SidePanel` in `BacktestSettingsModal.tsx`) gains a compact
**"Stop & target"** section under the exit rules. Off by default, so existing
presets are untouched.

```
STOP & TARGET (LONG)
  Stop    [ None ▾ ]           picking a kind reveals its input(s):
            % from entry   -> [ 2.0 ] %
            ATR ×          -> [ 2.0 ] × ATR[ 14 ]
            Trailing %     -> [ 2.0 ] %
            Trailing ATR × -> [ 2.0 ] × ATR[ 14 ]
            Fixed price    -> [ 0.00 ]
  Target  [ None ▾ ]  (same set, minus the trailing kinds)
```

### 4. Wiring

- **Types:** add `RiskConfig` / `StopSpec` / `TargetSpec` to
  `backtestConfig.ts`; add `longRisk` / `shortRisk` to `BacktestConfig`
  (defaulting to none). Mirror as request DTOs in `app.py`.
- **Series:** `backtestSeries.ts` computes `ATR_{n}` (Wilder's ATR) when a
  `RiskConfig` references it. `ATR` joins the indicator whitelist and the
  endpoint's series-presence validation (D4).
- **Engine:** `BacktestEngine` accepts per-side risk config, stores levels on
  each position, runs step 3 / step 4. `RuleStrategy` unchanged.
- **Rendering:** stop/target exits reuse the existing trade markers, with a
  distinct label (`SL` / `TP`) so the chart shows *why* each trade closed.
  Surface the already-computed `max_drawdown` in the summary chip — stops are
  fundamentally about drawdown.

## Testing

- **Engine unit tests** (pure, no network) drive synthetic OHLC bars:
  - Long % stop: low pierces stop → fill at stop; gap-down open below stop →
    fill at open.
  - Long % target: high reaches target → fill exactly at target; gap-up open
    above target → still fill at target (no positive slippage).
  - Both stop and target inside one bar → stop wins.
  - Same-bar entry-then-stop (entry at open, stop hit later in that bar).
  - Trailing stop ratchets on prior-bar extremes, no lookahead: a bar whose
    high would raise the stop does not retroactively save its own low.
  - ATR stop/target read the posted `ATR_n` series at the correct bar index.
  - Short mirror of each case above.
  - Rule-exit at the open pre-empts an intra-bar stop on the same bar.
  - No-risk-config run reproduces today's results byte-for-byte (regression).
- **Series test:** `ATR_{n}` matches a known Wilder's-ATR reference.
- **Frontend:** modal reveals the right inputs per stop kind; config with no
  stop/target round-trips unchanged; a configured RiskConfig posts the ATR
  series when referenced.
```
