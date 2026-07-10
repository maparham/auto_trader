# Coded Strategies (Python) — Design

**Date:** 2026-07-09
**Status:** Approved for planning

## Problem

The backtest panel is a point-and-click rule builder. Everything a strategy
does must be expressible as `RuleGroup`s of `left op right` comparisons. That's
fine for "EMA9 crosses above EMA21", but it can't express: multi-bar lookback
loops, custom math, conditional logic that branches, indicators we haven't
built as operands, or anything a programmer would reach for. Users want to write
a strategy the way they'd write it in code.

This spec adds **coded strategies**: user-authored Python files that run through
the *same* backtest and live engines the rule builder already uses.

## Key decisions (locked)

- **Language:** Python, on the backend. The `Strategy` interface,
  `BacktestEngine`, and the live evaluator (`/api/strategy/evaluate`) are already
  Python. Coded strategies are just an alternative `Strategy` implementation.
- **Indicator access:** an ad-hoc Python indicator API (`ctx.ema(9)`,
  `ctx.rsi(14)`, …), *not* pre-declared series. Maximum flexibility.
- **Authoring:** `.py` files on disk under `backend/strategies/`. Edited in the
  user's own IDE; the app discovers them and lists them in a dropdown. No
  in-browser editor, no code-storage layer, no sandbox (single-user local tool —
  same trust level as the rest of the backend).
- **Scope:** backtest **and** live from day one — the same file runs both,
  because the `Strategy` interface is shared.
- **Exits/risk:** code can do both — close positions directly *and* attach
  bracket levels (`sl=`/`tp=`) to an entry that the existing engine machinery
  then manages.
- **No third-party TA library** for the built-in indicators — see §3.

## The reframe: the indicator layer is the center of gravity

The seductive framing is "just add an alternative `Strategy` class and the
engine comes for free." True, but it undersells the work. **The backend does
zero indicator math today** — the frontend computes every series via
`buildSeries()` and POSTs them; the backend only reads them by key
(`series_name(op)` contract in `strategy/rule.py`).

Choosing ad-hoc `ctx.ema(9)` means building an entire indicator-computation
layer in Python from scratch: base math **plus** MTF fetch/forward-fill/
alignment **plus** slope (%/hr) **plus** no-lookahead semantics — and keeping it
in lockstep with the existing TS implementation. **That layer, not the Strategy
class, is the bulk of the work and the main risk.** It is a first-class
component in this design, not a line item.

## Components

### A. Python indicator layer — `backend/auto_trader/indicators/`

Ports the indicator formulas from the frontend
(`frontend/src/lib/customIndicators.ts`, `indicators.ts`, `atr.ts`, `mtf.ts`)
into Python, numpy-backed.

- **v1 (Phase 1):** EMA, SMA, RSI, ATR, AVWAP, VOL, VOLMA — base timeframe only.
- **Later (Phase 4):** MTF (`tf=` argument) with forward-fill alignment, and
  slope (%/hr). The `customIndicators.ts` extras (LR, PIVOT_BANDS, PREV_HL,
  VWAP) follow as demand warrants.
- **No-lookahead** is enforced *by the layer*: an indicator evaluated at bar `i`
  can only see bars `0..i` (closed bars). User discipline is not relied upon.
- **Memoized** (Trap 3): the full series is computed once per
  `(indicator, params, tf)` key and cached on the `ctx`; per-bar calls index in.
  Naive per-bar recompute is O(n²) and is disallowed by construction.

### B. Strategy discovery / loader

- Scans `backend/strategies/*.py`. Each file exposes:
  - `on_bar(ctx) -> list[Action]` (required)
  - optional module docstring and/or `meta = {...}` dict (name, description,
    hedged flag — see §Description and §Netted).
- `GET /api/strategies` returns `[{filename, name, description, hedged}, …]`.
- `GET /api/strategies/{filename}/source` returns the raw source text for the
  read-only "View source" panel.
- Loading is by import/exec of the module; reload re-reads from disk (the user
  edits the file in their IDE between runs).

### C. The `ctx` object

The façade the strategy talks to. Wraps candle history, position state, the
memoized indicator layer, and the action helpers. Full surface in §API.

### D. Wiring — `CodedStrategy(Strategy)`

