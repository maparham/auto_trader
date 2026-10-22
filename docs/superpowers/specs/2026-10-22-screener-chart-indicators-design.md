# Screener: chart indicators in screens

## Goal

A screen's condition and columns can reference an indicator configured on a
chart, with its full settings (`RSI.bullDiv`, `TRENDLINES.tl_nearest`,
`SR_LEVELS.support`), exactly as backtest rules already do. The backend
computes that indicator on every screened symbol with those settings. No chart
is changed: a symbol whose chart lacks the indicator is still screened with it.

Motivating case: "find every chart with an RSI bullish divergence", using the
divergence tuning the user set on one chart.

## Decisions

- Backend only applies the indicator. Nothing is added to any chart.
- The screen holds a COPY of each referenced pane's settings. Editing the chart
  later does not change a saved screen; a saved screen keeps working after
  that chart is closed.
- Same model as the backtest editor: the editor offers the active chart's
  panes, a "pick from chart" toggle inserts a clicked pane's token, and
  Run/Save capture the panes the text references. No separate import step.

## Frontend

`ScreenerPanel` gets an `instances` source like the backtest side panel:

- `App` passes the focused cell's `ChartController` (`focusedController`), as
  it already does for the backtest panel.
- Active-chart panes come from `useExprInstances(controller)`
  (`backtestSettings/useExprPick.ts`), the same 1 s poll the backtest editors
  use, plus `liveExprInstances(controller.chart)` for the payloads.
- Pick from chart: the arm/consume logic in `useExprPick` is split into a
  generic `useIndicatorPick(controller, onToken)` hook; the backtest keeps
  its current wrapper (row targeting into `BacktestConfig`), the screener
  calls the generic hook with "append to the armed field". The condition and
  each column get the backtest's `◎` toggle (same class, tooltip text and
  aria-label), one armed field at a time, disarmed on panel close. A clicked
  pane with no expression equivalent gives the backtest's toast.
- The panel keeps `indicators: Record<string, ExprInstancePayload>`, the
  screen's own copy (in the draft store and in saved screens).
- Editor instances (lint + completion) = `exprInstancesFor` over the copy
  merged with the chart panes. For an id present in both, the chart pane wins,
  so the editor shows what Run will capture.
- Run and Save compute the payload with `collectExprInstances` over the
  condition and every column expression, taking each referenced id from the
  focused chart if it is there, else from the copy. The result replaces the
  copy, so the copy only ever holds panes the screen references.
- A referenced id found in neither is left to the server, which 422s with the
  usual unknown-reference message on the right field.
- Column expressions get the same instances for lint (they are plain inputs
  today; they stay plain inputs, the server reports errors as now).
- An "Indicators" line under Condition lists the copied panes ("RSI 14,
  divergence on") so the user can see what the screen will apply; empty when
  the screen references none. InfoTip: "Settings copied from the chart when
  you run or save. Change them on the chart, then run again."

## Backend

- `ScreenRunBody` gains `indicators: dict[str, IndicatorInstanceDTO] = {}`,
  capped at 16 entries. `ScreenBody` inherits it.
- `compile_screen(expression, columns, indicators)` resolves them with
  `resolve_instances`, validates the row and columns against them, and stores
  the resolved map on `CompiledScreen`. Warm-up uses
  `warmup_bars(node, None, instances)`, so a Trendlines or divergence lookback
  sizes the fetch.
- An instance whose settings pin a timeframe (`spec.timeframe(config)`) is
  refused at compile time, the same as `@tf` pins, with code
  `screen_tf_unsupported`.
- `judge` passes the instances to `compile_row` and `series_of`.
- Heavy types (Trendlines runs its full compute) are judged in the existing
  `asyncio.to_thread` call, so they do not block the loop. The per-broker
  semaphore of 4 already bounds concurrency.
- `screen_store` adds an `indicators TEXT NOT NULL DEFAULT '{}'` column through
  a migration (`ALTER TABLE` when the column is missing); rows read back with
  `{}` when empty.

## Errors

- Unknown reference, wrong output name, pinned timeframe: 422 with the existing
  `{code, message, start, end, field, index}` detail, shown on the expression
  or the named column.
- Too few bars for the instance's warm-up: the existing "not enough history"
  skip reason.

## Testing

- Backend: `compile_screen` with an RSI instance and `RSI.bullDiv`; warm-up
  grows with the divergence lookback; pinned-timeframe instance refused;
  unknown id 422s on the right field; store round-trips `indicators` and
  migrates an old table; router passes indicators through to the job.
- Frontend: picking from the chart appends the token to the armed field and
  disarms; arming a second field replaces the first; the backtest's pick
  behaves as before (its existing tests pass unchanged). Run sends only
  referenced panes; chart pane wins over the copy;
  copy is used when the chart lacks the id; loading a saved screen restores
  its copy; draft keeps it across unmount.

## Out of scope

- Timeframe-pinned instances and `@tf` pins in screens.
- Editing a copied pane's settings inside the screener.
- Remembering "All tabs" on saved screens.
