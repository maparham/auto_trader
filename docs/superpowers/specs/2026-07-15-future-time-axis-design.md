# Future timestamps on the chart time axis

Date: 2026-07-15

## Goal

Show projected future timestamps on the chart's time (x) axis in the blank
area to the right of the last candle, TradingView-style. Today klinecharts
stops the axis at the last real bar, so the ~80px default right gap (and any
larger gap the user scrolls into, e.g. where a drawing extends into the
future) has no tick labels. The crosshair time label is also blank there.

## Behavior (confirmed)

- Extent: the **whole blank right area** always gets projected ticks, whenever
  there is empty space right of the last candle. Not tied to drawings; a
  drawing extending into the future is automatically covered because the
  labeled zone already spans the blank area.
- Projection: **simple** `lastBarTime + N * barMillis`. On daily/weekly charts
  this can land labels on weekends/holidays; accepted. No trading-calendar
  logic on the frontend.
- Crosshair: hovering the blank future area shows the **projected** time in the
  crosshair's bottom label, consistent with the axis ticks.
- Empty chart (no data): unchanged (nothing to project from).

## Approach

Extend the existing `patch-package` patch on
`frontend/patches/klinecharts+9.8.12.patch` (same mechanism already used for the
`_scalePriceOnly` y-axis behavior and the weak-magnet fix). Three edits to
`node_modules/klinecharts/dist/index.esm.js`:

### 1. `XAxisImp.calcRange` — let tick candidates run past the last bar

Currently:

```js
XAxisImp.prototype.calcRange = function () {
    var chartStore = this.getParent().getChart().getChartStore();
    var _a = chartStore.getTimeScaleStore().getVisibleRange(), from = _a.from, to = _a.to;
    var af = from;
    var at = to - 1;                 // clamped to last real bar
    var range = to - from;
    return { from: af, to: at, range: range,
             realFrom: af, realTo: at, realRange: range };
};
```

`getVisibleRange()` already computes an unclamped `realTo` (the store throws it
away for tick purposes). Use it for the `real*` fields so `_calcTicks`
generates dataIndex positions into the blank area, while the clamped `to`/`range`
stay as-is (nothing downstream that must not overrun uses `realTo` except tick
building, which we handle next):

```js
var realTo = _a.realTo;
var at = to - 1;
var realAt = Math.max(at, realTo - 1);
return { from: af, to: at, range: to - from,
         realFrom: af, realTo: realAt, realRange: realAt - af };
```

### 2. `XAxisImp.optimalTicks` — project timestamps for positions past the last bar

`_calcTicks` now yields tick positions (dataIndex values as strings) that may be
`> lastIndex`. `optimalTicks` reads `dataList[pos].timestamp` directly, which
would be `undefined` for those positions and crash. Replace the direct reads
with a small helper:

- `lastIndex = dataList.length - 1`, `lastTs = dataList[lastIndex].timestamp`.
- `barMillis` = median of the deltas between the last ~20 consecutive bars'
  timestamps (median so a weekend/holiday gap on daily charts does not skew the
  step). Computed once per `optimalTicks` call.
- `tsAt(pos)`: `pos <= lastIndex ? dataList[pos].timestamp
  : lastTs + (pos - lastIndex) * barMillis`.

Swap the two `dataList[...]​.timestamp` reads (`kLineData`/`timestamp` and
`prevKLineData`/`prevTimestamp`) to use `tsAt(pos)`. Everything else in
`optimalTicks` (label-width thinning, `_optimalTickLabel` day/month/year
rollover formatting) already operates purely on timestamps and is unchanged.

### 3. Crosshair vertical label — projected time in the future zone

`CrosshairVerticalLabelView`:

```js
compare(crosshair) {
    return isValid(crosshair.kLineData) && crosshair.dataIndex === crosshair.realDataIndex;
}
getText(crosshair, chartStore) {
    var timestamp = crosshair.kLineData?.timestamp;
    return chartStore.getCustomApi().formatDate(..., timestamp, 'YYYY-MM-DD HH:mm', ...);
}
```

In the future zone the store clamps `dataIndex` to `lastIndex` while
`realDataIndex > dataIndex`, so `compare` currently returns false (label
hidden) and `kLineData` is the last bar. Change:

- `compare`: `isValid(crosshair.kLineData) && crosshair.realDataIndex >= crosshair.dataIndex`
  (allows the future zone where `realDataIndex > dataIndex`; still hides the
  left/past zone where `realDataIndex < 0 <= dataIndex`).
- `getText`: when `realDataIndex > dataIndex`, project
  `kLineData.timestamp + (realDataIndex - dataIndex) * barMillis` (same median
  step, computed from `dataList`); otherwise use `kLineData.timestamp` as
  before.

The crosshair's `kLineData` stays clamped to the last real bar, so the tooltip,
indicator values, and drawing snap logic are all untouched. Only the bottom
time label changes.

## Non-goals

- No trading-calendar / weekend-skipping projection.
- No change to tooltip, indicator last-value labels, or overlay behavior.
- No app-code changes: this lives entirely in the klinecharts patch, so it
  applies uniformly to every chart cell with no per-cell wiring.

## Testing / verification

1. Regenerate the patch: `cd frontend && npx patch-package klinecharts`, confirm
   `patches/klinecharts+9.8.12.patch` now includes the three hunks and
   `postinstall` re-applies cleanly.
2. In the running app (light theme), on an intraday chart (e.g. 15m):
   - Confirm the default right gap now shows continuing time ticks.
   - Scroll right into a larger blank area; ticks keep going with correct
     hour/day rollover labels.
   - Hover the blank area; crosshair bottom label shows a projected time that
     lines up with the ticks.
3. On a daily chart: confirm future ticks appear (weekend dates acceptable) and
   labels roll over to MM-DD / YYYY correctly.
4. Confirm a drawing (e.g. a trend line) extended into the future sits under
   labeled axis positions.
5. Vitest: run the frontend unit suite to confirm the klinecharts mock stubs
   (`registerYAxis`, etc.) and any axis-touching tests still pass.

## Risk notes

- `realTo` unclamped is already bounded by klinecharts' right-scroll limit
  (`rightMinVisibleBarCount` / `maxOffsetRightDistance`), so tick generation
  cannot run away.
- `barMillis` median guards against a single large gap (weekend) at the dataset
  tail producing a wrong step.
- Patch is against the pinned version `klinecharts@9.8.12`; a version bump would
  require re-basing all hunks (already true for the existing patch).
