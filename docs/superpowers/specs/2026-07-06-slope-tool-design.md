# Slope tool — design

A transient, live-adjustable on-chart ruler that measures the **slope** of a line
you draw between two points. Sibling to the existing Measure tool, but instead of
Δprice / bars / time it reports the line's **angle** plus rate-of-change readouts,
and — unlike Measure — it stays interactive after you draw it so you can nudge the
endpoints, slide the whole line, or rotate it.

Prototype (feel verified in-browser): `scratchpad/slope-tool-demo.html`.

## What it is

- **Transient, not persisted.** Never saved/reloaded (guarded out of `persist()`,
  like Measure). Cleared on Esc, on starting a new one, or on symbol/interval change.
- **Live after drawing.** Once placed it stays fully adjustable until dismissed —
  this is the key difference from Measure, which freezes non-interactive.
- **Data-geometry angle.** The angle is derived from the true price×time slope via a
  fixed reference scale, so it is **zoom-independent** (it does not change when you
  rescale). The rate readouts (%/bar, price/bar) are inherently scale-independent.

## Interaction

**Placing** (mirrors Measure — click, not drag):
1. Arm the tool (toolbar button; a keyboard affordance can follow later).
2. Click the start point.
3. Click the end point → the tool goes *live*.

**Live handles** (chosen by which handle you grab — no mode toggle):
- **Either endpoint** → drag to move that end freely (length + angle both change).
- **Middle point** (a 3rd endpoint at the line's center) → drag to **translate the
  whole line** (both ends move together; angle and length preserved).
- **Rotate knob** → a small handle offset from the midpoint on a short perpendicular
  **stem** (~68px). Drag it to **rotate the whole line around the midpoint pivot**;
  both ends swing symmetrically, length preserved.
  - Rotation is **relative**: on grab it starts at zero delta (no jump), then turns
    by exactly how far the cursor sweeps *around* the pivot. The stem gives a lever
    arm so the feel is proportional, not twitchy. (Putting the knob *on* the pivot —
    zero lever — was the original "rotates drastically" bug; the offset fixes it.)
  - **Shift** while rotating snaps the angle to 15° increments.

**Dismiss:** Esc, arming a new slope line, or a symbol/interval change.

## Readout

A pill anchored near the far end, with a colored up/down edge (green rising / red
falling), showing four numbers:

- **Angle** (degrees) — primary, large. Data geometry (see below).
- **%/bar** — percent-per-bar rate of change, matching how "slope" is defined for
  rule conditions elsewhere in the app (see `slope-conditions`).
- **price/bar** — absolute price change per bar.
- **price/time** — price change per unit time (per hour/day, from the base interval).

### Angle definition (data geometry)

Price and time axes share no natural scale, so the angle needs a **fixed reference
ratio** `ref` (price-units-per-bar that reads as 45°). Then:

```
angle = atan2(Δprice * ref, Δbars)   // degrees
```

`ref` is a fixed constant tied to a canonical price/time scale (not the live pixel
scale), which is what makes the number zoom-independent. In the fixed-scale prototype
`ref = pxPerPrice / pxPerBar`, so the drawn line visually matches its number; on the
real (zoomable) chart the number stays constant while the on-screen line angle varies
with zoom. That tradeoff was chosen deliberately over screen-geometry angle.

### Rate metrics

```
price/bar = Δprice / Δbars
%/bar     = (Δprice / anchorPrice) / Δbars * 100      // relative to the start price
price/hr  = price/bar * (60 / baseIntervalMinutes)    // or per-day, auto-scaled
```

Note `%/bar` references the anchor (start) price, so translating the line up/down
changes it slightly — that is correct (a given absolute slope is a different % at a
different price level). Angle and price/bar are translation-invariant.

## Architecture (real-chart integration)

Reuse the Measure-tool plumbing wherever it fits; the one genuinely new thing is that
this overlay is **interactive** (draggable handles) rather than a frozen figure.

- **`lib/slopeMetrics.ts` (+ test)** — pure, side-effect-free formatter, sibling to
  `measureMetrics.ts`. Input: the two points' `{price, index, time}`, precision, base
  interval, and the fixed `ref`. Output: `angle`, `pctPerBar`, `pricePerBar`,
  `pricePerTime`, direction (up/down), and the formatted pill lines. Fully unit-tested.
- **`lib/overlays.ts`** — add `Kind` `"slope"` with `startSlope / updateSlope /
  clearSlope / hasSlope`, single-instance `slopeId`, guarded out of `persist()`
  (same pattern as `"measure"`).
- **`lib/customOverlays.ts`** — register the `slope` overlay. Unlike `measure`
  (`ignoreEvent:true`, non-interactive), this overlay's two anchor points are
  **draggable**. The **middle point** (translate) and the **rotate knob** are extra
  handles that need custom hit-testing + drag handling; the pill, stem, angle arc, and
  handle glyphs are drawn figures. Fixed colors (read on both themes), same
  blue-border-nulling gotcha as Measure's text figure.
- **`ChartCore.tsx`** — a capture-phase pointer path for the custom handles
  (midpoint translate, rotate knob), following the existing Measure/trade-line/alert
  capture-mousedown ordering. The relative-rotation reference frame (pivot, half
  length, original angle, grab angle) is captured on the knob's mousedown.
- **`lib/chartController.ts`** — a per-cell `slopeArmed` signal alongside
  `measureArmed` (optional-chain reads to survive the HMR-stale-controller footgun).
- **`Toolbar.tsx` + `lib/menuIcons.tsx`** — a toolbar button + icon to arm the tool
  (one-shot arm, like the ruler button).

### Open implementation choice (for the plan)

klinecharts overlays natively support dragging the *defined* points, but the extra
midpoint and rotate handles are not native points. The plan should choose between
(a) a klinecharts overlay whose 2 points are native-draggable plus custom figures +
custom event handling for the midpoint/knob, or (b) a dedicated overlay canvas with
our own hit-testing and pointer handlers (as the prototype does, and as the
selection/bracket overlays already do). Lean toward whichever matches the least-
surprising existing pattern for interactive on-chart handles.

## Testing

- Unit: `slopeMetrics.ts` — angle sign/magnitude, %/bar vs price/bar, duration/time
  scaling, precision-based rounding, degenerate (Δbar=0) cases.
- Wiring e2e: arm/disarm, Esc, no-persist across reload, no console errors. As with
  Measure, headless input can't finalize the click→click placement or exercise the
  drag handles reliably, so the handle feel (endpoint move, midpoint translate,
  rotate, Shift-snap) is verified by hand in a real browser.

## Out of scope (YAGNI)

- Persistence / saving named slope lines.
- Numeric angle entry (type a degree value) — the rotate knob covers it; can revisit.
- Multiple simultaneous slope lines (single-instance, like Measure).
