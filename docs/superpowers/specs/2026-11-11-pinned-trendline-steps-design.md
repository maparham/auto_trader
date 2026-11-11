# Pinned trendlines drawn as steps on finer charts

## Why

A Trendlines line pinned to a coarser timeframe (a 1D pin viewed on a 4H or
1H chart) reads a different price at the last candle on every timeframe.
Since cc240409 the stroke is drawn straight in CHART bars through the two
candles that traded the anchor extremes (`pinnedAnchorBars`). Those candles
sit at different offsets inside their HTF bars on each timeframe, and HTF bars
do not hold a constant number of chart candles, so the per-candle slope, and
with it every price right of the second anchor, depends on the chart
timeframe. The demo `docs/superpowers/mockups/pinned-line-drift.html` shows
the effect: one daily line reads 114.00 on 1D, 114.67 on 4H, 115.64 on 1H.

The owner's requirement: a pinned trendline shows the same price on every
timeframe, and a finer candle crosses it at the same price the HTF bar that
contains it does. The owner compared three renderings in the demo (straight
in chart bars, straight in clock time, one step per HTF bar) and chose the
steps.

## Decision (owner's)

Under a COARSER pin, the line is drawn as one horizontal step per HTF bar:
across all chart candles that belong to HTF bar `j`, at the line's own value
for that bar, `projectAt(line, j)`. At the next HTF bar it jumps to the next
value. This REPLACES the straight anchor-candle stroke outright; there is no
setting to get the old stroke back.

## Goals

- Same price at any moment on every chart timeframe, equal to the pin's own
  projection for the HTF bar that moment falls in.
- Anchors stay exact: the step of HTF bar `i1` is `p1`, the pivot's price, so
  it passes through the anchor wick on every timeframe (same for `i2`, `p2`).
- What is drawn is what line alerts fire on (see Alerts).

## Non-goals

- No change to same-timeframe pins, finer pins, or unpinned Trendlines.
- No change to detection, selection, emitted values (`tl_k`,
  `tl_nearest`), the backend, or backtest parity.
