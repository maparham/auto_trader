# TRENDLINES: Extend Left

Date: 2026-09-24. Adds one setting to the detector. Stage order, the touch
model, nearest first selection and the live cap are unchanged.

## Summary

A line starts at its first anchor, the older of the two pivots that define
it. Often price respected the same line earlier, but the detector never
looks there, so a line a trader would draw from an older swing starts later
on the chart.

Reported case, EURUSD daily (capital-live), the Trendlines(1D) pane at
`[8,0,2,20,100,50,2,0,40,0,0,0.3,-0.3,0,0,0,2,0.5,0,0,1,1,3,0,12,10,3]`: the
owner's drawing starts at the 2024-11-29 high (1.0597). The detector builds
the same line from the 2025-03-26 low to the 2026-07-28 low (within 0.15 ATR
of the drawing over its whole length) but cannot start it earlier: the
2024-11-29 high is 66 pivots before the 2026-07-28 low at Pivot Length 5
(Pair Pivots tops out at 40), and it is not a major pivot.

The line is old resistance turned support. Walking left from 2025-03-26, the
close first crosses it on 2025-03-05 (walking left, 2025-03-04 is the last
close under it; price sat under it from December to February), then the
2024-12-06 high touches it (pivot length 15, pierced by 0.45 ATR, 94 bars
back), then the 2024-11-29 high (pivot length 5, pierced by 0.15 ATR).

## The setting

**Extend Left**, calcParams slot 28, `cfg.extendLeft`, 0 = off (default),
1 = on. Off gives output identical to today, so saved panes and backtests do
not change until a user turns it on.

## The rule (owner's picks, 2026-09-24)

"Go through the break, while respecting filter settings like crossings."

When a line is seeded, after the slope and back clearance checks and only
when Extend Left is on:

1. Look at the pool pivots before the first anchor, newest first (pool
   positions `q - 1, q - 2, ...`, either kind, the pane's own Pivot Length
   and Min Swing). Skip an entry AT `i1` (the other extreme of the anchor
   bar), as the retro touches do.
2. Stop looking once a pivot is more than Max Projection bars before `i1`
   (`i1 - idx > maxProjBars`, the same reach a line has to the right of its
   last touch), before the data start, or past the Lookback edge for the
   current bar (`!withinLookback(idx, i, cfg)`).
3. The first pivot the touch model counts (`touchWeight > 0`, the same gap
   and pierce tolerances, ATR at that pivot) is the new START, `i0`. Only
   that one: the line reaches back to the NEAREST earlier swing it touches.
   With none, nothing changes.
4. Closes between the new start and the anchor may cross the line. Those
   crossings count: the crossing walk runs over `(i0, i]` instead of
   `(i1, i]`.
5. Filters are respected: the extended line is checked against the
   ceilings (`overCeilings`: Max Crossings, Max Span, Max Touches, the touch
   spacing limits). If it fails one, the line is kept UNEXTENDED instead, so
   turning Extend Left on never removes a line at birth.
6. The same check runs on every bar for the rest of the line's life
   (`shortenIfBroken` / `shorten_if_broken`, owner's pick 2026-09-24): after
   the per-bar crossing step, and again after the bar's touches before the
   prune and the live cap. An extended line that now fails a ceiling, or
   whose earlier start has aged past Lookback, drops back for good to the
   line Extend Left off would have built: start at `i1`, the start touch
   taken out, crossings walked again over `(i1, i]`, gaps recomputed. That
   line is then an ordinary one, silenced like any other if it fails a
   filter too.

Only bars before the current one are read, so the rule never repaints, and
it runs once per line.

## The line keeps its geometry

The anchors `(i1, p1, i2, p2)` do not move: `projectAt`, `sideSign`,
`touchWeight` and the slope checks keep their arithmetic, so the line's
value on every bar is bit for bit what it was. A new field carries the
start:

- `i0`: the start bar. Absent, or equal to `i1`, when not extended. Readers
  use a helper, `lineStart(line) = line.i0 ?? line.i1` (Python
  `line_start`), because MTF stashes persisted before this field existed
  restore without it.

On extension: `i0` is set, the start pivot is added to `touches`,
`touchIdxs` and `touchKinds` (like a retro touch), the touch gaps are
recomputed, and `crossings`, `crossIdxs` and `lastSign` come from the walk
over `(i0, i]`.

Uses of `i1` split by meaning:

- **Geometry and identity, keep `i1`:** projection, side, touch weight,
  slope, back clearance, the rank and survival tie-break on origin, pin
  identity (`lineKey`, the anchor timestamps), line intersections,
  `drawnPivotIdxs` (the start is in `touchIdxs`, so it is covered).
- **Start, move to `lineStart`:** span in `rankLines`, `compareSurvival`,
  `overCeilings` (Max Span) and `isMajor` (`lastTouchIdx - start`), the
  Lookback age in `isLive` and `isMajor`, the visible range in `isMajor`
  (`i >= start`), the drawn segment's left end (and the "extended" mode's
  left reach), the left point of the "To drawing" clone, the overlap start
  in `sameTrend`.

