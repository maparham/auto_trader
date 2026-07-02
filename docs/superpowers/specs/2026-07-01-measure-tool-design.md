# Measure tool (TradingView-style) — design

Date: 2026-07-01
Status: approved, ready for implementation plan

## Goal

Add a TradingView-style **Measure** tool to the chart: drag a box across a span
of bars and see the price change, percent change, tick count, bar count, and
elapsed time in a rounded label. The box is tinted green when price rose over the
span and red/pink when it fell, with a vertical arrow pointing in the price
direction and a light crosshair through the two anchor points.

Reference (TV): a red box for a down move showing `−0.293 (−0.42%) −293` on the
first line and `25 bars, 2h 15m` on the second; activated in TV via `⇧ + click`.

## Decisions (confirmed with user)

- **Transient.** The measurement is never saved to the layout. It behaves like
  TV's Measure: it shows while you drag, freezes on release, and is discarded on
  the next interaction. It never enters the persisted drawing registry.
- **Two triggers:** hold **Shift and drag** on the chart, *and* a dedicated
  **ruler button** in the toolbar that arms the tool for the next drag.
- **Metrics shown** (matching the TV screenshot):
  - Line 1: `Δprice (Δ%) Δticks` — absolute price change, percent change, and the
    number of min-ticks (Δprice ÷ min-tick).
  - Line 2: `N bars, Hh Mm` — bar count across the span and elapsed time.
  - Angle/slope and volume are explicitly out of scope for v1 (easy to add later
    as extra label lines).
- **Shift+drag suppresses chart panning** while a measurement is in progress.

## Non-goals (v1)

- No persistence, no selection/edit/copy/delete, no settings modal, no context
  menu. This is a throwaway measurement, not a drawing.
- No angle, no volume, no "date & price range" persistent variant.
- No multi-instance: only one live measurement at a time.

## Architecture

Builds on the existing overlay stack (`lib/overlays.ts` `OverlayManager`,
`lib/customOverlays.ts` `registerOverlay`, `ChartCore.tsx`, `Toolbar.tsx`,
`lib/signals.ts`). See the `charting-stack` and `drawing-editing` memories.

### 1. The `measure` overlay (`lib/customOverlays.ts`)

Register a **new** overlay named `measure` (a new name — it does *not* override a
built-in). Two points. `totalStep = 3` (2 points + start), same as `segment`.

`createPointFigures({ overlay, coordinates, precision, ... })` returns, from the
two corner coordinates `c0` (start) and `c1` (end):

1. **Rectangle** — a `polygon` (or `rect`) spanning the bounding box of `c0`/`c1`,
   filled translucent. Color is green when `c1.value >= c0.value` else red/pink.
   Border matches, slightly stronger alpha.
2. **Direction arrow** — a vertical `line` down the horizontal centre of the box
   from the start price level to the end price level, with an arrowhead figure at
   the end pointing toward the end price (down for a fall, up for a rise).
3. **Crosshair** — a thin horizontal `line` at `c0.value` and a thin vertical
   `line` at `c0`'s x (light, low alpha), so the anchor reads like TV's.
4. **Label pill** — a `text` figure centred just below the lower edge of the box,
   with `backgroundColor`, `borderRadius`, and padding, containing two lines:
   - `formatDelta(price) (formatPct%) formatTicks` and
   - `${bars} bars, ${formatDuration(ms)}`.

**Metric computation (inside `createPointFigures`):**

- `dPrice = p1.value - p0.value`
- `pct = p0.value !== 0 ? dPrice / p0.value * 100 : 0`
- `minTick = 10 ** -precision.price` → `ticks = Math.round(dPrice / minTick)`
- `bars = Math.abs(p1.dataIndex - p0.dataIndex)` (klinecharts points carry
  `dataIndex`; if only `timestamp` is present fall back to
  `Math.round(|t1 - t0| / barMs)`, where `barMs` is stashed in `extendData` at
  create time from the active period).
- `ms = Math.abs(p1.timestamp - p0.timestamp)` → `formatDuration` →
  `Hh Mm` / `Nd Hh` / `Mm` as appropriate.

Number formatting uses the instrument price precision for `dPrice`, a fixed 2
decimals for `pct`, and integer for `ticks`/`bars`. Colors come from
`lib/chartTheme.ts` (add measure up/down tints for dark + light) so the tool
respects the active theme.

### 2. Transient lifecycle (`lib/overlays.ts`)

Add a new `Kind` value `"measure"` alongside `"alert"` / `"drawing"`. Extend
`create()` minimally: a measure overlay is created with `needDefaultYAxisFigure:
false`, no persistence in any lifecycle callback, and no hover/select wiring. Add
a single-instance guard: creating a measure removes any existing one first
(`this.measureId`).

New `OverlayManager` API:

- `startMeasure(p0)` — create the `measure` overlay with points `[p0, p0]` (fully
  placed, *not* interactive-draw), stash `barMs` in `extendData`, record
  `measureId`. Returns the id.
- `updateMeasure(p1)` — `overrideOverlay({ id: measureId, points: [p0, p1] })`
  while dragging.
- `clearMeasure()` — remove the current measure overlay if any.
- `hasMeasure()` — whether one is live.

`create()`'s `onRemoved` clears `measureId` when the removed overlay is the
measure. `persist()` must skip measure overlays entirely (they are not in
`SavedOverlay` space — they never reach `persist()` because measure lifecycle
callbacks don't call it, and `persist()` already iterates `entries` by kind, so
guard the measure kind out there too, belt-and-suspenders).

