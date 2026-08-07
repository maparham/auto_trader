# ATR chart-pane indicator with rule-referenceable instances — design

Date: 2026-08-07
Status: approved (brainstormed with user)

## Goal

Add an ATR (Average True Range) indicator matching TradingView's, as a chart
sub-pane the user adds from the indicator menu, with a settings modal offering
**Length** (default 14) and **Smoothing** (RMA default / SMA / EMA / WMA), and
expose pane instances to the backtest rule engine as instance references
(`ATR#a1b2.14`) that honor the pane's smoothing.

TradingView reference: `ma_function(ta.tr(true), length)` where `ma_function`
switches over RMA/SMA/EMA/WMA. Plot color `#B71C1C`, separate pane
(`overlay=false`).

## Already exists — do not touch

`ATR(length)` already works as a rule-expression *function* (Wilder/RMA only):

- Backend math: `backend/auto_trader/indicators/core.py` `atr_series`
- Expr registry: `backend/auto_trader/strategy/expr/registry.py` `"ATR"`
- Eval dispatch: `strategy/expr/evaluate.py::_indicator_raw`
- Frontend catalog: `frontend/src/lib/expr/catalog.ts`
- Frontend math: `frontend/src/lib/atr.ts` `atrSeries`
- Parity: `backend/tests/test_indicator_parity.py::test_atr` vs `ATR_14` golden

Out of scope / untouched: `expr/registry.py` INDICATORS, `expr/catalog.ts`,
`evaluate.py::_indicator_raw`, `grammar.lezer`, `persist/defaults.ts`.
Plain `ATR(n)` in expressions stays RMA; pane smoothing travels only through
instance refs.

Not included (explicit user decision): **no Timeframe/MTF input** — the pane
computes on the chart timeframe only, like our RSI pane. Rules can still pin
timeframes via `@4H` on plain `ATR(n)`. MTF pane support can be added later.

## Design

### 1. Frontend pane

- New `frontend/src/lib/indicators/atr.ts` exporting `ATR_TEMPLATE`:
  - Sub-pane (`series: 'normal'`, **not** added to `OVERLAY_INDICATORS`).
  - Single line, color `#B71C1C` (TV's ATR red).
  - `calcParams: [14]`; `extendData: { smoothing: "rma" }` (pattern:
    `MaExtend` in `lib/indicators/ma.ts`).
- Smoothing math: generalize `frontend/src/lib/atr.ts` to
  `atrSeries(candles, length, smoothing = "rma")` over
  `"rma" | "sma" | "ema" | "wma"` of the true-range series. The RMA path stays
  operation-for-operation identical to today (parity contract). WMA is
  currently private inside `lib/indicators/rsi.ts`; promote a shared helper
  rather than duplicating.
- `frontend/src/lib/customIndicators.ts`: `export *` from `./indicators/atr`,
  add to `CustomIndicatorType` union and `BASE_TEMPLATES`. Menu
  (`Toolbar.tsx`), settings modal, and persistence pick the new type up
  automatically.
- `frontend/src/lib/indicatorMeta.ts`: `ATR` entry —
  `inputs: [num(0, "Length"), <Smoothing select, source: "extend">]`,
  `title: "Average True Range"`, desc for the menu tooltip. The generic
  Inputs tab renders it; no dedicated settings panel.

### 2. Backend instance refs (`ATR#id.<length>`)

- Smoothing-aware math in `backend/auto_trader/indicators/core.py`: the RMA
  branch delegates to the existing `atr_series` unchanged ("do NOT improve
  the arithmetic"); SMA/EMA/WMA smooth the same true-range series, ported
  operation-for-operation from the frontend.
- New `backend/auto_trader/indicators/atr.py` with the five
  `IndicatorSeriesSpec` callables (model: `indicators/slope.py`):
  `parse_atr_config(calcParams, extendData)`, `atr_outputs` (single output
  named by length, like SLOPE, so refs read `ATR#a1b2.14`), `atr_series`,
  `atr_warmup` (= length, matching the expr-level convention),
  `timeframe → None`.
- One entry in `SERIES_INDICATORS` (`backend/auto_trader/indicators/registry.py`).
  Per the registry contract, no expression-layer edits are needed.
- Frontend `frontend/src/lib/exprInstances.ts`: ATR branch so the expression
  editor offers pane instances and `collectExprInstances` builds the request's
  `indicators` map. Keep the file klinecharts-free (type-only imports).

### 3. Tests

- Frontend unit: `frontend/src/lib/indicators/atr.test.ts` — smoothing
  variants, warmup nulls, config parsing.
- Parity: extend `frontend/src/lib/indicatorParityGolden.test.ts` to emit
  `ATR_14_sma` / `ATR_14_ema` / `ATR_14_wma` rows (existing `ATR_14` stays the
  RMA row); regenerate `backend/tests/fixtures/indicator_golden.json`; add
  matching assertions in `backend/tests/test_indicator_parity.py`.
- Backend registry: `backend/tests/test_atr_indicator.py` for the
  `IndicatorSeriesSpec` callables (model: `test_slope_indicator.py`).
- Cross-stack corpus: new `frontend/src/lib/expr/corpus.json` cases carrying
  an ATR instance in `instances` — both hand-written parser stacks (Python +
  TS) run them automatically.
- Known baseline: frontend tests have 5–7 pre-existing failures on main;
  those are not touched and not "fixed".

## Error handling

- `parse_atr_config` follows `parse_slope_config`'s defensive posture:
  malformed calcParams/extendData fall back to defaults (length 14, RMA)
  rather than raising — `resolve_instances` must not 500 on chart state.
- Unknown smoothing strings fall back to RMA on both sides, identically.
