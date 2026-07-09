# Strategy panel parameters — design

Date: 2026-07-09
Status: approved

## Goal

Coded Python strategies (`backend/strategies/*.py`, shipped in 33e7ef0) hardcode
their tunable values — EMA lengths, RSI thresholds, SL/TP percentages. This
feature moves tuning into the app:

1. **Panel params** — a strategy declares its knobs; the Strategy tab renders
   controls for them; values flow into backtest AND live without editing the file.
2. **Panel risk & exits** — the `.py` file keeps only the core signal logic
   (entries + exits intrinsic to the idea); SL/TP and exit management become
   panel-configured, reusing the engine `RiskConfig` UI and the rule-builder's
   exit conditions that rule strategies already have.
3. **Sweeps** — mark 1–2 numeric values (strategy params or risk numbers) as
   axes, run the grid server-side, compare combos in a table + heatmap, click
   a combo to apply and render it.

## 1. Param declaration & runtime

Strategy files declare knobs in `meta["params"]`:

```python
meta = {
    "name": "EMA Cross + RSI",
    "params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int", "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "rsi_max",  "label": "RSI ceiling", "type": "float", "default": 70, "min": 0, "max": 100},
        {"name": "longs_only", "label": "Longs only", "type": "bool", "default": True},
    ],
}

def on_bar(ctx):
    f = ctx.param("ema_fast")
    ...
```

- Types: `int`, `float`, `bool`, `choice` (requires `options: [...]`).
  `label`, `min`, `max`, `step`, `help` are optional; UI clamps when present.
- `GET /api/strategies` returns the validated schema per file. The loader
  already execs each file; `_describe` picks up and validates `meta["params"]`
  (shape, types, unique names, min ≤ default ≤ max). A bad schema surfaces in
  the file's `error` field like any other load failure.
- `ctx.param(name)`: panel-sent value if present, else the declared default.
  Unknown name → `StrategyRuntimeError` naming it and listing declared params.
- `/api/backtest` and `/api/strategy/evaluate` gain
  `codedParams: dict[str, int|float|bool|str] | None` next to `codedStrategy`.
  Values are validated/coerced against the schema backend-side (422 on
  mismatch, naming the param). `CodedStrategy.__init__` takes the resolved
  params dict; live sends the same dict every cycle — backtest/live parity by
  construction.

## 2. Panel UI — params

In the backtest panel's Strategy tab, below the `StrategyPicker` dropdown +
description, a **Parameters** section renders one control per declared param:

- `int`/`float` → numeric stepper (clamped to min/max, step honored);
  `bool` → the app's toggle; `choice` → the app's select. Label from `label`
  (fallback `name`); `help` renders as an `InfoTip`.
- Each control shows its default subtly ("default 9"); a modified value gets a
  "changed" tint; one **Reset all** link restores defaults.
- No `params` in the file → no section. Broken schema → the picker's existing
  broken-file state.
**Backtest and live value sets are separate.** Sharing one value set would let
backtest fiddling silently change a running live trade (drag Fast EMA 9 → 8 in
the backtest panel and an armed live strategy starts trading on 8). Instead,
each strategy filename has **two independent persisted sets** — backtest and
live — covering the whole coded config: params, risk, and exit groups.

- The backtest panel edits the backtest set only.
- The live panel shows and edits the live set (same controls), plus a
  **Copy from backtest** button that pulls the backtest set over in one
  deliberate action. Arming and every live cycle use the live set only.
- When the two sets differ, the live panel shows a subtle "differs from
  backtest" hint so drift is visible.

**Persistence**: both sets persist per strategy filename via the existing
persist layer, synced (not device-local). Switching strategies swaps the value
sets. Removed params drop their stored values; new params get defaults;
renamed params' stale values simply don't apply.

## 3. Risk & exits — reuse rule-strategy panel sections

When mode = Strategy (coded), the panel also shows the two exit surfaces rule
strategies already have:

- **Risk section** (existing `RiskConfig` UI): per-side stop/target —
  `pct` / `price` / `atr` / `trailPct` / `trailAtr`. Sent as
  `longRisk`/`shortRisk` exactly as rule runs do. The backtest route already
  forwards these to `BacktestEngine` for coded runs (`backtest.py`); the
  frontend just never sends them in coded mode today, so this is mostly
  unhiding the section and wiring values through.
- **Exit-rules section** (existing rule-builder, exit groups only): full
  condition composability — `entryPrice` operands, `crosses`, MTF `@TF`
  operands, Nth-occurrence counting. Entry groups stay hidden (entries come
  from the `.py` file). Coded runs currently send empty rule groups; now exit
  groups ride along and the engine evaluates them alongside the coded
  strategy's own close actions — whichever fires first exits, same as multiple
  exit rules today.

