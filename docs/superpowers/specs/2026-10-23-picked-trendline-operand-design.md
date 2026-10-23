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
- A line belongs to one symbol (epic + broker) and one timeframe. On another
  symbol its value is absent everywhere. A rule set evaluated on a different
  timeframe than the line's is refused (422) naming the line's timeframe.
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
  tRef: number; pRef: number; // newest closed bar at pick time, value there
}
type Lines = Record<string, PickedLine>; // keys "L1", "L2", ...
```

Geometry comes from the hit segment's `alertLine()`
(`lib/indicators/trendlineMarks.ts` `alertLineOf`), the same capture line
alerts use. Picks are refused (toast) where `buildLineAlertDraft` refuses a
line: seconds and non-native timeframes, or no `alertLine`.

Ids are minted per rule holder: the lowest `L<n>` not already in its map.
Ids are refused by the parser's collision check if they clash with a catalog
name (none do today).

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

- Wanted set: every line in every holder above whose `epic`/`broker` match
  the cell. Drawn on any timeframe of that symbol (time-anchored points).
- Points via the same `loadedLinePoints` logic the alert line uses
  (extract it to a shared helper), cut at the chart's last bar.
- Locked `segment` overlay, id `pickline:<holder>:<id>`, dashed style
  distinct from the alert line, label `L1` at the right end.
- Reconciled from the paint loop like `refreshRays`, and when a holder's
  map changes.

## Backend

- Parser: a bare identifier matching `L<digits>` parses to
  `N.LineRef(id)`. An id missing from the request's `lines` is a compile
  error ("L3 is not one of this rule's lines").
- Requests: `lines` (optional) on `/api/expr/backtest`, sweep and
  walk-forward jobs, `/api/expr/series`, `/api/expr/closeness`,
  `/api/strategy/evaluate`, `/api/screens/run` and saved screens. Validated
  by one shared pydantic model.
- Evaluation (`strategy/expr/evaluate.py` `series_of`): if the evaluated
  symbol differs from the line's, every value is None. Otherwise find the
  index of `t2` in the candles; failing that, `tRef`. With anchor index `j`
  and anchor price `q`, value at bar k is `q + slope*(k-j)` for bars at or
  after t2, None before. If neither anchor is in the candles, all None and the
  result carries a warning (`line L1 is outside the loaded bars`).
- Timeframe mismatch between the rule set and a line: 422 at compile time.
- Screener: each symbol is judged with the same rule; only the line's own
  symbol can produce values.

## Testing

- pytest: value math (t2 anchor, tRef fallback, before-t2 None, other symbol
  None, outside-range warning), parser/compile errors, request validation and
  caps, timeframe 422.
- vitest (affected files only): pick result to `L<n>` token and map insert,
  id minting, `collectLineRefs` trimming, autocomplete entries, overlay
  wanted-set per cell.

## Out of scope

- Editing or dragging a picked line.
- Picking lines from drawings or other indicators.
- Rebasing `tRef` for long-armed live rules (the t2 anchor covers the normal
  window; revisit if the warning shows up in practice).
