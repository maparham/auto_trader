# TRENDLINES: three-stage selection, Max Trendlines caps visible lines

Date: 2026-09-23. Amends the selection pipeline of
`2026-09-16-sideless-trendlines-design.md`. Detection, touch counting, ranking
keys and the calcParams layout are unchanged.

## Summary

Max Trendlines (calcParams[5], `cfg.maxLines`) was meant to be the number of
lines on screen. Over time it became a cap on CANDIDATES: the pool is cut to
the top N by rank first, and Max Distance, the floors, merging and Max Per
Pivot run afterwards on whatever is left. A pane set to 50 routinely shows 6.

Worse, the cut lets lines that could never be drawn push out lines that
would. Reported case, KBH daily (capital-live, 2005 onward), pane params
`[7,0,2,10,P,50,2,0,40,0,0,0.15,-0.15,0,0,0,6,0.2,20,0,20,0,3,3,440,9,3,0]`:

| | Max Projection 100 | Max Projection 300 |
|---|---|---|
| poolable lines at the last bar | 72 | 246 |
| rank of the 2020-03-19 low to 2026-05-19 low line | 16 | 67 |
| in the top 50 | yes, drawn | no, cut |

Of the 66 lines ranked ahead of it at 300, 56 fail Max Distance (20%) and
are never drawn; they only occupy slots. Raising Max Projection made a good
line disappear, and Max Trendlines is already at its ceiling of 50.

This change reorders selection into three stages, by what each filter looks
at, so Max Trendlines becomes the last step and means "at most N lines drawn".

## The three stages

**Stage 1: pivots.** Which swings may anchor or touch a line. Unchanged:
Pivot Length, Min Swing (ATR), Min Swing Reach, Pair Pivots, the MAJOR tier
(Major Pivots, Major Length, Major Size), Lookback.

**Stage 2: each line on its own.** Every filter that decides about ONE line
without looking at any other line. A line that fails any of them takes no part
in stage 3 on that bar.

- Seed-time (already delete on seeding, unchanged): Max/Min Slope, Min Back
  Bars clearance.
- Permanent (fail once, fail forever; pruned from live state): Max Projection,
  Lookback age, the ceilings (Max Touches, Max Span, Max/Min Touch Spacing,
  Max Crossings).
- Per bar (may fail now and pass later; hidden on that bar, kept live): Max
  Distance (ATR and %), the floors (Min Touches, Min Span, Min Crossings).

The split between permanent and per bar is an implementation detail: both are
stage 2, both run BEFORE ranking, and neither can be displaced by another line.
Per-bar filters must not delete, because the detector walks history and a line
far from price in 2022 can be at price in 2024 (the first Max Distance cut
pruned and emptied every pane on long history).

**Stage 3: lines against each other, in rank order.** Only on the stage 2
survivors, in this order:

1. Sort by `rankLines` (touches, span, crossings, as today).
2. Merge into levels at the merge tolerance; the best-ranked member leads.
3. Max Per Pivot, counted over the surviving leaders (as today).
4. Cut to Max Trendlines.

The result is the drawn set and, unchanged in principle, the emitted set:
`tl_1 .. tl_N` are the drawn lines in rank order, `tl_nearest` the nearest of
them.

Pins take no part in stage 3. Only gate-passing lines are grouped; pins are
appended after the cut. A pin that fails the gate therefore cannot lead a level
and swallow a member the emit step (which knows nothing of pins) would emit, so
"drawn minus pins equals emitted" holds.

**Stage 3 can stop early and stay exact.** Walk the gate-passing lines in rank
order; each joins the first level whose leader it matches or starts a new one.
A new leader's per-pivot position is fixed when it is inserted and depends only
on better-ranked leaders, and a later line can only join a level or start a
later one. So once Max Trendlines leaders have been accepted, nothing further
down can change the result: stop. Leaders dropped by the per-pivot cap still
take their positions but do not count toward Max Trendlines. The full walk runs
only when the debug pivot depths are requested.

## What changes in code

TS (`frontend/src/lib/indicators/trendlines.ts`) and Python
(`backend/auto_trader/indicators/trendlines.py`) together, parity kept.

- `selectDrawnLines` / `select_levels` path: filter by the stage 2 gate
  (`trendlineGate` plus `poolable`) first, then rank, merge, per-pivot, and
  cut to `maxLines` LAST. `poolLines` stops cutting before the merge; it
  becomes rank-sort (plus pins), and the cut moves to the end of
  `selectLevels`.
