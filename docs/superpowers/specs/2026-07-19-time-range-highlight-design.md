# Time Range Highlight drawing tool — design

Date: 2026-07-19
Status: approved (chat), pending spec review

## Purpose

A persistent drawing tool that marks a time range on the chart as a full-height
shaded vertical band. The core use case: click one 4H candle, switch to 15m,
and see exactly those 4 hours still highlighted (now spanning 16 candles).
For marking events, sessions of interest, setups under study, etc.

## Semantics (the key decision)

A highlight is the half-open time interval `[start, end)` in epoch ms.

- Single-click on a candle stores that candle's **span**: `[openTime, openTime + tfMs)`
  where `tfMs` is the bar width of the timeframe active at placement.
- The interval is timeframe-independent by construction. On a finer TF the band
  covers all bars inside it; on a coarser TF it covers the sliver of the bar it
  falls in (band edges may land mid-bar — that is correct, not a bug).
- Drag-created ranges snap to bar boundaries of the current TF at placement,
  but are stored as raw timestamps thereafter (no re-snapping on TF change).

## Gestures

One sidebar tool ("Time range"), two placement gestures:

- **Click** (mousedown + mouseup without meaningful drag, ~3px threshold):
  marks the clicked candle's span. Placement completes in one action.
- **Click-drag**: start = bar boundary at mousedown, end = bar boundary at
  mouseup (inclusive of the bar under the cursor), min one bar. Dragging left
  of the start is allowed (normalize so start < end).
- After placement: selecting the band shows hollow edge handles (existing
  selection system); dragging a handle resizes by whole bars of the current TF.
  Dragging the body moves the whole range. Right-click follows the existing v10
  contract (`onRightClick` preventDefault → context/no insta-delete, matching
  other drawings).

## Rendering

- Full-height translucent band with 1px border edges, drawn like the existing
  transient `rangeBand` overlay (polygon over `bounding.height`, y ignored) but
  as a first-class selectable drawing.
- **Label**: optional short text, rendered horizontally at the top of the band,
  clipped to the band width (ellipsis). Edited in the DrawingSettings modal.
- **Duration readout**: when hovered or selected, show a small pill near the top
  edge: humanized span + bar count at current TF, e.g. `4h · 16 bars`. Bars
  count = bars whose open falls in `[start, end)`.
- Colors: fill + border per mark, from the standard color picker. Default
  matches the app accent at low alpha (same family as `rangeBand`'s
  `rgba(41, 98, 255, 0.12)` fill / `0.7` stroke).

## Integration points (existing systems, reused)

- `frontend/src/lib/customOverlays.ts`: new `timeRange` OverlayTemplate,
  registered in `registerCustomOverlays()`. Two points, y ignored.
- `frontend/src/lib/drawTools.ts`: add `{ name: "timeRange", label: "Time range" }`
  to `DRAW_TOOLS`; glyph in `DrawIcons.tsx`.
- `frontend/src/lib/overlays.ts` (OverlayManager): kind `"drawing"` — persists
  per-epic, survives reloads and TF switches via the existing resolution-aware
  anchor encode/decode and coverage page-back (drawing-anchor-timeframes work).
- DrawingSettings modal: color pickers + label text field. Per-overlay-name
  Defaults + named templates work as for other drawings (a saved red "news"
  template etc.).
- Legend/visibility, delete key, clone/copy: inherited from the drawing kind;
  no special-casing expected.

### Off-grid end anchor (the one extension needed)

Existing anchors are bar timestamps. `end` may fall **between** bar opens on a
coarser TF (e.g. a 4H span viewed on 1D). The x-coordinate decode must place
such a timestamp fractionally inside its containing bar
(`x(bar) + frac * barWidth`) instead of snapping to a bar open. Verify whether
the current decode already handles off-grid timestamps; if it snaps, extend it
for this overlay (a time-fraction interpolation, applied for `timeRange`
points only so other drawings keep their current snapping behavior).

Similarly, a range wholly in unloaded history relies on the existing coverage
page-back to resolve; a range whose `end` is beyond the last loaded bar uses
the existing future-anchor (`n bars past last candle`) path.

## Single-click placement mechanics

Other drawings place points on click via klinecharts steps. `totalStep: 3`
(two points) with drag-to-place needs the same override-driven flow the
transient `rangeBand` uses (OverlayManager drives points during drag). Plan:
create the overlay on mousedown with both points at the pressed bar, update
point 2 during drag, finalize on mouseup — collapsing to the one-candle span
when no drag occurred. This lives in OverlayManager next to the existing
rangeBand drive logic.

## Error handling / edge cases

- Zero-width after normalization → treat as single-candle click.
- TF change while placing → cancel placement (matches measure/rangeBand).
- `end` in closed-market gap: bars-count pill counts loaded bars only; band
  geometry is time-based so gaps simply compress visually like the axis does.
- Storage: standard drawing persistence payload (two timestamps + style +
  label); no new persistence surface, no migration.

## Testing

- Unit (vitest, node env with the existing klinecharts-enum mock):
  - span math: click on 4H bar → `[open, open+4h)`; drag right/left normalize;
    min one bar.
  - off-grid decode: end mid-bar on coarser TF → fractional x.
  - duration readout formatting (`4h · 16 bars`, `3d 2h · N bars`).
- Overlay figure test in `chartPainters`/overlay style: polygon spans full
  height, label clipping.
- Manual: place on 4H → verify exact coverage on 15m and 1D; reload; TF
  switch during selection; defaults/template save-apply.

## Out of scope (YAGNI)

- Price-bounded boxes (that's `rect`).
- Auto-marking (e.g. from news feeds or backtest trades).
- Cross-cell/sync of highlights beyond normal per-epic drawing scope.
