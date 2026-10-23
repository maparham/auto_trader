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

`ScreenerPanel` gets an instance source like the backtest side panel:

- `App` passes the focused cell's `ChartController` (`focusedController`), as
  it already does for the backtest panel.
- Active-chart panes: `useExprInstances(controller)`
  (`backtestSettings/useExprPick.ts`) for the editor's `ExprInstance[]`, the
  same 1 s poll the backtest editors use, and `liveExprInstances(controller.chart)`
  for the `LiveInstance` payloads at Run/Save time.
- The panel keeps `indicators: Record<string, ExprInstancePayload>`, the
  screen's copy. It lives on `ScreenerDraftState`, `ScreenDraft` and `Screen`
  (`lib/screens.ts`); `load()` sets it from the saved screen, or `{}` for a
  new one.

### Copy semantics

The copy wins for every id it already holds. The chart only supplies ids the
copy lacks. So loading a saved screen and running it with a different chart
focused, one that has its own differently tuned `RSI`, still applies the
screen's `RSI`.

- "Refresh from chart" (a quiet link on the Indicators line) replaces every
  copied id the active chart also has with the chart's current settings. It
  is the only way a copied pane changes.
- Editor instances: `exprInstancesFor` over the copy (as `LiveInstance`s),
  plus the chart's `ExprInstance`s for ids the copy lacks. The merge is at the
  `ExprInstance` level; copy entries come first.
- Run and Save build one `LiveInstance[]` (copy entries, then chart panes for
  missing ids) and call `collectExprInstances(list, [condition, ...columns])`.
  That map is the request's `indicators` and the new copy, so the copy only
  holds panes the screen references. Run sends the map it just built, not a
  render-time draft object.
- `collectExprInstances` stamps the chart zone on calendar panes (PREV_HL,
  VWAP) only when they have no valid `tz`, so a copied pane keeps the zone it
  was copied with. That is intended: the copy is frozen.
- Panes whose settings pin a timeframe are left out of the editor list, so the
  editor flags them as unknown refs instead of accepting them and failing on
  Run.
- A referenced id found in neither is left to the server, which 422s on the
  right field.

### Pick from chart

- `useExprPick`'s arm/consume logic is split into a generic
  `useIndicatorPick(controller, onToken)`. The backtest keeps its current
  wrapper (row targeting into `BacktestConfig`); its existing tests pass
  unchanged.
- Both hooks can be mounted at once and both subscribe to the one
  `indicatorPickResult`. Each ignores a result while its own target is
  unarmed, and arming one disarms the other through `indicatorPickArmed`,
  so a single chart click inserts once.
- The condition and each column get the backtest's `◎` toggle (same class,
  tooltip text and aria-label). One field is armed at a time; closing the
  panel disarms. A pane with no expression equivalent gives the backtest's
  toast. Columns stay plain inputs: the token is appended to the input's
  value. They get no client-side lint; the server reports column errors as
  today.

### Indicators line

Under Condition, a line lists the copied panes ("RSI · length 14 · pivots 5/5 ·
divergence on", the id plus the pane's editor detail) and
the "Refresh from chart" link. It is hidden when the screen references none.
InfoTip lines: "Settings copied from the chart on run or save." / "The copy is
kept with the screen." / "Refresh from chart to pick up changes."

## Backend

- `ScreenRunBody` gains `indicators: dict[str, IndicatorInstanceDTO] = {}`:
  at most 16 entries and at most 32 KB of JSON in total, and every entry's
  type must have a series spec. An unregistered type would be silently
  skipped by `resolve_instances` and stored dead, so it 422s instead.
  `ScreenBody` inherits all of it.
- `compile_screen(expression, columns, indicators)` resolves them with
  `resolve_instances`, passes `instances=` to `validate` and
  `validate_value`, and stores the map on `CompiledScreen`. Warm-up uses
  `warmup_bars(node, None, instances)`.
- `_refuse_unsupported` passes the instances to `referenced_tfs`, which already
  catches panes pinned in their settings. The message depends on the cause:
  "Timeframe pins like @D are not available in screens yet." for an `@tf`, and
  "<id> is pinned to <tf> in its settings. Screens run on one timeframe, so
  unpin it on the chart." for a pinned pane. Unknown refs get a screen-specific
  message rather than validate's "on this chart": "<id> is not one of this
  screen's indicators. Add it to a chart and pick it from there." The module
  docstring drops "pane references are refused".
- `judge` passes the instances to `compile_row` and `series_of`.
- Compute bounds: the broker semaphore covers only the fetch, so judging gets
  its own per-runner semaphore of 2. The job's cancel flag is checked before
  each judge, so a cancelled screen stops after the symbols already running
  in threads.
- Store: `indicators TEXT NOT NULL DEFAULT '{}'`. The `ALTER TABLE ... ADD
  COLUMN` runs once, guarded by `PRAGMA table_info`, in the same schema step
  `_connect` already runs. `INSERT` names its columns rather than relying on
  position; `UPDATE`, `_COLS`, `_row` and the router's `_data()` all carry
  `indicators`.

## Results versus the chart

Results can differ from the chart. The spec accepts this, and the panel
InfoTip on Condition says it in one line ("Pivot-based outputs see up to 2000
bars, so they can differ from the chart.").

- Pivot- and history-dependent outputs (Trendlines, S/R, divergences) see only
  the bars a screen fetches, 300 to 2000. A chart with more history can show a
  different line or pivot.
- A warm-up above 1999 bars skips every symbol with "not enough history".
- A pane's settings are applied at the screen's timeframe, even if they were
  tuned on another.

## Errors

- Unknown reference, wrong output name, pinned timeframe, unregistered type,
  size cap: 422 with the existing `{code, message, start, end, field, index}`
  detail, shown on the expression or the named column.
- Too few bars for the instance's warm-up: the existing "not enough history"
  skip reason.

## Testing

- Backend: `compile_screen` with an RSI instance and `RSI.bullDiv`; warm-up
  grows with the divergence lookback; pinned pane refused with its own
  message; unknown id 422s on the right field with the screen wording;
  unregistered type and size cap 422; store round-trips `indicators` and
  migrates an old table; router passes indicators through to the job;
  cancel stops further judging.
- Frontend: picking from the chart appends the token to the armed field and
  disarms; arming a second field replaces the first; the backtest's pick
  behaves as before (its existing tests pass unchanged). With both
  hooks mounted, one click inserts once. Run sends only referenced panes; the
  copy wins over a chart pane with the same id; the chart supplies ids the
  copy lacks; Refresh from chart updates shared ids; pinned panes are absent
  from the editor list; loading a saved screen restores its copy; the draft
  keeps it across unmount.

## Out of scope

- Timeframe-pinned instances and `@tf` pins in screens.
- Editing a copied pane's settings inside the screener.

## Follow-ups shipped 2026-10-22/23

- Saved screens store `source` (`list` or `allTabs`); loading an All-tabs
  screen restores it. "Some tabs" is saved as the list it resolved to.
- Picking an RSI pane with divergence on opens a small menu at the click
  point (`components/PickChoiceHost.tsx`) offering each enabled divergence
  kind and the value line. It serves the backtest editor and the screener.