**Precedence** (decided): if the panel has risk configured for a side, the
engine applies it and the file's per-signal `sl=`/`tp=` on that side are
**ignored**. The panel shows a small note when the loaded file passes brackets
that are being overridden — never silent. With the panel risk section
off/`none`, file brackets behave exactly as today (per-signal, never
ratcheted).

**Series for exits**: exit-rule operands need `buildSeries`-style series, which
coded runs skip. The frontend builds series only for operands the exit rules
reference (existing rule→series machinery, scoped to exit groups) and sends
them. ATR-based risk kinds already declare their series via
`atr_series_names()`.

**Live parity**: the live evaluate path already applies rule exits and broker
brackets for rule strategies; coded mode sends the same `longRisk`/`shortRisk`
+ exit groups so live behaves like the backtest.

## 4. Parameter sweeps

**Marking axes.** Each numeric strategy param and each numeric risk field
(stop pct value, ATR mult, target values) gets a sweep toggle. Toggling swaps
the single input for **from / to / step** inputs. At most 2 axes at once —
toggling a third un-toggles the oldest. A combo counter shows
`12 × 9 = 108 runs`, capped at ~200 combos total (Run disabled over cap, count
in red). The backend caps combos per request (~50) with a 422 — the frontend's
~20-combo chunks stay well under it.

**Execution — backend sweep loop, chunked requests.** The backtest request
gains an optional `sweep` block listing explicit combos:

```json
"sweep": {"combos": [
  {"param:ema_fast": 5, "risk:long.stop.value": 1.0},
  {"param:ema_fast": 5, "risk:long.stop.value": 1.5},
  ...
]}
```

The **frontend enumerates the full grid** from the axes' from/to/step, splits
it into **chunks of ~20 combos**, and sends them as sequential requests. A
single 200-combo request could sit open for minutes and die on a client or
gateway timeout, losing everything; chunking keeps every request short and
gives a real progress bar (chunks done / total), partial results as chunks
land, retry of a failed chunk without losing the rest, and Cancel between
chunks. Cost: the candle array re-uploads per chunk (~10 uploads for a max
sweep — acceptable).

Per chunk the backend parses candles once, then loops its combos: rebuild
`CodedStrategy` with that combo's params (and a patched `RiskConfig` for risk
axes), run `BacktestEngine`. HTF candles fetched via the existing
`NeedTimeframe` retry loop are shared across the chunk's combos, and the
backend candle cache makes repeat HTF fetches across chunks cheap. Response:
one row per combo — axis values + headline metrics (net P/L, win rate, trade
count, max drawdown, profit factor) — no trade lists, which keeps responses
small.

Rationale for backend-loop-per-chunk over one-request-per-combo: 20× fewer
uploads and HTTP round-trips, HTF sharing within a chunk, while staying well
inside any timeout. A background-job queue is YAGNI at this scale.

**Results UI** in the Strategy tab:

- **Table** — one row per combo, sortable by any metric column; best row per
  metric subtly highlighted.
- **Heatmap** — 2 axes → grid colored by a selectable metric (default net
  P/L), diverging scale around 0. 1 axis → a bar/line strip.
- **Clicking a row/cell** applies that combo to the panel controls (params +
  risk values) and re-runs a normal single backtest, rendering trades/equity
  on the chart via the existing path. "Apply this combo" is therefore just
  what clicking does.

Sweep results are session-state only (not persisted) — re-running is cheap,
and the applied combo persists via normal param persistence.

## 5. Errors & edge cases

- Bad `meta["params"]` schema → file listed with `error`; picker shows it
  broken (existing pattern).
- Panel value fails backend validation → 422 naming the param; panel shows it
  inline on the offending control.
- `ctx.param("typo")` → `StrategyRuntimeError` naming the unknown param and
  listing declared ones.
- One combo raises mid-sweep → that row carries an `error` field instead of
  metrics; the chunk continues. Failed rows render greyed with the message on
  hover.
- A whole chunk request fails (network, 5xx) → one automatic retry, then the
  sweep reports the failed chunk and keeps the results already landed.
- File edited between runs → removed params' values dropped, new params get
  defaults.

## 6. Testing

- **Backend**: schema validation cases; `ctx.param` resolution (panel value /
  default / unknown); coded run with `longRisk` overriding file brackets
  (file `sl=` ignored, override flag returned); exit rules firing on a coded
  run; sweep endpoint — combos run against shared HTF fetch (one fetch for N
  combos), per-combo error isolation, per-request combo-cap 422.
- **Frontend**: param controls render per type + clamp; backtest vs live value
  sets stay independent (edit one, other unchanged) + Copy-from-backtest;
  sweep toggle → from/to/step + combo counter + cap; grid enumeration +
  chunking (progress, partial results, cancel between chunks, failed-chunk
  retry); table sort; heatmap cell click applies the combo and triggers a run
  through the existing runAndRender path.
- **Parity**: live evaluate with `codedParams` returns the same signal as the
  backtest at the same bar (extend the existing coded parity tests).
