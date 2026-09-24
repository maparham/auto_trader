# TRENDLINES: nearest first selection

Date: 2026-09-24. Amends the stage 3 order of
`2026-09-23-trendlines-three-stage-selection-design.md`. Stages 1 and 2, the
live cap and the calcParams layout are unchanged.

## Summary

Stage 3 walks the stage 2 survivors in `rankLines` order: most touches, then
longest span, then fewest crossings. Touches come first, so an old 5-touch
line far from price outranks a fresh 2-touch line at price. Since the live cap
became a fixed 256 (2026-09-23), those old lines stay alive, and panes with
Max Distance off now draw them. Measured on the last bar at defaults, the
drawn line nearest the close sits 8.0 ATR away on DXY (was 1.7), 8.8 on TSLA
(was 1.0) and 4.3 on KBH (was 0.0).

The owner's decision (2026-09-24): lines closer to the last price get
priority. Stage 3 walks the survivors NEAREST FIRST.

## The order

On bar `i` with close `c`, the stage 3 order is:

1. Distance to the close, ascending: `|projectAt(line, i) - c|`.
2. Ties: `rankLines` (touches, span, crossings, recency, origin, anchor price).

Strength keys only break exact distance ties. Line quality is the filters'
job (Min Touches, Min Span, Min Crossings, the ceilings); ranking no longer
trades it off against distance.

No balancing between sides: the N nearest lines are drawn even when all of
them sit on one side of the close (owner's pick, 2026-09-24).

## What follows from it

Everything else in stage 3 keeps its rule and simply sees the new order.

- **Merge:** a level's leader is its NEAREST gate-passing member.
- **Max Per Pivot:** at a shared pivot, the nearest levels keep their places.
- **Max Trendlines:** the N nearest levels are drawn.
- **Early stop:** still exact. Positions are fixed at insertion and depend
  only on the walk order, whatever that order is.
- **Operands:** `tl_1` is the nearest drawn line, `tl_N` the farthest. The
  order is by distance, so a rule reading `tl_1` reads "the nearest line".
  `tl_nearest` now always equals `tl_1`. It stays, so saved rules keep
  working.
- **Pins:** unchanged. They take no part in stage 3 and draw in addition.

## What does not change

- The live cap keeps `compareSurvival` and stays price-free. Eviction is
  permanent, and a line far from price now can be at price later; a price
  based eviction is what emptied every pane on long history the first time
  Max Distance pruned.
- Stage 1 and stage 2 filters, the merge tolerance, the touch model.
- `rankLines` itself: it remains the tie-break and the documented strength
  order.

## Code

TS (`frontend/src/lib/indicators/trendlines.ts`) and Python
(`backend/auto_trader/indicators/trendlines.py`) together, value-identical.

- `selectDrawnLines`: after the stage 2 filter, sort by distance at `atIdx`
  to `close` (today `close` is `void`ed), ties by `rankLines`. Compute each
  projection once per line per bar, not inside the comparator.
- Python emit step: same key, `(abs(project_at(line, i) - close), rank_key(line))`.
  Both ports compute the distance with the same float operations, so ties
  break identically.
- The pinned result (`[...out].sort(rankLines)` today) sorts by the same
  nearest first key.
- Max Trendlines tip:
  ["Most lines drawn at once, nearest to price first.",
  "Ties go to the stronger line: more touches, then longer.",
  "Filters run first, so a hidden line never takes a slot.",
  "Each drawn line is a rule operand (tl_1 .. tl_N), nearest first."]
- Docstrings that describe stage 3 as strength order are rewritten.

## Behaviour that changes on purpose

- Default panes draw the lines near price; old strong lines far away give up
  their slots.
- Operand order changes from strength to distance, so saved backtests re-run
  with different numbers.
- A level's anchors can change bar to bar as its nearest member changes.
- The KBH 2020-03-19 line competes for Max Per Pivot places by distance
  (about 1.3 below the close), so its current test expectations are
  re-measured.
- On an MTF pane with Wait on, the draw path orders by the chart's newest
  close while the emit step orders by the closed higher-timeframe close, so
  the drawn lines and tl_1..tl_N can differ there. With Wait off the two
  closes nearly coincide, so the drawn and emitted orders nearly match too.
- On a forming bar, a moving close can swap which line holds the last slot,
  and which member leads a merged level, within the bar.

## Tests

- Nearest first: with three survivors that do not merge, the drawn order is
  by distance, and a far 5-touch line loses the last slot to a near 2-touch
  line.
- Tie: two lines at the same distance draw in `rankLines` order.
- Merge: a level led by a far member hands leadership to its nearer member.
- The early stop exactness test keeps passing with the new order (it feeds
  `selectLevels` directly, so it gains a nearest first ordered variant).
- `tl_nearest === tl_1` on every emitted bar of the DXY fixture.
- DXY default pane: `tl_nearest` back within a few ATR of the close; the
  pinned 120.875 and the 1998-10 anchor expectations are re-measured.
- DXY/TSLA/EURUSD/KBH acceptance values re-measured and dated; every
  hand-drawn line still built.
- Parity golden regenerated; Python parity bit for bit.
- Benchmark stays within 50 ms TSLA / 250 ms KBH.

## Non-goals

- Price-aware live-cap eviction.
- Side balancing, distance bands or a weighted score.
- A new setting.
