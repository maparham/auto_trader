# Shift angle-snap on straight lines + Rectangle drawing tool

**Date:** 2026-07-07
**Status:** Approved (design), pending implementation plan

## Summary

Two related chart-drawing enhancements, sharing one Shift-key snap mechanism:

1. **Shift angle-snap** — holding **Shift** while drawing or editing a straight-line
   drawing (`segment`, `rayLine`, `straightLine`) snaps the moving endpoint to the
   nearest **45° screen angle** relative to the anchored endpoint (horizontal,
   vertical, or a 45° diagonal *as they appear on screen right now*), exactly like
   TradingView. Live: pressing/releasing Shift mid-drag toggles the snap.

2. **Rectangle drawing tool** — a new persistent, interactive `rect` overlay (two
   draggable corner points, translucent fill + solid border), wired into the
   existing drawing pipeline (sidebar, persistence, settings modal, defaults/
   templates). Holding **Shift** while drawing/resizing it snaps to a **square**
   (equal on-screen width and height about the anchored corner).

Both Shift behaviors share one interception layer; they differ only in the snap
function selected by overlay name.

## Decisions (from brainstorming)

- Snap target: **screen angles like TV** (not data-space slope, not H/V-only).
- Active during: **both drawing and editing** an existing line.
- Applies to: **all straight-line tools** — `segment`, `rayLine`, `straightLine`.
- Rectangle + Shift: **snap to a square**.
- Rectangle default appearance: **translucent fill + solid border**, all editable.

## Background: how klinecharts drives draw/drag (verified in source)

`node_modules/klinecharts/dist/index.esm.js`:

- **Drawing** (`mouseMoveEvent`, ~line 8434):
  ```
  overlay.eventMoveForDrawing(coordinateToPoint(event));  // sets points[last] (data-space)
  overlay.onDrawing?.call(overlay, { overlay, figureKey, figureIndex, ...event });  // AFTER; return ignored
  ```
  → `onDrawing` runs after the point is set and its return value is ignored. We can
  **post-hoc overwrite `overlay.points[last]`** inside `onDrawing`; it sticks because
  the redraw happens after the handler returns.

- **Editing** (`pressedMouseMoveEvent`, ~line 8512):
  ```
  if (!(overlay.onPressedMoving?.call(overlay, { overlay, figureIndex, figureKey, ...event }) ?? false)) {
    const point = coordinateToPoint(event);
    if (figureType === Point) overlay.eventPressedPointMove(point, figureIndex);
    else overlay.eventPressedOtherMove(...);
  }
  ```
  → `onPressedMoving` runs **before** the default point update, and **returning truthy
  makes klinecharts skip its own `eventPressedPointMove`**. So on a Shift-drag we
  compute the snapped point ourselves, assign `overlay.points[figureIndex]`, and
  `return true`. Without Shift we return falsy and the native path runs untouched.
  `figureIndex` is the index of the dragged endpoint/corner.

- Both `onDrawing` and `onPressedMoving` are the per-overlay instance callbacks set
  in `OverlayManager.create()` (`lib/overlays.ts`), which close over the per-cell
  `this.chart`. Pixel conversion via public `chart.convertToPixel(points, finder)` /
  `chart.convertFromPixel(coordinates, finder)` (finder `{ paneId }`) — the same API
  already used elsewhere in the app. The klinecharts UI `event` carries pane-relative
  `.x` / `.y` pixel coordinates.

Consequence: **no custom template or module-level active-chart fallback is needed.**
Everything hooks through the existing instance callbacks with the public convert API.

## Feature 1 — Shift angle-snap on straight lines

### Geometry helper (pure, unit-tested)

New module, e.g. `lib/snapAngle.ts`:

```
snapScreenAngle(fixed: Pt, moving: Pt): Pt
```
- `v = moving − fixed` in pixels.
- `angle = round(atan2(v.y, v.x) / (π/4)) * (π/4)` — nearest 45°.
- `len = hypot(v)`.
- return `{ x: fixed.x + cos(angle)*len, y: fixed.y + sin(angle)*len }`.

Locks the angle to the nearest of the 8 principal directions while preserving the
cursor's distance along that direction. Because screen-y is down-positive, a snapped
vertical vector is a perfectly horizontal line; vertical and both diagonals fall out
naturally. (Conceptually mirrors the existing slope-tool knob snap in
`ChartCore.tsx`, but applied to the endpoint rather than a rotation.)

### Interception layer

In `OverlayManager.create()`, for the straight-line names
(`segment`, `rayLine`, `straightLine`) — and, for Feature 2, `rect`:

- Wrap `onDrawing`: if `event.shiftKey` and the overlay has ≥2 placed points,
  - fixed = `points[0]`, moving = `points[last]` (the just-set point);
  - convert both to pixels, snap moving via the name-appropriate snap function,
    convert back, assign `points[last]`.
