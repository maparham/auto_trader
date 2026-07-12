# Crossing markers on the selected curve — design

Date: 2026-07-12
Status: approved

## What

When a curve on the candle pane is selected (click on the curve or its legend
row), small dots mark every point where that curve crosses any other visible
curve on the candle pane. The dots are transient decoration: they appear on
select, disappear on deselect, and are never persisted.

## Why

Traders read crossings (EMA over EMA, price MA through a pivot band, …) as
signals. Today you have to eyeball intersections; this makes them explicit the
moment you focus a curve.

## Behavior

- **Trigger & lifetime.** Dots exist only while a candle-pane curve is
  selected. Deselecting (Esc, click empty chart, select something else)
  removes them. Selecting a different curve recomputes against the new
  selection.
- **What gets compared.** The selected curve's series vs every other *visible*
  curve on the candle pane. Individual figures of multi-line indicators count
  as separate curves (each BOLL band, each Pivot Bands line). Excluded:
  - sibling figures of the selected indicator instance itself (BOLL mid
    "crossing" its own upper band is not signal);
  - hidden indicators / hidden figures;
  - sub-pane indicators (different price scale — intersections are
    meaningless).
- **Direction coloring.** Marker is the app's up color when the selected curve
  crosses **above** the other curve, down color when it crosses **below**.
- **Not interactive.** No hover, no click. The crosshair already provides
  time/price readout.

## Crossing math

Per bar `i` over the visible range (plus one bar of margin on each side):

```
d[i] = selected[i] − other[i]
```

- A crossing exists where `d[i−1]` and `d[i]` have opposite signs, or where
  `d[i]` transitions through exactly 0 (touch-and-cross counts once; touch-
  and-bounce, where the sign is the same on both sides of the zero, is not a
  crossing).
- Linearly interpolate between bars `i−1` and `i` to get the fractional bar
  position and price of the intersection, so the dot sits visually on the
  intersection rather than snapped to a bar center.
- Skip pairs where either series is null/NaN at `i−1` or `i` (warm-up, MTF
  forward-fill gaps).

## Rendering

- Drawn on the existing indicator-selection overlay canvas (the dedicated
  layer that already paints hollow handles on the selected curve), in the same
  redraw pass, using the same `convertToPixel` cache/pattern.
- Small directional arrow (~7×7 px triangle) whose tip sits exactly on the
  intersection: up-arrow with its body below the crossing, down-arrow with its
  body above, outlined in the chart background color so it reads on top of
  both curves. (Revised from the original small-circle design by user request.)
- Only visible-range crossings are computed per redraw — same cost profile as
  the existing handle drawing.

## Architecture

- **New pure module** for crossing detection: takes two aligned numeric series
  (arrays indexed by dataIndex) and a range, returns
  `{ index, frac, price, direction }[]`. No chart imports — unit-testable.
- **Enumeration of "other curves"** reuses the candle-pane indicator walk the
  legend/selection code already does (`getIndicatorByPaneId`, per-figure
  series extraction from `indicator.result`), respecting visibility flags.
- **Integration point**: the selection-overlay redraw path. When a selection
  exists, gather other curves, run the detector, paint dots after the handles.

## Testing

- Vitest unit tests for the detector: simple sign change both directions,
  exact-touch equality (cross vs bounce), NaN gaps, interpolation
  correctness, empty/short series.
- Integration-level check that sibling figures of the selected indicator are
  excluded and hidden curves are skipped.
- Manual browser verify: two EMAs, select one, dots at each intersection with
  correct colors; deselect clears; TF switch recomputes.

## Out of scope

- Price (candle close) × indicator crossings.
- Sub-pane curves.
- Persistence, alerts, or any interactivity on the dots.