- No change to how operands align onto chart bars (`alignMtfTrendlines`
  keeps its closed-bar rule; an operand on a chart candle still reads the
  last CLOSED HTF bar's value, one HTF bar behind the step drawn over it).

## Anti-goals

- A step rendering that disagrees with itself across timeframes (rounding of
  HTF bar boundaries must come from the data, not nominal durations).
- Perf regressions: a 1D pin on a 1m chart must not walk thousands of steps
  per draw.

## The candle to HTF bar map (the core of the change)

Today's coarser-pin `toChart` maps in CALENDAR time off the ends of the
pin's series (`trendlineIdxMap`, `countBars` is false for coarser pins), so
it cannot place steps: on a Monday the first future daily bar maps to
Saturday, and future daily steps come out ~24 hourly candles wide on a stock
that trades ~7. The steps therefore need their own map, built from the data,
once per draw frame and shared by every line, the alert staircases and the
debug layer:

- **History**: chart candle `c` belongs to HTF bar `j` when
  `starts[j] <= t_c < starts[j + 1]` (containment by open time, not by a
  nominal bar end). A candle that straddles a boundary (DST moving a broker's
  daily open off fixed-hour candles, a Sunday-evening FX candle before a
  00:00 daily start) belongs to the bar its OPEN is in. Inside such a candle
  the "same price at every moment" goal cannot hold; that is accepted.
- **Forming bar**: Trendlines never folds a forming bar into its stash
  (`formingIdx` is unset for it), so the forming HTF bar is defined as
  `lastIdx + 1`: every chart candle after the last closed HTF bar's candles.
  If the newest candle is two or more HTF bars past the last start (a stale
  stash), candles past the first missing bar are split into further bars by
  the future rule below rather than all painted at `lastIdx + 1`.
- **Future and before the first start**: step widths in chart candles reuse
  the `countBars` estimate the finer-pin path already computes (candles per
  pin bar, from recent fully covered bars), so a future daily step on a
  stock's 1H chart is ~7 candles wide.

## Scope of the change

Everything that today draws or freezes a coarser-pinned line through its
anchor candles moves to the steps:

1. **Stroke** (`trendlines.ts` draw loop, the `anchorBars` / `endY` path).
   Step `j` spans from the left edge of HTF bar `j`'s first candle to the
   right edge of its last candle, by the map above, at `projectAt(line, j)`,
   joined by vertical risers so it reads as one line. Width, dash, colour,
   alpha, highlight and selection glow as today.
2. **Left end**: wherever `lineExtent` starts the line today (`lineStart`,
   which is `i0` under Extend Left, further back in "extended"), converted
   to the step that contains it.
3. **Right end**: unchanged extent rules (`lineExtent`, extend modes). A
   fractional right end (cross meetings, the double-click edge) ends the
   last step at the exact x of that fraction inside its HTF bar, so a
   meeting still ends where the lines meet. One addition (my call): a mode
   whose line already runs to `lastIdx` gets one more step for the forming
   HTF bar (`lastIdx + 1`), at `projectAt(line, lastIdx + 1)`, ending at
   the newest candle. This holds with "Wait for timeframe closes" on or off;
   it adds no data, only the line's own projection, and it is the level a
   live line alert on the pin's timeframe compares price with. Modes that
   stop before `lastIdx` are unchanged.
4. **Future** (ray, extended, the double-click dashed extension): steps
   continue per HTF bar with widths from the map's future rule.
5. **Touch rings**: on the candle that traded the touch's extreme
   (`htfExtremeSnap`, as today), at that HTF bar's step value.
6. **Crossing marks**: the marked candle must actually cross ITS OWN step
   (its close on the other side of the step of the HTF bar it belongs to,
   versus the previous candle against ITS step). A riser between two
   candles is not a crossing by itself. The next-bar slack in
   `crossingChartIdx` existed for the straight stroke and goes.
7. **End tags / notes**: at the newest candle on the forming step for lines
   that reach it (item 3), otherwise at the line's drawn end on the step
   there. Tags show touches, crossings and rank, not a price, so they do not
   contradict `tl_nearest` (see "Drawn vs read").
8. **Hit testing** (`TrendlineSegment`, `findTrendlineSegment`,
   `hitTrendline` on every pointer move): the segment carries its step list
   (x ranges and y per step, on-pane part only). A hit looks up the step
   under the pointer's x and measures the vertical distance to it (and to a
   riser when the pointer is at a boundary); no minimum over every piece.
   `x0..y1` stay as the overall ends.
9. **Clone to drawing**: a drawing tool cannot be a staircase. The clone is
   straight, from the line's drawn start to its drawn end, at the step
   values there (segment mode keeps ending at its last step, not at the
   newest candle). (My call.)
10. **Line alerts from a coarser pin**: `chartLine` is removed, so
    `lineGate` falls through to `alertLine`: the alert is created on the
    PIN's timeframe, in its bars, and fires on the step value. Alerts
    already created in chart frame are untouched and keep drawing and
    firing as they do (they live on the chart's own timeframe).
    Owner's decision: pins on timeframes alerts cannot run on yet (2H, 2D,
    3D, monthly; anything outside `NATIVE` in `lib/timeframe.ts`) lose
    "set alert" on their lines until that timeframe gets alert support,
    showing the existing "Alerts on this timeframe are coming later"
    refusal. They do NOT fall back to a chart-timeframe alert, because that
    would fire on a straight line that does not match the steps drawn.
    `chart/lineAlertDraft.test.ts`'s chart-frame case is rewritten to
    assert the refusal.