Points are `{ timestamp, value, dataIndex }`. The drag routine builds them via
`chart.convertFromPixel({ x, y })` (returns `dataIndex` + `value`; timestamp
derived from `dataIndex` via the loaded data, or `convertFromPixel`'s timestamp
if provided).

### 3. Drag routine + triggers (`ChartCore.tsx`, `Toolbar.tsx`, `lib/signals.ts`)

One shared routine `beginMeasureDrag(startX, startY)` on the focused cell:

1. `p0 = overlays.startMeasure(fromPixel(startX, startY))`.
2. Attach window `mousemove` → `overlays.updateMeasure(fromPixel(x, y))`.
3. Attach window `mouseup` → detach listeners, freeze (the overlay stays shown).

Two entry points feed it:

- **Shift+drag** — a capture-phase `mousedown` handler on `.chart-wrap` (sibling
  to the existing `onClonePress` clone handler). When `e.shiftKey` and the target
  is the chart canvas: `e.preventDefault()` + `e.stopPropagation()` (so
  klinecharts does not pan), then `beginMeasureDrag`.
- **Ruler button** — a new toolbar icon button toggles a per-cell `measureArmed`
  signal (`lib/chartController.ts`, alongside `avwapAnchorMode`/`autoScale`). When
  armed: the chart shows a crosshair cursor; the next `mousedown` on the canvas
  calls `beginMeasureDrag` (stopPropagation to avoid pan) and disarms. Pressing
  **Esc** while armed disarms without drawing.

**Discard-on-next-interaction:** a plain (non-Shift, non-armed) `mousedown` on the
chart, `Esc`, or a symbol/timeframe change calls `overlays.clearMeasure()`. Wire
this in ChartCore's existing empty-space/click and keydown branches and in the
symbol/period change effect (same place drawings rehydrate).

### 4. Colors (in `lib/customOverlays.ts`, not theme tokens)

**Decision (changed from the original draft):** the measure box/pill colors are
**fixed constants in `customOverlays.ts`**, not `chartTheme.ts` tokens. The
translucent up/down fills (`rgba(38,166,154,…)` / `rgba(239,83,80,…)`), solid pill,
and white pill text read correctly on both light and dark backgrounds — verified by
eye on both themes — so per-theme tokens buy nothing. TradingView's own measure tool
uses theme-independent measure colors too. `chartTheme.ts` is therefore untouched.

## Data flow

```
Shift+mousedown (capture)  ─┐
Ruler armed + mousedown     ├─▶ beginMeasureDrag(x,y)
                            │      startMeasure(p0)  ──▶ createOverlay(name:'measure', points:[p0,p0])
window mousemove ───────────┼─▶ updateMeasure(p1) ──▶ overrideOverlay(points:[p0,p1]) ─▶ createPointFigures repaints
window mouseup ─────────────┴─▶ freeze (listeners off, overlay stays)
next plain mousedown / Esc / symbol change ─▶ clearMeasure() ─▶ removeOverlay
```

## Error / edge handling

- Zero-length drag (click without moving): if `p0 == p1`, remove the overlay on
  mouseup rather than leaving a degenerate box.
- Drag beyond the last bar / into empty space: clamp `dataIndex`/value from
  `convertFromPixel`; bars/duration computed from whatever `convertFromPixel`
  returns (may extrapolate past the last bar, same as TV).
- Precision not yet loaded: fall back to `precision.price ?? 2` so ticks stays
  finite.
- Theme switch mid-measure: `createPointFigures` reads theme tokens each paint,
  so a live measure recolors on theme change.
- Symbol/timeframe change mid-drag: the change effect calls `clearMeasure()` and
  the window listeners are detached defensively in the mouseup/cleanup path.

## Testing / verification

- **Unit (`lib/*.test.ts`):** a small `measureMetrics.ts` pure helper
  (dPrice/pct/ticks/bars/duration/formatDuration) with a `measureMetrics.test.ts`
  covering up vs down moves, tick rounding at a given precision, and duration
  formatting (minutes, hours, days).
- **Playwright (`frontend/scripts/`):** extend or add a probe that (a) clicks the
  ruler button, drags across N bars, and asserts the label pill text matches the
  computed price/%/ticks/bars/duration; (b) reloads and asserts no measure
  overlay persists (transient); (c) Shift+drag produces the same box; (d)
  a plain click afterwards clears it.

## Files touched

- `frontend/src/lib/customOverlays.ts` — register `measure`, `createPointFigures`.
- `frontend/src/lib/overlays.ts` — `"measure"` kind; `startMeasure` /
  `updateMeasure` / `clearMeasure` / `hasMeasure`; persist guard; `onRemoved`
  clears `measureId`.
- `frontend/src/lib/measureMetrics.ts` (new) + `.test.ts` — pure metric helpers.
- `frontend/src/lib/chartController.ts` — per-cell `measureArmed` signal.
- (measure colors are fixed constants in `customOverlays.ts`; `chartTheme.ts`
  is intentionally NOT touched — see §4.)
- `frontend/src/ChartCore.tsx` — Shift+drag capture handler, `beginMeasureDrag`,
  armed-mousedown, clear-on-next-interaction / Esc / symbol change.
- `frontend/src/Toolbar.tsx` (+ `lib/menuIcons.tsx`) — ruler button + icon.
- `frontend/scripts/verify-measure.mjs` (new) — Playwright verification.
