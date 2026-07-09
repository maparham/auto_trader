# Position line declutter — entry-anchored segments

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan

## Problem

Every open position draws a full-width dashed line at its entry price, plus
full-width SL/TP lines and a bracket spine. With several open positions at
nearby prices (see NG short cluster: three entries within ~0.5), the chart
body is washed out by overlapping horizontal lines. The left-side pills are
fine; the clutter is the lines.

## Design

### Resting state

- **Entry line**: drawn from the left chart edge (behind its pill, as today)
  only up to the x of the **entry candle** — the position's entry timestamp
  snapped to the current timeframe's bar (same timestamp→bar mapping used by
  trade markers / signal carets). Everything right of the entry bar — the
  live price action — stays clean, and the clean region grows as new bars
  form and the entry drifts left.
- **Entry end marker**: a small filled dot in the line's color at the entry
  bar's x, centered on the line, so the truncation reads as intentional
  ("line ends where I got in").
- **SL / TP lines**: a stub only — from the left edge to the right edge of
  their pill. No chart-body ink at rest.
- **Bracket spine** (entry↔SL/TP split-color spine + badges): hidden at rest.
- **Pending order lines** (limit orders): unchanged — full-width at rest.
  They represent live intent being watched against price.

### Emphasis (full reveal)

All of a position's lines extend to full width and the bracket spine shows
while the position is *emphasized*. Emphasis is any of:

- hovering any of its line segments or pills on the chart,
- the position selected (click on line/pill),
- hover or selection of its row in the positions dock (reuse the existing
  trade line ↔ row sync signals — no new state),
- dragging its SL/TP/entry line (drag implies emphasis; you always aim a
  drag against the full-width line).

When emphasis ends, lines retract to their resting segments. No animation
required; instant is fine.

### Viewport edge cases

Let `entryX` = pixel x of the entry bar. The resting entry segment is
`[left edge, min(entryX, right edge)]`, with two special cases:

- **Entry bar off-screen left** (viewing recent bars, entry in the past):
  the segment would be empty. Fall back to the SL/TP-style pill stub so the
  position stays anchored on screen.
- **Entry bar off-screen right** (viewing history from before the entry):
  segment is full visible width. Acceptable — everything visible predates
  the entry — and it self-resolves on scrolling back to the present. The end
  dot is simply not visible.
- **Derived/higher timeframes**: snap the entry timestamp to the containing
  bucket bar, same as trade markers.

### Interaction details

- Hover hit-testing must work on the *resting* segment (shortened line and
  stubs), not just the full-width line, and continue to work on the
  full-width line while emphasized (so the reveal doesn't flicker off when
  the cursor sits over a part that only exists while revealed).
- Per-trade hidden state and the master "Hide positions and orders" toggle
  behave as today; this design only changes what a *visible* line draws.

## Implementation notes (non-binding)

- `frontend/src/lib/positionLines.ts`: extend `LineSpec` with the resting
  segment end (entry timestamp or precomputed `endX`) and an
  `emphasized` flag; the `tradeLine` overlay template draws
  `[0, endX]` + end dot when resting, full width when emphasized or when the
  spec is a pending order.
- `ChartCore.tsx`: emphasis is derivable from existing hover/selected trade
  state plus the dock-row sync signals; feed it into `tradeLineSpecs()` /
  the overlay redraw. Bracket overlay gated on the same emphasis flag.
- Entry timestamp → x uses the existing timestamp→dataIndex snap used by
  trade markers; recompute on scroll/zoom/TF switch (already redrawn then).

## Testing

- Position with entry bar on-screen: line stops at entry bar with dot;
  right of entry is clean.
- Entry bar scrolled off left → pill stub; off right → full-width segment.
- SL/TP at rest → stub only, no bracket; hover pill / select line / hover
  dock row → all lines full width + bracket; leaving emphasis retracts.
- Dragging SL/TP shows full-width line throughout the drag.
- Pending order line remains full-width at rest.
- TF switch (incl. derived TFs) keeps the entry snap correct.
