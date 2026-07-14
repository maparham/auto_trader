# Slope indicator: optional on-chart MA curves

**Date:** 2026-07-14
**Status:** Approved, ready for planning

## Summary

The Slope sub-pane indicator internally computes an EMA/SMA of each configured
length (`calcParams` = list of lengths, e.g. `[9, 21, 50]`) in order to derive
that MA's slope. Those underlying MA curves are not shown anywhere today. This
feature adds an opt-in "Show MAs on chart" toggle to the Slope settings that
plots the underlying MA curves on the main candle pane, one solid curve per
slope length, color-matched to the corresponding slope line.

The curves are an **adornment of the Slope**, not a first-class indicator: there
is one source of truth (the Slope), no separate legend row, no independent
copy/remove/style, and no rule-operand exposure.

## Behavior

- A "Show MAs on chart" toggle in the Slope indicator settings, default **off**.
- When **on**: the candle pane shows one solid MA curve per configured slope
  length. Each curve uses the exact same MA type, length, source, and MTF
  timeframe that feeds its slope line, and is drawn in the **same color as that
  slope line** in the sub-pane.
- When **off**, or when the Slope indicator is removed or hidden, the curves are
  removed/hidden.
- The curves track pan / zoom / scroll-back like any candle-pane indicator.

## Rendering mechanism: self-draw painter on the candle-pane overlay canvas

We draw the MA curves ourselves in ChartCore's existing redraw loop
(`chart/useChartPaint.ts`), the same place `paintBracket` / `paintSelectionDots`
/ `paintCrossingDots` already self-draw onto candle-pane overlay canvases. We do
NOT add a companion indicator instance.

Why self-draw over a companion indicator: the repo already has the painter
scaffolding (DPR-aware canvas sizing, `convertToPixel` against `candle_pane`,
clip-to-pane-height, and a redraw loop already subscribed to `OnScroll` /
`OnZoom` / `OnPaneDrag`, so it follows pan / zoom / scroll-back), and `maSeries`
+ `alignHtfToChart` are shared and synchronous. A painter therefore reuses all of
that and touches ZERO enumeration sites. A companion indicator would instead need
new filtering in at least four places (the legend `rowsForPane`,
`applyIndicatorVisibility`, curve selection, and snapshot/hydrate reconstruct),
because `hideLegendValue` only blanks a row's value text, not the row itself; plus
a create/update/remove lifecycle and second-instance MTF wiring. Self-draw also
gets persistence, snapshots, named layouts, and symbol templates for free, since
the only new persisted state is a flag on the Slope's `extendData`.

Accepted trade-off: a self-drawn curve does not participate in the candle pane's
y-axis auto-scale (a `Price`-series indicator would). On a very tight zoom into a
narrow price window, a far-away MA (e.g. MA(200)) can fall outside the visible
range and be clipped rather than pulling the scale to stay visible. Acceptable for
an adornment; where the curve is drawn it is positionally exact.

### Data source (parity by construction)

The painter reads the live Slope indicator(s) from the chart and, for each,
computes the underlying MA lines with the SAME shared functions the Slope uses:
`slopeLengths(calcParams)` for the length list and `maSeries(candles, maType,
length, { source }).base` per length. So the on-chart MA equals the MA the Slope
differentiates, by construction (no parallel `calc` path).

### Coloring

- Solid line per length (no green-up / red-down direction flipping: that stays a
  sub-pane-only behavior).
- Each line is drawn in its slope line's resolved color, read from the live Slope
  indicator with the exact resolution the Slope's own `draw` uses: per-line style
  override -> template default line color -> `SLOPE_PALETTE[li % len]` fallback.
  Because the painter reads this live each frame, a slope color edit recolors the
  on-chart curve automatically.

### MA follows the slope's smoothing

The on-chart curve is the MA base (`maSeries(...).base`) run through the Slope's
smoothing: raw when smoothing is off, and smoothed with the same SMA/EMA window
when it is on (via `smoothSeries`, which returns the input unchanged for
`type:"none"` or `length<=1`). This keeps the on-chart MA visually consistent with
the smoothed slope line. For MTF, the smoothing is applied on the HTF bars before
`alignHtfToChart` forward-fills onto chart bars (never after), so it never leaks
across chart bars.

### Curve labels

The on-chart MA curves reuse the app's generic curve-label controls, the same
ones every other on-chart indicator has: an enable toggle, a Show selector (When
selected / Always), and a Label position row (Right end / Left end, combined with
On line / Above / Below). The config lives on the Slope's `extendData.curveLabels`
(persisted and defaulted through the shared `curveLabelConfig`), so it saves,
snapshots, and templates for free like the rest of the Slope's state. When a
curve has labels enabled, a small pill is drawn at the chosen end reading the
MA's type + length ("EMA 21", "SMA 50"), colored to match the curve, via the
shared DOM `CurveLabelPill` layer: a `buildSlopeMaPills` builder (sibling to
`buildCurveLabelPills`) enumerates the on-chart MA curves and its pills are
concatenated into the existing single `setPills` call in the redraw loop. Because
these curves are self-drawn they are not in the figure LineCache the generic
builder reads, hence the dedicated builder. The sub-pane slope lines are not
labeled; only the candle-pane MA curves are.

