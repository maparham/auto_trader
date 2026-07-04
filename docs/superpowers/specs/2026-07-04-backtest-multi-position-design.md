# Backtest multiple independent positions, scaling & break-even — design

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan
**Builds on:** `2026-07-04-backtest-stops-targets-design.md` (per-side stop/take-profit/trailing exits)

## Problem

The backtest holds at most one position per side. `RuleStrategy` gates every
entry on the side being flat (`position_long == 0`) and always exits the whole
position at once, so you can't hold several trades on the same instrument, can't
scale in or out, and can't see distinct positions on the chart. Real strategies
routinely run multiple concurrent entries, each with its own stop/target, and
move stops to break-even once a trade is in profit.

This adds, for the **backtest only** (not live/paper trading):

1. **Multiple independent positions** per side — each entry is its own trade with
   its own entry/stop/take-profit/exit/P&L, several open at once. Default.
2. **Pyramiding** as an alternative mode — adds merge into one averaged position.
3. **Scaling in** — the entry rule re-firing opens more, bounded by a max count
   and a spacing threshold.
4. **Scaling out** — the exit rule can close all / one / a fraction of the open
   positions; individual stops/targets already close positions independently.
5. **Break-even stop** — once a position's profit reaches a threshold, move its
   stop to break-even automatically.
6. **Per-position chart lines** — each position draws its own entry→exit segment.

## Non-goals (explicit)

- No change to live/paper trading. The backtest strategy shares the
  `Strategy`/`Context`/`Signal` interface with live, but this work touches only
  the backtest engine, `RuleStrategy`, the Backtest settings modal, and backtest
  result rendering.
- No new entry/exit *rule* operators or indicators.
- No averaging-down trigger, no time-based adds, no separate "add" rule group —
  adds are driven by the existing entry rule re-firing (see §3).
- No per-position manual editing on the chart (backtest artifacts stay read-only).

## Invariant #1 (the anchor)

**Default settings reproduce today's backtest byte-for-byte.** The default is
`positionMode = independent`, `maxConcurrent = 1`, spacing off, `exitRuleScope =
all`, break-even off. Under that default the engine must behave exactly as it
does now, and the existing suites (329 backend, 23 frontend backtest tests) must
pass unchanged. No new knob changes default behavior. The P1 refactor (§8) lands
and is regression-locked before any new knob is built.

## Design

### 1. Strategy ↔ engine seam

Today `RuleStrategy.on_bar` self-gates: it only emits a BUY when the bucket is
flat, and emits a SELL for the whole position on exit. That gate moves out of the
strategy.

- **Strategy** emits a BUY *intent* (leg=long) on **every** bar the entry rule is
  true, and a SELL *intent* on every bar the exit rule is true. It no longer
  inspects position size to decide whether to fire. (The `trade_from_time`
  warm-up gate on entries stays.)
- **Engine** owns all position management. It is the only layer that knows the
  open-position count and the last entry price (spacing needs both). On each BUY
  intent it decides: **append** a new position, **merge** into the open one, or
  **reject**. On each SELL intent it applies the exit-rule scope (§4).

This keeps `rule.py` nearly untouched — only the flat-gate and the full-size exit
quantity are removed; rule evaluation is unchanged. The `Signal` still carries
`side`/`quantity`/`reason`/`leg`; `quantity` on a BUY intent is the per-entry
size (the existing `Costs.quantity`).

### 2. Data model — a list of positions per side

Replace the scalar buckets (`long_qty`, `long_entry`, `long_stop`, …) with a list
per side:

```python
@dataclass(slots=True)
class Position:
    qty: float
    entry: float                 # weighted-average entry (== entry for independent)
    open_time: datetime
    open_reason: str
    stop: float | None           # active stop level (None = no stop)
    target: float | None         # active take-profit level
    extreme: float               # favorable high/low water mark (trailing)
    breakeven_armed: bool        # break-even already applied?
```

Engine state becomes `longs: list[Position]`, `shorts: list[Position]`. All the
existing per-position logic (stop/target seeding from fill price, intra-bar
check, trailing ratchet with the only-tightens clamp) now runs **per element**.

**Mode picks append vs merge on a BUY intent that passes the cap/spacing gate:**

- **independent** → append a new `Position` (its stop/target seeded from *its*
  fill price, extreme seeded to its entry, break-even disarmed).
- **pyramiding** → merge into the single open position: recompute the weighted-
  average `entry`, then **recompute `stop`/`target` from the new average entry,
  reset `extreme` to the new average entry, and set `breakeven_armed = False`.
  The merged position behaves exactly like one freshly opened at the average
  price. (Pyramiding keeps the list length ≤ 1.)

Rationale for the merge rule: it is the one intuitive, predictable definition —
"the position's stop is X% from its average entry." Pyramiding up (a trend
re-firing the entry rule) raises the average and tightens a % stop; averaging
down would loosen it, but averaging-down is not a supported trigger and
pyramiding is opt-in.

### 3. Opening more (scale-in bounds)

Per side, the engine accepts a BUY intent to **append** (independent) only if:

- **count gate:** open positions on that side `< maxConcurrent`.
- **spacing gate:** if spacing is set, price has moved at least the threshold in
  the favorable direction since the **last** open on that side. Threshold is
  either `minSpacingPct` (percent of the last entry) or `spacingAtr` (× the
  posted ATR at the current bar); off by default. For a long, "favorable" means
  the new intended fill is ≥ last-entry × (1 + pct) (or ≥ last-entry + n·ATR);
  mirror for short.

