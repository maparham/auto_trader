# Picked trendlines as rule operands

## Goal

Let the user pick ONE specific trendline on the chart and use it in a rule.
Today a pick on a Trendlines line inserts `TRENDLINES.tl_1`, and `tl_k` is a
per-bar rank (the k-th nearest drawn line to the close), not a line. The
autocomplete lists `tl_1..tl_50` with identical details, so there is no way to
tell which line a ref means.

A pick now freezes the clicked line into the rule as `L1`, `L2`, ... A dashed
clone of it stays on the chart for as long as a rule uses it, the way a line
alert's dashed line outlives its trendline.

## Decisions

- A picked line is FROZEN: anchors, slope and timeframe are captured at pick
  time and never follow the indicator's re-detection.
- Its value starts at its 2nd anchor (t2) and extends right forever. Bars
  before t2 have no value.
- Usable in backtest rules, live trading rules and the screener.
- A line belongs to one symbol (epic + broker). On another symbol its value is
  absent everywhere.
- A line is implicitly pinned to its own timeframe: it is evaluated on that
  timeframe's bars and aligned onto the rule's bars, like an HTF-pinned pane.
  A rule on a COARSER timeframe than the line is refused (422).
- Lines live as rule data (a `lines` map next to the rule text), not as chart
  drawings: a drawing could be dragged or deleted and silently change or break
  the rule.
- The `tl_k` / `tl_nearest` operands stay as they are.

## Data

```ts
interface PickedLine {
  epic: string;
  broker: string;
  timeframe: string;      // native resolution of the line's series
  t1: number; p1: number; // anchor 1, bar-open ms + price
  t2: number; p2: number; // anchor 2
  slope: number;          // price per bar of `timeframe`
  tRef: number; pRef: number; // a bar-open ms on `timeframe` and the line's value there
}
type Lines = Record<string, PickedLine>; // keys "L1", "L2", ...
```

Geometry comes from the hit segment's `alertLine()`
(`lib/indicators/trendlineMarks.ts` `alertLineOf`), the same capture line
alerts use. Picks are refused (toast) where `buildLineAlertDraft` refuses a
line: seconds and non-native timeframes, or no `alertLine`.

`tRef`/`pRef` is a moving reference (see Rebasing); the anchors and slope never
change.

Ids are minted per rule holder: the lowest `L<n>` not already in its map.
`L<digits>` is RESERVED for picked lines: `mintInstanceId` never produces it,
and pane rename validation (`indicators.ts`, the typed-candidate check)
refuses it with "L1 is reserved for picked lines". A pane already saved under
such a name is not migrated; the parser resolves the bare `L<n>` to the line
and a dotted `L<n>.out` to the pane, so it keeps working.

Caps on every request: at most 16 lines, finite numbers, `t2 > t1`, known
timeframe; else 422.

## Frontend

### Pick

- `ChartCore` click handler: on a trendline hit while
  `indicatorPickArmed`, publish the hit segment's frozen line on
  `indicatorPickResult` (new optional `line: PickedLine` field) instead of
  discarding it. A legend-row click (no line) keeps today's behaviour.
- `useIndicatorPick` / `exprPick.ts`: a result carrying `line` produces the
  token `L<n>` and hands the line to the owner, which adds it to its `lines`
  map. `exprChartToken.ts` is untouched for that case.

### Holders

Each place that keeps rule text keeps a `lines` map beside it:

- Backtest config (global last-used config, `persist/defaults.ts`).
- Live armed snapshot (`liveEngine.ts`, per epic + account).
- Saved screens and the screener's working state (`ScreenerPanel`,
  `lib/screenerIndicators.ts`).

On Run, Arm and Save, the map is trimmed to the ids the text references
(`collectLineRefs(rows)`), mirroring how `collectExprInstances` sends only
referenced panes. Deleting `L1` from the text therefore drops it.

### Autocomplete

`lib/expr/complete.ts` offers each id in the holder's map with detail
`line · <epic> · <tf>` in a "Picked lines" section.