- The live-state cap in the scan (step 3 of `stepTrendlinesBar`, today
  `MAX_LIVE_MULT * cfg.maxLines`) no longer depends on Max Trendlines. It
  becomes a fixed budget `MAX_LIVE = 256` (mirrored in Python), still evicting
  by `compareSurvival` with ceiling-failed lines last. Otherwise a small Max
  Trendlines would still starve discovery. 256 is the owner's pick
  (2026-09-23): it keeps the DXY acceptance line (needs 224), costs about 2.5x
  a default pane (live cap 48 today) and is about 4x cheaper than a pane at
  Max Trendlines 50 (live cap 800 today).
- Max Trendlines tip rewritten: the most lines drawn, strongest first; each is
  a rule operand. The "filters this pool, so the chart often shows fewer" and
  "can swap lines" lines go. `MAX_MAX_LINES` stays 50 (it bounds operand count,
  which is still one per slot).

## Behaviour that changes on purpose

- More lines drawn on the same settings: a pane shows up to Max Trendlines
  lines instead of whatever survived a 50-candidate cut.
- Rule operands shift accordingly, so saved backtests re-run with different
  numbers. Expected, not a regression; note it in the commit.
- RELAXING A FILTER CAN NOW REMOVE A LINE. This reverses a documented choice:
  the pre-filter cut existed so that relaxing a filter could only hand lines
  back (measured on GOLD daily, relaxing Back Clearance used to lose 9 levels).
  Now relaxing any stage 2 filter admits lines that may outrank a visible one
  and push it past the Max Trendlines cut. That is what a cap on visible lines
  means; the old guarantee is given up on purpose.
- A LEVEL'S LEADER CAN CHANGE. Merging used to run before the gate, so a level
  whose leader failed Max Distance or a floor vanished. Now its best
  gate-passing member leads, so its anchors can move when those settings move.
  The per-pivot cap still never swaps a leader.

## Performance

Measured 2026-09-23 on the current code, full recompute, by live cap
(TSLA 1209 bars / KBH 5463 bars): 48: 15 / 93 ms, 128: 21 / 132 ms,
256: 39 / 194 ms, 512: 95 / 418 ms, 800: 164 / 868 ms. Those runs varied
Max Trendlines, so they are a proxy for the old emit path only.

Stage 3 now sees every stage 2 survivor, per bar, where it used to see at
most 50; the early stop above is what bounds it. Budget, measured on the NEW
code at MAX_LIVE 256 with default settings: TSLA at most 50 ms and KBH at most
250 ms per full recompute (the accepted ~2.5x over a default pane, plus
headroom). Over budget, look at the stage 3 walk first, not at reintroducing a
pre-merge cut.

## Tests

- KBH regression (fixture committed next to the existing ones): the
  2020-03-19 low line is drawn (a) at Max Projection 100 with the params
  above, and (b) at Max Projection 300 with Max Per Pivot off, which the
  pre-change pipeline failed (rank 68 of 245, outside the top-50 cut). (c) At
  300 with the exact params it is NOT drawn, and with Max Per Pivot 6 it is.
  The per-pivot finding: at 300, five better-ranked levels touch 2026-05-19,
  so Max Per Pivot 6 is the smallest cap that draws the line. Three of those
  five reach that touch only because of the longer projection (at 100 they
  die first, and only two sit ahead, inside Max Per Pivot 3), so dropping the
  line at 300 is correct stage 3 behaviour.
  Superseded 2026-09-24 by nearest first
  (`2026-09-24-trendlines-nearest-first-selection-design.md`): stage 3 walks
  by distance, the line is the nearest level at 2026-05-19, and at 300 it is
  drawn with the exact params and with Max Per Pivot 1.
- Max Trendlines is a visible cap: with more than N stage 2 survivors that do
  not merge, exactly N are drawn; with fewer, all are drawn.
- A line failing Max Distance never displaces one that passes, whatever its
  rank.
- Live cap independent of Max Trendlines: a line kept at Max Trendlines 50
  is still live (and drawn when it ranks first) at Max Trendlines 1.
- Existing goldens re-cut where the new order changes output, with each
  changed golden explained in the commit; TS/Python parity goldens pass bit
  for bit.
- The drawn set equals the emitted set on the last bar (existing invariant).
- A pinned line that fails the gate does not absorb a gate-passing twin: the
  twin draws and emits, the pin draws in addition.
- The early stop is exact: for random pools, the early-stopped selection
  equals the full walk cut to Max Trendlines.

## Non-goals

- Changing the rank keys, merge tolerance, touch model or pivot detection.
- Re-cutting calcParams or migrating saved panes (slot meanings are kept).
- Namespacing or re-sizing the operand list beyond the existing ceiling.