Adapts a loaded file to the existing `Strategy` interface so `BacktestEngine`
and `/api/strategy/evaluate` consume it unchanged. `on_bar` is called once per
bar; it builds a `ctx`, calls the user's `on_bar(ctx)`, and translates the
returned actions into the existing `Signal` shape (with brackets attached).

## The `ctx` API

A strategy file is just a module with an `on_bar` function:

```python
"""EMA(9)/EMA(21) crossover with an RSI<30 pullback filter. Longs only.
Attaches a 2% stop and 4% target. Best on trending FX majors."""

meta = {"name": "EMA Cross + RSI"}

def on_bar(ctx):
    if ctx.ema(9) > ctx.ema(21) and ctx.rsi(14) < 30:
        return [ctx.buy(sl=ctx.close * 0.98, tp=ctx.close * 1.04,
                        reason="EMA9>EMA21 & RSI<30")]
    if ctx.position.is_long and ctx.rsi(14) > 70:
        return [ctx.close_long(reason="RSI>70")]
    return []
```

| Group | Members | Notes |
|---|---|---|
| **Price** | `ctx.open/high/low/close/volume`, `ctx.time` | current (closed) bar |
| **Indicators** | `ctx.ema(len, tf=None, back=0)`, `ctx.sma`, `ctx.rsi`, `ctx.atr`, `ctx.avwap(anchor)`, `ctx.vol`, `ctx.volma`, `ctx.slope(indicator, length, n, tf=None)` | memoized; default current-bar value; `back=n` reads n closed bars back (crossovers), warm-up = None, `back<0` rejected; `tf=` is Phase 4 |
| **History** | `ctx.closes`, `ctx.highs`, `ctx.lows`, `ctx.opens`, `ctx.volumes`, `ctx.bars_since_entry` | numpy arrays over closed bars, for lookback/custom math |
| **Position** | `ctx.position.is_long/is_short/is_flat`, `.entry_price`, `.entry_time`, `.qty` | netted single position |
| **Actions** | `ctx.buy(qty=, sl=, tp=, reason=, note=)`, `ctx.sell(...)`, `ctx.close_long(reason=)`, `ctx.close_short(...)`, `ctx.exit(...)` | return a list; `sl/tp` hand a bracket to the engine |

### Contract rules

- **Stateless (Trap 1).** No state carried across bars via `self`/globals.
  Everything is derivable from `ctx` history + position (e.g. "bars since entry"
  is `ctx.bars_since_entry`). This is *what makes backtest == live*: backtest
  loops one long-lived instance, but live (`/api/strategy/evaluate`)
  re-instantiates the strategy per bar as a one-bar decision. State stashed on
  `self` would work in backtest and silently do nothing live. v1 mandates
  stateless. (A future explicit `ctx.state` dict that the live journal
  persists/rehydrates is possible but out of scope.)
- **Netted semantics (Trap 2).** The action API gates to netted single-position:
  flat → may enter; held → may only exit the held side. The backtest engine
  *can* hold long+short simultaneously, but live is netted — so a hedged
  strategy would backtest fine and be un-runnable live. Netted-by-construction
  keeps them identical. A file may set `meta["hedged"] = True` to opt into
  simultaneous long+short; such a strategy is **marked backtest-only** and
  refused by the live path.
- **No-lookahead.** Indicators return the current *closed*-bar value; no future
  bars are reachable. Enforced by the indicator layer.

## No third-party TA library (rationale)

`ctx.ema(9)` **must equal the EMA the user sees on the chart**, or the backtest
lies. Third-party libraries (TA-Lib, pandas-ta) each make their own convention
choices that will *not* match `customIndicators.ts`:

- **RSI** — Wilder's smoothing vs. simple SMA of gains/losses.
- **EMA** — first-value seeding (SMA seed vs. first-price) and warm-up.
- **AVWAP** — the anchored variant mostly doesn't exist in these libs.
- **VOLMA, slope (%/hr), MTF forward-fill, no-lookahead** — our semantics; no
  library implements them.

A library wouldn't save the parity work — it would *add* a reconciliation
problem on top of it, and we'd still write the alignment/slope/MTF logic
ourselves. So: **port the exact formulas from `customIndicators.ts` into
Python, numpy-backed.** The TS file is the spec; the golden-master parity suite
(Trap 4) guarantees Python == TS. `numpy`/`pandas` are fine as *compute
primitives the user's own strategy code may import* — that's the author's
business, not the indicator layer's contract.

