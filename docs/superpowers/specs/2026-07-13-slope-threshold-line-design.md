# Slope Threshold Line — Design

**Date:** 2026-07-13
**Status:** Approved, ready for implementation plan
**Scope:** Frontend-only. No backend, no rule/alert/backtest wiring.

## Problem

The MA Slope sub-pane indicator plots the slope of one or more MAs (green up /
red down) around a dashed zero line. There is no way to mark a "how steep is
steep enough" reference level. Users want an **adjustable horizontal threshold
line** they can eyeball against the slope curves.

## Decisions (user-approved)

- **Adjust via drag on the chart AND a number in settings.**
- **Symmetric pair:** one magnitude drives two mirrored lines at `+level` and
  `−level` (slope is signed up/down). Dragging either line moves both.
- **Visual only:** no rule/alert/backtest wiring in this change. The data model
  is structured so a future "slope crosses threshold" operand could read it
  without a redesign.
- **Indicator-owned, not a chart overlay** (main architectural call — see below).

## Architecture: ownership & data model

The threshold is **semantically part of the Slope indicator**, so it lives on
the indicator's `extendData`, not as a separate klinecharts overlay.

New field on `SlopeExtend` (`frontend/src/lib/indicators/slope.ts`):

```ts
threshold?: {
  on: boolean;                              // default false (opt-in)
  level: number;                            // magnitude; lines at +level and −level
  color?: string;
  lineStyle?: "solid" | "dashed" | "dotted";
};
```

**Why indicator-owned, not an overlay:**
- One source of truth (`extendData.threshold`).
- Free persistence — `extendData` already saves/hydrates via the existing
  indicator-config path (`persist/artifacts.ts` `SavedIndicatorConfig.extendData`).
- Avoids the split-brain overlay-lifecycle bugs already hit in this codebase
  (see `cross-tab-overlay-stomp`, `alert-identity-redesign`). A symmetric pair as
  overlays would be 2 overlay instances per slope instance to create / destroy /
  re-link on hydrate, times N slope indicators. Indicator-owned = zero
  cross-artifact sync.

**Trade-off accepted:** drag is not free (a native overlay would give it). Drag
is implemented in ChartCore's existing pointer machinery instead (same shape as
alert-line drag). This is contained and acceptable.

## Rendering & keeping the line on-screen

The slope pane **auto-scales to the slope values** (unlike RSI's fixed 0–100).
A threshold dragged beyond the visible slope range would fall off the pane and
become un-grabbable. Two-part fix:

1. **Force the y-axis to include ±level.** When `threshold.on`, `computeSlopeCalc`
   emits two constant keys on every result point: `thHi = +level`,
   `thLo = −level`. Because these are figure values, klinecharts' auto-scale
   grows the pane min/max to include them, so both lines stay visible and
   grabbable at any level.
   - These figures use **empty titles** so the DOM legend skips them (the legend
     already skips untitled figures — see `slopeFigures` title comment).
   - When `threshold.on` is false, the keys/figures are omitted so the pane scales
     to the slope data alone (no behavior change from today).

2. **Draw the two lines in `drawSlope`.** Right after the existing zero-line block,
   draw horizontal lines at `yAxis.convertToPixel(+level)` and
   `yAxis.convertToPixel(−level)` using the configured `color` and `lineStyle`
   (dash pattern via `ctx.setLineDash`, matching the zero-line idiom). A small
   `±level` label sits at the right edge of each line (like the slope-value pills)
   so the exact level is readable.

Note: the constant `thHi`/`thLo` figures drive scaling only; the visible lines are
drawn manually in `drawSlope` (which already returns `true` to suppress default
figure lines).

## Drag interaction (ChartCore)

Reuses the alert-line drag shape (`begin → dragTo → end`), but on the slope
sub-pane:

- **Hit-test:** on pointer-down inside the slope pane, compare cursor y against
  the pixel positions of `+level` and `−level` within a magnet band (same
  affordance as alert lines). A hit on either line grabs the pair.
- **Drag:** convert cursor y → slope value via
  `chart.convertFromPixel({ y }, { paneId: <slopePaneId> })`, take `Math.abs(value)`
  as the new magnitude, and live-update both lines (top up ⇒ bottom mirrors down).
  Symmetric by construction.
- **Drop:** write `threshold.level = |value|` back to the indicator via
  `overrideIndicator`, and persist through the existing indicator-config save path
  (NOT a chart-snapshot persist). No separate overlay write.

Feasibility confirmed: klinecharts exposes `convertFromPixel` with a `paneId`
option, so the sub-pane y-axis is reachable from ChartCore's pointer handlers.

## Settings UI (`IndicatorSettings.tsx`, Slope section)

- A **"Threshold" toggle** (default off). When on, reveals:
  - a numeric **Level** input (the magnitude; the pane shows ±it),
  - a **color + line-style picker** — reuse the shared `ColorLineStylePicker`,
  - an `InfoTip` explaining it is a symmetric visual guide.
- `applySlope` writes `threshold` into `extendData` **before** the coordinator
  recompute call (same ordering rule the `ma-slope-indicator` memory flags —
  write live values before recompute or the recompute uses stale stored values).
- **First-enable default:** set `level` to a sensible small magnitude relative to
  the current visible slope range (e.g. a fraction of the visible max slope) so
  the line appears on-screen; the user then drags/edits from there. If no range is
  available, fall back to a small constant appropriate to the current units.

## Interfaces / units of change

| Unit | File | Responsibility |
|------|------|----------------|
| Data model + calc + draw | `lib/indicators/slope.ts` | `SlopeExtend.threshold`; emit `thHi`/`thLo` constants + empty-title figures when on; draw the two lines + labels in `drawSlope` |
| Settings UI | `IndicatorSettings.tsx` | Threshold toggle, level input, color/line-style picker; write into `extendData` in `applySlope` before recompute |
| Drag | ChartCore (drag layer, cf. `lib/overlays.ts` alert drag) | Sub-pane hit-test, `convertFromPixel(paneId)` drag, mirror both lines, write back on drop |
| Persistence | existing `persist/artifacts.ts` | No change — `extendData.threshold` saved/hydrated by the existing config path |

## Testing

- **Unit (`slope.ts`):** with `threshold.on`, `computeSlopeCalc` emits `thHi`/`thLo`
  equal to `±level` on every point; with it off, neither key is present. Follow the
  `vi.mock("klinecharts", …)` + top-level `await import` harness pattern (the
  klinecharts enum load-time gotcha noted in `ma-slope-indicator` / `pivotBands.test.ts`).
- **Manual / browser:** enable threshold → both lines appear symmetric about zero
  and the pane rescales to keep them visible; drag one line → both mirror and the
  level updates; edit Level in settings → lines move; reload → threshold persists;
  disable → lines gone and pane rescales to slope data.

## Out of scope (explicit)

- Rule / alert / backtest operand wiring (visual-only for now).
- Independent (non-symmetric) upper/lower levels.
- Per-line thresholds (one shared pair across all slope lines in the pane).