- Wrap `onPressedMoving`: if `event.shiftKey` and the overlay is a snap-eligible name
  with exactly 2 points,
  - moving index = `figureIndex`, fixed = the other point;
  - convert fixed to pixels; take the drag position from `event` pixels;
  - snap, convert back, assign `points[figureIndex]`; **return `true`** to skip the
    native update. Otherwise return the wrapped callback's own result (falsy) so the
    native path runs.

The name→snap-function dispatch: straight lines → `snapScreenAngle`; `rect` →
`snapSquare` (Feature 2). This keeps the plumbing written once.

Guard: only 2-point overlays participate. `priceLine`, `horizontalStraightLine`,
`verticalStraightLine`, `priceChannelLine`, `fibonacciLine` are unaffected (they are
either not in the eligible set or not 2 free points).

## Feature 2 — Rectangle drawing tool

### Overlay template

New `rect` `OverlayTemplate` in `lib/customOverlays.ts`, modeled on `rangeBand` but
**persistent and interactive**:
- `totalStep: 3` (two clicks), `needDefaultPointFigure: true` (native draggable
  corner handles), default X/Y axis figures off.
- `createPointFigures`: from the two corner coordinates compute
  `left/right = min/max x`, `top/bottom = min/max y`, emit one `polygon` with
  `style: "stroke_fill"`, `color` = fill, `borderColor` = border, `borderSize`.
- Registered in `registerCustomOverlays()` alongside the others.

### Sidebar + registry

- `lib/drawTools.ts`: add `{ name: "rect", label: "Rectangle" }` to `DRAW_TOOLS`.
  `DrawSidebar` filters `DRAW_TOOLS` by `getSupportedOverlays()`; verified in the
  klinecharts source that `registerOverlay` writes into the same `overlays` map that
  `getSupportedOverlays()` enumerates, so a registered `rect` is automatically
  "supported" and appears in the flyout — no filter change needed.
- `DrawIcons.tsx`: add a box glyph for `name === "rect"`.

### Persistence & defaults

Rides the existing name-keyed `OverlayManager.create` path (same as `segment`), so
persistence, clone/paste, and the per-overlay "set as default" / named-template
system work without new code. Confirm the drawing-default seeding
(`loadDrawingDefault`) applies to `rect` styles.

### Default style

Translucent fill + solid border, e.g. fill `rgba(41, 98, 255, 0.12)`, border
`#2962ff`, borderSize 1 — matching the app's existing accent used by `rangeBand`.

### Settings modal (fill/border editing)

`DrawingSettings.tsx` today only reads/writes `styles.line` (color/width/style). Add
a **rect-aware branch** in the Style tab:
- Detect a rect overlay (by `live.name === "rect"`).
- Read `styles.polygon` → `{ color (fill), borderColor, borderSize }`.
- Controls: **fill color + opacity**, **border color + width**. Reuse
  `ColorLineStylePicker` where it fits; add an opacity control for the fill.
- Writes via `overlays.setStyle(id, { polygon: { ... } })`.

Keep the change scoped: the line-based branch stays as-is for existing tools.

### Shift → square snap

`snapSquare(fixed, moving)`: `s = max(|Δx|, |Δy|)` (or a chosen convention — likely
`min` vs `max`; use **max** so the square encloses the cursor's larger extent),
return `{ x: fixed.x + sign(Δx)*s, y: fixed.y + sign(Δy)*s }`. Wired through the same
interception layer, selected when the overlay name is `rect`.

## Testing

- **Unit (vitest):** `snapScreenAngle` — cardinal and diagonal cases, length
  preservation, near-boundary rounding; `snapSquare` — sign handling and equal extent.
- **Interaction:** manual/e2e verification in the running app —
  - draw a trendline with Shift → snaps to H/V/diagonal; release Shift → free;
  - drag an existing endpoint with Shift → snaps; without → native behavior intact;
  - repeat for `rayLine` and `straightLine`;
  - draw a rectangle, Shift → square; edit a corner, Shift → square;
  - rectangle appears in sidebar flyout, is star-able, persists across reload,
    fill/border editable in the settings modal, participates in defaults.
- **Regression:** existing drawings (priceLine/alerts, fib, channel, H/V lines),
  slope/measure tools, and magnet snapping behave unchanged.

## Out of scope / YAGNI

- Rotated (non-axis-aligned) rectangles.
- Snap increments other than 45° (no 15°/30° for line drawing).
- Shift-snap on non-2-point tools (channel, fib).
- A status-bar "snapping" hint (can add later if wanted).

## Risks

- The Shift interception depends on the klinecharts event flow documented above
  (verified in the bundled `index.esm.js`). If a future klinecharts upgrade changes
  the `onPressedMoving`-return-skips-default contract, the edit-path snap must be
  revisited.