## Parity test suite (Trap 4)

Golden-master tests asserting the Python indicator layer equals the TS output,
run against a fixed candle fixture. Must explicitly cover **MTF alignment and
slope** (Phase 4), not only base EMA — those are the subtle ones where seeding
and forward-fill diverge. When base indicators land (Phase 1) the suite covers
them; it extends alongside Phase 4.

## Frontend presentation

The backtest panel gets a top-level switch: **`Rules` | `Strategy`**. Picking
`Strategy` swaps the rule/risk/scaling panels for a compact strategy view:

```
┌─ Backtest ───────────────────┐
│ [Rules] [Strategy]           │
│ Strategy: [ ema_cross ▾ ]  ⟳ │   ← dropdown of discovered .py + reload
│ EMA Cross + RSI              │   ← name (meta or filename)
│ EMA9/EMA21 crossover with an │   ← DESCRIPTION, always visible
│ RSI<30 pullback filter…      │
│ ▸ View source                │   ← read-only, syntax-highlighted, collapsed
│ [Run backtest]               │
└──────────────────────────────┘
```

- **Dropdown** lists discovered files by name (fallback: filename), with a
  one-line description preview. **⟳ reload** re-scans disk.
- **Description — always visible, first-class** (not behind a disclosure).
  Source precedence: `meta["description"]` → module docstring → a subtle "No
  description" hint that nudges the author to write one. Long text clamps with
  the full string on hover via the shared `Tooltip`.
- **View source** — read-only, syntax-highlighted `.py` (from
  `/api/strategies/{f}/source`). Editing happens in the user's IDE; the panel
  just shows what's running so the user isn't guessing which version ran.
- **Results render for free.** A coded strategy returns the same
  `BacktestResult`, so markers, equity curve, trade dock, period shading,
  higher-TF aggregate pills, and persistence all work unchanged.
- **"Why this trade fired."** The rule-marker popover shows *passing rules* —
  coded strategies have none. So `Signal.reason` becomes the author's job via
  `ctx.buy(reason="…")`. Authors may also attach labeled values via
  `note={"rsi": ctx.rsi(14), …}`, which the *same* popover renders as a plain
  key/value list. Default when the author supplies nothing: the marker still
  shows side/price/P&L, just no breakdown.
- **Risk panel hides** when a coded strategy is selected — code owns risk.
- **Errors surface in the panel**, not the console: a `SyntaxError`, undefined
  indicator, or runtime throw on bar N returns a structured error (file + line +
  message) shown inline, so a broken strategy is obvious without tailing logs.
- **Live panel** gets the same `Strategy: [ ▾ ]` selector; picking a coded
  strategy to run live works exactly like picking it to backtest. Hedged
  (backtest-only) strategies are disabled in the live selector.

## Phasing

1. **Indicator layer + parity suite** — base-TF EMA/SMA/RSI/ATR/AVWAP/VOL/VOLMA,
   numpy-backed, golden-master vs TS. No UI yet; this is the foundation.
2. **Loader + `ctx` + `CodedStrategy` + backtest wiring + frontend `Strategy`
   tab** — dropdown, description, view-source, error surfacing; base-TF
   strategies backtest end-to-end. Netted + stateless enforced.
3. **Live wiring** — same file runs through `/api/strategy/evaluate`; verify
   netted gating, bracket attachment, and hedged-strategy refusal on the live
   path; live-panel selector.
4. **MTF ad-hoc** (`ctx.ema(9, tf="HOUR")`) — backend fetches + forward-fill-
   aligns HTF candles itself; parity suite extends to MTF + slope. Split out
   because base-TF is cheap (candles already available) but MTF needs backend
   fetch/align.

Phases 1–3 are the MVP; 4 is a fast-follow.

## Out of scope

- In-browser code editor / code storage (files on disk are the source of truth).
- Sandboxing (single-user local tool).
- Persisted cross-bar `ctx.state` (stateless-only in v1).
- TypeScript-authored strategies (Python only).
- Strategy parameters rendered as UI inputs (authors hardcode / edit the file).

## Reusable infrastructure (unchanged)

`BacktestEngine`, `Context`/`Signal`/`Trade`/`Fill`/`Candle` domain models, the
risk/scaling/masking math, and the `/api/strategy/evaluate` live path all work
as-is. Coded strategies plug into the existing `Strategy` seam.