### Clone drawing

New overlay manager `lib/overlays/pickedLines.ts`, modelled on
`overlays/indicatorAlerts.ts`:

- Sources: the backtest config, every armed live snapshot, and the screen
  currently open in the screener panel (working state). Saved screens that
  are not open do NOT draw, so old screens never clutter charts.
- Wanted set: every line from those sources whose `epic`/`broker` match the
  cell, on any timeframe of that symbol (time-anchored points).
- Dedupe by geometry (`timeframe`, anchors, slope): the same line held as `L1`
  in the backtest and `L2` in a screen draws once, labelled `L1 · L2`.
- Points via the same `loadedLinePoints` logic the alert line uses
  (extract it to a shared helper), cut at the chart's last bar.
- Locked `segment` overlay, id `pickline:<geometry hash>`, dashed style
  distinct from the alert line, label at the right end.
- Reconciled from the paint loop like `refreshRays`, and when a source
  changes.

### Rebasing in the live engine

The live engine holds a rolling 1500-bar window (`liveEngine.ts`). On each
cycle, while `tRef` is still inside the window and more than 500 bars old,
move it to the newest closed bar (`pRef += slope * n`, `n` = bars between) and
write the line back into the armed snapshot. The line then never leaves the
window however long the rule stays armed. Only lines whose timeframe equals
the engine's resolution are rebased this way; a pinned (finer-timeframe) line
relies on the server rebase below.

## Backend

- Parser: a bare identifier matching `L<digits>` parses to
  `N.LineRef(id)`. An id missing from the request's `lines` is a compile
  error ("L3 is not one of this rule's lines").
- Requests: `lines` (optional) on `/api/expr/backtest`, sweep and
  walk-forward jobs, `/api/expr/series`, `/api/expr/closeness` (including the
  proximity heatmap, `useProximityHeatmap.ts`), `/api/strategy/evaluate`,
  `/api/screens/run` and saved screens. Validated by one shared pydantic
  model.
- Evaluation (`strategy/expr/evaluate.py` `series_of`), on the line's own
  timeframe bars (fetched and aligned like an HTF-pinned pane when the rule's
  timeframe is finer):
  - Other symbol: every value is None.
  - Anchor: the first candle at or after `t2` (bisect, not exact match, so a
    candle gap or a broker's shifted bar times still find it), anchor price
    `p2`. Failing that, the first candle at or after `tRef`, price `pRef`.
  - Value at bar k: `q + slope*(k-j)` for bars at or after t2, None before.
- Server rebase: when neither anchor is inside the candles but `tRef` is older
  than the first candle, count the bars between them with `bars_since` (the
  helper line alerts use for their rescue, `alert_indicators.py`) and anchor at
  the first candle with `pRef + slope*n`. Only when that fetch fails does the
  line become all None, with a warning in the result (`line L1 could not be
  placed on the loaded bars`). This covers screens and backtests run long
  after the pick.
- Timeframe: a rule whose timeframe is coarser than a line's is a 422 at
  compile time naming the line's timeframe. The screener, which refuses pins,
  also refuses a line on a different timeframe than the screen's.
- Screener: each symbol is judged with the same rule; only the line's own
  symbol can produce values.
- Walk-forward needs nothing extra: it runs the full range once and slices
  the results, so anchors stay inside the candles.

## Testing

- pytest: value math (t2 bisect anchor, tRef fallback, before-t2 None, other
  symbol None), server rebase via a stubbed `bars_since` (and its failure
  warning), finer-timeframe alignment, coarser-timeframe 422, screener
  timeframe 422, parser/compile errors, request validation and caps.
- vitest (affected files only): pick result to `L<n>` token and map insert,
  id minting, reserved-name rename refusal, `collectLineRefs` trimming,
  autocomplete entries, overlay wanted-set and geometry dedupe, live-engine
  rebase.

## Out of scope

- Editing or dragging a picked line.
- Picking lines from drawings or other indicators.
- Drawing clones for saved screens that are not open.