11. **Pin-timeframe line alerts drawn on a finer chart**
    (`indicatorAlerts.ts`): today a two-point klinecharts `"segment"`
    overlay (`RayPoints` is a 2-tuple) placed by `pinnedAlertStroke`. Under
    a coarser pin it becomes a staircase, through a custom overlay or a
    canvas paint (builder's choice), from the alert's first anchor to the
    newest candle. The step helper takes the alert's own geometry
    (`tRef`, `pRef`, `slope`, with the existing `loadedLinePoints` fallback
    chain tRef, then t2, then t1, since the backend rebase moves tRef), not
    a `TrendLine`. The bell (`useChartPaint.ts`, today extrapolated straight
    through the ray's two points) sits on the forming step, horizontally.
    `pinnedAlertStroke` is removed. Existing CHART-frame alerts (made before
    this change) keep their straight dashed line; it will now visibly leave
    the stepped stroke, which is accepted. `lineAlertShown` keeps its
    chart-resolution branch so they stay drawn.
12. **Picked-line clones** (`pickedLineClones.ts`): OUT of this change, a
    follow-up (my call). A clone has no HTF bar boundaries of its own (no
    `mtf`/`htfStarts`, only the chart's candles), and placing steps needs the
    line's own-timeframe bars counted the way the backend counts them. The
    follow-up decides between fetching those bars and borrowing a pinned
    pane's `htfStarts`. Clones keep drawing as today.
13. **Debug layer** (`trendlinesDebugDraw.ts`): today it draws candidates on
    the plain HTF projection (`xAt`), not through anchor candles. If it moves
    to steps, its clone (`pointsFor`) and hit segments move too. Builder
    decides whether that is this change or a follow-up, and says which.

One shared helper should produce the step geometry (HTF index ranges to
chart x ranges, value per step) for 1, 11 and 13 (and later 12), so they cannot drift
apart.

## Drawn vs read

Three values exist for a coarser-pinned line on a chart candle in the
forming HTF bar, and the spec keeps them as they are:

- **Drawn step**: `projectAt(line, lastIdx + 1)`, the line's own value for
  the bar the candle is in.
- **Line alert on the pin's timeframe**: the same value. The backend `line`
  kind projects to the current bar of its timeframe. This parity assumes
  the backend's bar count since `tRef` (`bars_since` in
  `core/alert_engine.py`) matches `htfStarts`; both come from the same
  broker's bars of that timeframe.
- **Operands, `tl_k` / `tl_nearest`, Max Distance and the drawn-set
  selection**: measured at `lastIdx`, the last CLOSED HTF bar, as today
  (`alignMtfTrendlines`, `selectDrawnLines`). "One gate for both surfaces"
  still holds for WHICH lines are drawn; only the forming step's height is
  one bar ahead of what an operand reads. Accepted (my call): the forming
  step is geometry, the operand is a closed-bar value with no lookahead.

## Performance

The costly case is a pin barely coarser than the chart (a 4H pin on a 1H
chart zoomed out: ~1250 steps per line, times Max Trendlines, every
crosshair paint), not a 1D pin on 1m. So: build the candle to HTF map once
per frame and share it; build only steps in the visible range; merge
consecutive steps whose risers are under a pixel into one stroke piece; hit
tests by x lookup (item 8).

## Removed

`pinnedAnchorBars`, `pinnedEndY` (if no other caller remains),
`pinnedAlertStroke`, `TrendlineSegment.chartLine` and `lineGate`'s
`chartFrame` branch, with their tests rewritten for the steps. The comments
that describe the TradingView-style stroke go with them, including
`trendlines.ts`'s note on coarser pins in `trendlineIdxMap` and
`indicatorAlertInstance.ts`'s chart-frame note (reworded, since its branch
stays for old alerts).

## Tests

- Step value at every chart candle equals `projectAt(line, j)` for the HTF
  bar `j` containing it, on 1D-pin-on-4H and 1D-pin-on-1H data, including a
  short session (the TSLA and EURUSD fixtures already cover real sessions).
- The same moment reads the same price on two chart timeframes of the same
  data.
- Anchor steps equal `p1` / `p2`.
- Forming bar step, with Wait on and off: present for modes reaching
  `lastIdx`, ending at the newest candle; absent for segment stops.
- A 2D or monthly pin refuses a line alert.
- Hit test lands on a step and misses between risers' gaps.
- A Monday on a stock's 1H chart with a 1D pin: the forming step is that
  day's candles at `projectAt(lastIdx + 1)`, and the next future step is
  ~7 candles wide, not ~24.
- A DST week with a broker whose daily open moves: candles assigned by open
  time, no empty or doubled step.
- A crossing mark needs a close across the candle's own step; a riser alone
  makes none.
- A 4H pin on a zoomed-out 1H chart stays within the paint budget.
- Line alert from a coarser pin is created on the pin's timeframe.
- Culling: a 1D ray on 1m data builds only on-screen steps.

Run only the affected test files (never the full frontend suite).

## Left to the builder

Pixel snapping of risers, whether risers are drawn at all at very small
steps (sub-pixel jumps), how the polyline is stored on the segment, and file
organisation of the shared helper.