This is a shared-control adornment (the same generic labels every indicator gets),
not independent styling, so it does not conflict with the Non-goal below that
rules out independent styling / legend / copy / remove for the curves.

## Ownership and lifecycle (one source of truth)

There is no second object to keep in sync. The painter reads the Slope's live
config every frame, so the curves cannot drift from the Slope.

- `showMa: boolean` lives on the Slope's `extendData` (persisted, mirroring how
  `threshold` is owned by the Slope). Default off / absent.
- The painter enumerates every live SLOPE indicator via
  `chart.getIndicatorByPaneId()`, and for each whose `extendData.showMa` is true
  AND whose `visible !== false`, draws its MA lines. So:
  - Toggling `showMa` off -> the Slope re-applies -> next redraw draws nothing.
  - Hiding the Slope (`visible === false`) -> painter skips it -> curves hidden.
  - Removing the Slope -> it is no longer enumerated -> curves gone.
- No legend row, no separate copy/remove/select, no independent persistence: the
  curves are pixels, not an indicator instance.
- The Slope's `applySlope` writes `showMa` into `extendData` (like it already
  writes `threshold`) and then triggers a redraw so the change shows immediately.

## MTF

When a Slope is on a higher timeframe, its MA base must be computed on the HTF
bars and aligned to the chart bars (no lookahead), exactly like the slope values.
The Slope's coordinator (`applySlopeTimeframe` in `mtfCoordinator.ts`) already
fetches the HTF candles and already computes `maSeries(...).base` on them to
derive the slope. We piggyback that existing fetch: `applySlopeTimeframe` also
stashes the per-line **MA base** transiently on the Slope's `extendData.mtf`
(alongside the slope-values array it stashes today), and the painter, when a Slope
has an MTF timeframe set, aligns that stashed base with `alignHtfToChart` at paint
time instead of recomputing on chart bars. The base stays transient (persist only
the timeframe, never the bulky series), consistent with the existing MTF design.

## Non-goals

- No new rule operands (visual only).
- No independent styling, legend row, copy, or remove for the curves.
- No direction-based (green/red) coloring of the on-chart MA.

## Wiring touchpoints

- `frontend/src/lib/indicators/slope.ts`: add `showMa?: boolean` to `SlopeExtend`;
  add a pure helper that, given a Slope's `calcParams` + `extendData` + the chart
  candles (and optional aligned MTF base), returns per-line
  `{ color, values: Array<number | undefined> }` for the painter. This helper is
  the shared parity surface (uses `slopeLengths` + `maSeries` + the same color
  resolution as `drawSlope`).
- `frontend/src/chart/useChartPaint.ts`: a new `paintSlopeMa` painter (mirrors the
  `paintBracket` structure: DPR-aware canvas, `convertToPixel` against
  `candle_pane`, clip to candle-pane height), invoked from the `redraw` loop. Owns
  its own overlay canvas ref (threaded through the chart handle like the bracket /
  selection canvases).
- `frontend/src/ChartCore.tsx`: add the `<canvas>` for the MA-curve overlay (a
  sibling of the existing bracket / selection canvases) and its ref on the handle.
- `frontend/src/IndicatorSettings.tsx`: a "Show MAs on chart" toggle in the Slope
  panel, wired so `applySlope` writes `showMa` into `extendData` and requests a
  redraw.
- `frontend/src/lib/mtfCoordinator.ts`: in `applySlopeTimeframe`, also stash the
  per-line MA base (transient) on `extendData.mtf` alongside the slope values.

No new indicator type, no `customIndicators.ts` / `indicatorMeta.ts` / legend /
visibility / selection changes.

## Testing

**Unit**

- The slope-MA helper returns per-line values equal to `maSeries(...).base` for the
  same lengths / type / source (parity), and per-line colors matching the Slope's
  own resolution (override -> default -> palette).
- The helper honors `showMa` off (returns nothing to draw) and `visible === false`.
- MTF: given a stashed aligned base, the helper returns it verbatim (no recompute).
- Follow the `vi.mock("klinecharts", ...)` + top-level `await import` pattern for
  any test that loads a module which evaluates an indicator template at import
  (repo-wide klinecharts-enum test gotcha).

**In-browser verify**

- Add a Slope with lengths `[9, 21, 50]`, toggle "Show MAs on chart" on: confirm
  three color-matched solid curves on the candle pane that track the candles under
  pan / zoom / scroll-back.
- Edit a slope line color: confirm the matching on-chart curve recolors.
- Set the Slope to an MTF timeframe: confirm the curves step like the HTF MA and
  stay aligned on scroll-back.
- Toggle off: curves disappear. Hide the Slope (legend eye): curves disappear.
  Remove the Slope: no orphan curves. Reload: curves reappear from the persisted
  `showMa` flag.