## What changes on purpose (when on)

- Lines get longer and gain a touch, so more lines pass Min Touches, Min
  Span and Min Crossings, and fewer pass Max Span and Lookback later on.
- Crossings before the old anchor now count, so an extended line can reach
  Max Crossings sooner and be pruned later in its life.
- Rank shifts: an extended line has more touches and a longer span.
- `tl_1..tl_N` values are unchanged per line, but which lines are drawn can
  change, so backtests re-run with different numbers.
- EURUSD case: the 2025-03-26 to 2026-07-28 line starts at 2024-12-06, gains
  one touch, and its crossings go from 1 to 2 (the 2025-03-05 break), which
  the pane's Max Crossings 2 still allows. It never reaches 2024-11-29: the
  line touches 2024-12-06 first.
- A crossing later in life can break Max Crossings for the extended line
  only; it then drops back to the short line. At Max Crossings 1 the
  owner's EURUSD line starts at 2024-12-06 until 2026-09-23, then at
  2025-03-26 with 1 crossing, and stays drawn.

## Code

TS (`frontend/src/lib/indicators/trendlines.ts`, `trendlinesOutputs.ts`) and
Python (`backend/auto_trader/indicators/trendlines.py`) together,
value-identical.

- Config: `extendLeft` (0/1) in `TrendlinesConfig`, `TRENDLINES_DEFAULTS`
  (0), both parsers (slot 28, `zeroInt` clamped to 1).
- `TrendLine.i0?` (TS optional) / `i0: int | None = None` (Python).
- Seed step: the rule above, inside the seed loop, in both ports in the
  same order.
- The start-meaning uses listed above switch to `lineStart`.
- Settings UI (`indicatorMeta.ts`): a toggle after Lookback. Tip:
  ["Starts each line at the nearest earlier swing it touched.",
  "The line keeps its angle; that swing counts as a touch.",
  "Breaks on the way count as crossings.",
  "Drops back to the shorter line if the longer one fails a filter."]
- The Pine script (`tradingview/trendlines.pine`) is out of scope.

## Performance

The pivot scan is bounded by Max Projection bars of pool entries; the extra
crossing walk is at most Max Projection bars per extended line; the
fallback repeats the crossing walk only for lines the extension pushed over
a ceiling. Budget stays TSLA 50 ms and KBH 250 ms per full recompute with
Extend Left ON at defaults; with it off the cost is one branch per seed.

## Tests

- EURUSD daily fixture (committed next to the others, 2022-09-05 onward,
  the bars the chart loads) with the pane above plus Extend Left on: the
  2025-03-26 to 2026-07-28 line has start 2024-12-06, one more touch than
  with it off, crossings 2, and the same value at the last bar.
- Filters respected: at a Max Span one bar above the unextended span, the
  line stays unextended (start 2025-03-26) and is still built. At Max
  Crossings 1 it is extended until 2026-09-23 and afterwards equals the
  line Extend Left off builds, still major on the last bar.
- Fallback: a shortened line equals the unextended line exactly (touches,
  touchIdxs, crossings, gaps); Lookback aging triggers it too; a line that
  was never extended is returned untouched.
- Nearest only: with two touching pivots to the left, the start is the
  nearer.
- Reach: a touching pivot more than Max Projection bars back is not used;
  Lookback bounds it too.
- No touch, no change: `lineStart(line) === line.i1`.
- Off is identity: every existing fixture and the parity golden are
  byte-identical with the slot absent or 0.
- A stashed line without `i0` reads its start as `i1`.
- Parity golden gains an Extend Left case; Python matches bit for bit.
- Benchmarks as above.

## Non-goals

- Extending right, or re-anchoring (the line never rotates).
- Reaching past the nearest touched swing.
- Pine script parity.