A rejected intent is simply dropped for that bar (no fill, no error). In
**pyramiding** mode the cap is effectively 1 position but `maxConcurrent` instead
bounds the number of **adds** (merges); spacing gates adds the same way.

### 4. Exit-rule scope (scale-out)

When the shared exit rule fires (a SELL intent), the engine closes open positions
on that side per `exitRuleScope`:

- **all** (default) — close every open position on that side this bar.
- **fifo** — close the oldest one position.
- **lifo** — close the newest one position.
- **fraction** — close `ceil(exitFraction × open_count)` positions, oldest first
  (e.g. `0.5` with 3 open closes 2). `exitFraction` in (0, 1].

Individual positions still close independently the moment *their own* stop or
take-profit triggers intra-bar (§ carried over from the stops feature), regardless
of the exit rule. Fills at the next bar's open, same as today; a same-bar rule
exit still pre-empts an intra-bar stop for the positions it closes.

### 5. Break-even stop

Break-even is another stop-tightening source, folded into the **same clamp** the
trailing stop uses — not a separate mechanism. Per open position, each bar (in the
trailing-update step, after the intra-bar check):

- If `breakeven` is enabled and not yet armed, and the position's unrealized
  profit ratio ≥ `breakeven.triggerPct` (long: `(bar.close − entry)/entry`;
  short mirror), then set the break-even level `be = entry + offset` (long;
  `entry − offset` short; `offset` defaults to 0 = true break-even) and clamp:
  `stop = be if stop is None else max(stop, be)` (long; `min` short). Mark
  `breakeven_armed = True`.

Because it's a clamp, break-even composes with any stop kind (fixed %, ATR,
trailing) and works even when the position has **no** configured stop — in that
case it arms a stop at break-even. It only ever tightens, and only fires once.

Ordering: evaluate break-even in the same per-position pass as the trailing
ratchet (step "1c" of the stops-feature loop), so it affects the *next* bar's
intra-bar check — never the current bar's, preserving no-lookahead.

### 6. Settings shape

Per side (mirrors the existing per-side rule groups + risk config):

```ts
type PositionMode = "independent" | "pyramiding";
type ExitScope = "all" | "fifo" | "lifo" | "fraction";

interface ScalingConfig {
  mode: PositionMode;          // default "independent"
  maxConcurrent: number;       // default 1
  spacing?:                    // default undefined (off)
    | { kind: "pct"; value: number }
    | { kind: "atr"; mult: number; length: number };
  exitScope: ExitScope;        // default "all"
  exitFraction?: number;       // used when exitScope === "fraction"
  breakeven?:                  // default undefined (off)
    { triggerPct: number; offset?: number };
}
// BacktestConfig gains: longScaling?: ScalingConfig, shortScaling?: ScalingConfig
```

All optional; an absent `*Scaling` is treated as the default above. Mirrored as a
backend DTO in `app.py` and an engine dataclass. Spacing/break-even ATR reuse the
posted `ATR_{length}` series channel (validated like the risk configs).

### 7. Chart rendering

Each **closed** position draws its own entry→exit line segment (entry point →
exit point), colored green for a win / red for a loss, reusing the app's existing
trade-line visual style; hover shows that position's P&L, entry/exit price, and
open→close duration. This replaces relying only on scattered fill markers for
telling positions apart. Entry/exit fill markers (with SL/TP labels) stay. The
equity curve and max-drawdown remain aggregate across all positions.

The backend already returns a `trades[]` list of round-trips (entry/exit
time+price+pnl+leg); per-position lines render from that — each `Trade` is one
position's life. Extend the trade DTO if needed with the exit `reason` so a
line can show why it closed.

### 8. Build order (phased; each phase independently testable)

- **P1 — engine refactor to `list[Position]`.** Move position management into the
  engine, drop the strategy flat-gate, unify pyramiding/independent on append-vs-
  merge. Ship with default behavior only (max 1, independent) and **regression-
  lock**: existing 329 backend + 23 frontend tests pass unchanged. No new knob yet.
- **P2 — multi-open:** `mode` + `maxConcurrent` + spacing gates (append path).
- **P3 — exit-rule scope:** all/fifo/lifo/fraction.
- **P4 — break-even stop.**
- **P5 — per-position chart lines** (+ the modal "Scaling & management" section
  housing all of P2–P4's controls, collapsed by default so the common case stays
  simple).

## Testing

- **Regression (P1):** a config at defaults reproduces prior fills/trades/equity
  exactly; the existing engine, hedging, rule-strategy, and api suites pass
  unchanged.
- **Multi-open:** entry rule true on N bars opens min(N, maxConcurrent) positions;
  spacing rejects a second open until price moves the threshold; each position
  gets its own stop/target off its own entry.
- **Independent exits:** three positions with different entries each hit their own
  stop/target on different bars → three distinct trades with correct per-position
  P&L; aggregate equity/drawdown correct.
- **Exit scope:** exit rule with `all` closes every open position; `fifo`/`lifo`
  close the correct single one; `fraction 0.5` of 3 open closes 2 (oldest first).
- **Pyramiding merge:** two adds merge to one position with weighted-average
  entry; stop/target recomputed off the average; break-even disarmed on merge.
- **Break-even:** a position reaching the trigger arms `stop = entry` (or entry+
  offset), never loosens, fires once; composes with no-stop, fixed, and trailing;
  no-lookahead (arms for the next bar, not the current).
- **Frontend:** settings round-trip (absent scaling = defaults); per-position
  lines render one segment per trade, colored by sign.
