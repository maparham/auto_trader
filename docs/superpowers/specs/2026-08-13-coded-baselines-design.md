# Baselines for Coded Strategies — Design

**Date:** 2026-08-13
**Status:** Approved design, ready for implementation plan

## Problem

The baseline-comparison feature (spec
`2026-08-13-baseline-comparison-design.md`, merged) is expression-runs only.
Built-in (coded) strategies get no Baselines section, so the null-hypothesis
discipline stops working exactly where the strategy library is growing.

## Goal

Coded single backtests get the same Null + Hold baselines and the same
overview Baselines section. Scope: **plain backtests only**; coded
walk-forwards stay out (their worker pool is initialized for the coded
engine; separate design pass when needed).

## Key insight

A "same-structure null" IS synthesizable for coded runs: the structured
`BacktestRequest` carries every panel-level ingredient an expression run
needs — candles, `htfCandles`, `broker`/`priceSide`, costs, risk, scaling,
mask, enabled sides, `indicators`, and the panel exit rules already as
expressions (`exprLongExit`/`exprShortExit` + combine modes). Only logic
inside the strategy file (`on_bar` exits, dynamic sizing, code-internal
filters) cannot be mirrored.

So for coded runs:

- **Null** = `1==1` entries per enabled side + the panel's exit rules + panel
  risk/scaling/mask/costs. Answers "what do the coded entries add over
  always-in with the same panel scaffolding?" Weaker comparator when the
  strategy's exits live in code; the tooltip must say so.
- **Hold** = unchanged semantics, fully faithful (never depended on entries).

## Approach

**Convert, then reuse everything.**

1. New pure converter in `backend/auto_trader/api/baselines.py`:

```python
def expr_request_from_structured(req: BacktestRequest) -> ExprBacktestRequest
```

Maps: epic, resolution, candles, htfCandles, broker, priceSide,
`longEntry=[]`, `shortEntry=[]` (the null/hold synthesizers fill them),
`longExit=req.exprLongExit`, `shortExit=req.exprShortExit`, both exit
combine modes, enabled flags, risk, scaling, costs, tradeFromTime, mask,
indicators. `sweep`/`walkforward`/`baselines`/`progressId` never carried.
`series` is dropped (the expr pipeline computes its own ATR risk series).

2. The expr route's `_compiled_run` helper moves verbatim to a new shared
module `backend/auto_trader/api/expr_exec.py`, imported by both routers.
This avoids the circular import (expr.py already imports from
routers/backtest.py). Expr route behavior is unchanged by the move.

3. `BacktestRequest` gains the same optional field:

```python
baselines: list[Literal["null", "hold"]] | None = None
```

The structured single-run handler (`POST /api/backtest`), coded runs only
(`codedStrategy` set): after the main response is built, synthesize
`null_request(expr_request_from_structured(req))` / `hold_request(...)`, run
each via the shared `_compiled_run`, fill `response.baselines` with the same
`{"null": blob|None, "hold": blob|None}` shape. Baseline failures are logged
and swallowed (same contract as expr). Rules-mode structured requests (no
`codedStrategy`) ignore the field in this build — the frontend's rules mode
posts to the expr route anyway.

## Frontend

- `BacktestRequest` (frontend type) gains `baselines?`; `BacktestButton`'s
  coded branch sends `baselines: ["null", "hold"]` for single runs only
  (sweep/WFO branches unaffected; structured WFO continues to
  accept-and-ignore).
- Overview section renders as-is (response shape unchanged). One InfoTip
  sentence added, shown only for coded runs: "For Built-in strategies, the
  null baseline uses the panel's exits and risk; logic inside the strategy
  file is not mirrored." The panel learns coded-vs-rules from its caller
  (BacktestButton knows; pass a prop). Copy rules: no em dashes; no tooltip
  line opening with "How"/"Which".

## Cost

Two extra engine runs per coded single run (post-main, sequential),
identical to the expr path. Shallow-copy synthesis already in place.

## Testing

- Converter unit tests: field mapping (exits, combines, risk, scaling, mask,
  htf, broker/priceSide, indicators carried; entries empty; sweep/wfo/
  progressId/series dropped), input not mutated.
- Route test with the tests' tiny coded strategy fixture: `baselines`
  requested → both blobs present with `net_pnl`/`return_pct` keys; Null
  diverges from Hold when panel risk is set; omitted field → `baselines`
  None (backward compat); rules-mode structured request with the field →
  ignored, response None.
- Frontend: coded branch sends the field for single runs and not for
  sweeps/WFO; InfoTip sentence appears for coded runs only.

## Risks

- Panel exit rows referencing chart indicator instances must compile in the
  expr pipeline: the converter carries `indicators`, and `_ensure_htf`
  fetches any missing higher-timeframe candles (served by the sqlite candle
  cache). Covered by a converter test with an exit row naming an indicator
  output.
- A coded strategy with NO panel exits and NO panel risk makes Null == Hold
  (both enter-and-hold). That is correct, not a bug: the panel scaffolding
  is empty, so always-in IS the null. No special-casing.
