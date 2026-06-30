# Per-Timeframe Visibility + Auto-Hide for Indicators & Drawings

**Date:** 2026-06-30
**Status:** Design approved, ready for implementation plan

## Problem

TradingView lets you control on which timeframes a drawing or indicator appears (its
"Visibility" tab — a per-time-unit grid with min/max ranges). In this app:

- **Drawings** already have a per-interval Visibility tab, but as a *discrete checkbox
  grid* (`DrawingSettings.tsx`), not the TV range-slider model.
- **Indicators** have only a single "Show on chart" checkbox (`IndicatorSettings.tsx`).

We also want an **auto-hide** behavior: when an object becomes too small to be usable on
the current timeframe, hide it automatically.

## Goals

1. Replace the indicator Visibility tab and upgrade the drawing Visibility tab to a single,
   shared **TV range-slider model** (unit row + enable checkbox + min/max range).
2. Add per-object **auto-hide** driven by **visible-bar count** (hide when the object spans
   fewer than N visible bars at the current timeframe; N user-set, default 3).
3. Do this with shared, independently-testable units so drawings and indicators behave
   identically.

## Non-Goals

- Pixel-span / value-range "dwarfed" heuristics (rejected in favor of bar-count).
- Auto-hide for full-width indicators (MA/RSI/MACD) — bar-count can never fire for them.
- Rendering TV unit rows the app has no intervals for (Ticks, Months, Ranges).

## Key Decisions (settled with the user)

| Decision | Choice |
|---|---|
| UI model | TV range-slider (unit + enable + min/max), upgrade **both** drawings and indicators |
| Auto-hide heuristic | Visible-bar count, **interval-driven** (not zoom/pan) |
| Auto-hide threshold | Per-object number `N`, default 3 |
| Auto-hide scope | **Finite-extent objects only**: all drawings + *anchored* indicators (AVWAP-style). Full-width indicators don't get the toggle. |
| Unit rows shown | Only units the app has intervals for: **Seconds, Minutes, Hours, Days, Weeks**. Omit Ticks/Months/Ranges. |
| Defaults | All units `on`, full ranges, auto-hide off — exactly reproduces today's "show on all intervals". |
| Hidden-drawing reachability | Hidden drawings render as a faint, clickable **ghost stub** (no object-list panel exists to reach them otherwise). |

## Architecture

Two new shared units, consumed in four places.

### `lib/visibility.ts` (new — framework-free, unit-tested)

```ts
type Unit = "seconds" | "minutes" | "hours" | "days" | "weeks";

interface UnitVisibility { on: boolean; min: number; max: number; }

interface VisibilityModel {
  units: Partial<Record<Unit, UnitVisibility>>;
  autoHide?: { on: boolean; minBars: number };
}

// Supported unit rows + TV slider bounds.
const VISIBILITY_UNITS: { unit: Unit; label: string; max: number }[] = [
  { unit: "seconds", label: "Seconds", max: 59 },
  { unit: "minutes", label: "Minutes", max: 59 },
  { unit: "hours",   label: "Hours",   max: 24 },
  { unit: "days",    label: "Days",    max: 366 },
  { unit: "weeks",   label: "Weeks",   max: 52 },
];

function defaultVisibility(): VisibilityModel;            // all units on, full range, autoHide off
function parseResolution(res: string): { unit: Unit; value: number };  // "MINUTE_15" -> {minutes,15}
function isVisibleOnResolution(m: VisibilityModel, res: string): boolean;
function barsSpanned(t1: number, t2: number, res: string): number;     // |t2-t1| / RESOLUTION_SECONDS[res]
function migrateIntervals(intervals: string[] | null): VisibilityModel; // back-compat for drawings
```

**Visibility rule:** object shown on `res` iff the unit's row is `on` AND
`min ≤ value ≤ max`. Unknown resolution → fail-open (visible).

**`parseResolution`** derives unit from the resolution prefix (`SECOND`/`MINUTE`/`HOUR`/
`DAY`/`WEEK`) and value from the numeric suffix (default 1: `"MINUTE"` → value 1,
`"HOUR_4"` → value 4). Source of truth for the resolution set is `lib/feed.ts`.

### `VisibilityTab.tsx` (new — shared React component)

Renders the unit grid (per row: enable checkbox, min number input, dual range slider, max
number input) plus the auto-hide row. Props:

```ts
{ model: VisibilityModel; onChange(next: VisibilityModel): void; showAutoHide: boolean }
```

- Min/max inputs clamp to `1..VISIBILITY_UNITS.max` and enforce `min ≤ max`.
- Disabled (greyed) inputs when a unit's checkbox is off — matching the screenshot.
- Auto-hide row: checkbox "Auto-hide when fewer than [N] visible bars", N number input.
  Hidden entirely when `showAutoHide` is false.

Consumed by `DrawingSettings.tsx` and `IndicatorSettings.tsx`.

## Data Flow

```
VisibilityTab onChange(model)
   ├─ DrawingSettings  → overlays.setVisibilityModel(id, model)  → persist (extendData.visibility)
   └─ IndicatorSettings → apply({ extendData: { ...visibility } }) → persist (SavedIndicatorConfig.extendData)

Period change (ChartCore period-change effect)
   ├─ overlays.setResolution(res)              → recompute drawing effectiveVisible
   └─ applyIndicatorIntervalVisibility(chart, res) → recompute indicator visible (all panes)
```

### Drawings — `lib/overlays.ts` (OverlayManager)

- Replace `DrawingExtra.intervals` with `DrawingExtra.visibility: VisibilityModel`.
  Keep `userVisible` (user intent) untouched by interval/auto-hide logic.
- `effectiveVisible(ov)` =
  `userVisible AND isVisibleOnResolution(visibility, this.resolution) AND NOT(autoHide && barsSpanned(p1,p2,this.resolution) < minBars)`.
- `setVisibilityModel(id, model)` replaces `setVisibleIntervals`.
- `setResolution(res)` re-derives every drawing's `visible` (existing path).
- **Migration on rehydrate:** if `extendData.visibility` absent but legacy `intervals`
  present → `migrateIntervals(intervals)`; if both absent → `defaultVisibility()`.
- **Ghost stub:** when `effectiveVisible` is false *due to interval/auto-hide* (not
  user-hidden), render the overlay at low opacity and keep it hittable/selectable instead
  of `visible:false`, so it can be clicked to reopen settings. Exact opacity/treatment
  finalized in implementation. User-hidden (`userVisible:false`) drawings hide fully.

### Indicators — `lib/indicators.ts`

- Store `visibility: VisibilityModel` in indicator `extendData`; round-trips through the
  existing `applyIndicator()` and `SavedIndicatorConfig.extendData`.
- New `applyIndicatorIntervalVisibility(chart, res)`: iterate **all panes** — candle_pane
  plus every sub-pane (Volume/MACD/RSI) — and `overrideIndicator({ name, visible }, paneId)`
  using `isVisibleOnResolution`. Called from ChartCore's period-change effect next to
  `overlays.setResolution`.
- Auto-hide for indicators applies **only to anchored** indicators (finite extent, e.g.
  AVWAP); `VisibilityTab` receives `showAutoHide` accordingly. Full-width indicators never
  get the toggle. Indicators stay reachable via the DOM legend even when hidden, so no ghost
  stub is needed for them.

## Persistence

- **Drawings:** `SavedOverlay.extendData.visibility` (replaces `intervals`); `userVisible`
  unchanged. Legacy `intervals` migrated on load, then written in the new shape.
- **Indicators:** `SavedIndicatorConfig.extendData.visibility`. Modal `currentConfig()`
  includes it; saved on every change via the existing save effect.

## Edge Cases

- Unknown / unmapped resolution → visible (fail-open).
- `min > max` → prevented in UI (clamped). If it ever occurs in data, treat as hidden for
  that unit.
- Auto-hide N large enough to hide everything → allowed; object restores when the timeframe
  makes it span ≥ N bars again. `userVisible` is never mutated, so it's recoverable.
- Auto-hide only re-evaluates on **interval change** (an object's bar-span is independent of
  zoom/pan), so no per-frame cost.

## Testing

- **`lib/visibility.ts` unit tests:**
  - `isVisibleOnResolution` across all native resolutions (5s,1m,5m,15m,30m,1h,4h,1D,1W) ×
    representative unit configs.
  - `barsSpanned` math for several spans/resolutions.
  - `migrateIntervals` round-trip (legacy array → model → same visible set).
  - `defaultVisibility()` is visible on every resolution (reproduces null=all).
- **`VisibilityTab` interaction test:** toggle a unit, drag/clamp min/max, toggle auto-hide
  + edit N → emits expected model.
- **Integration:** OverlayManager `effectiveVisible` flips correctly on `setResolution`
  (incl. auto-hide and ghost-stub branch); `applyIndicatorIntervalVisibility` toggles an
  indicator across panes on period change.
- e2e (per project convention) must stub `/api/state`.

## Open Implementation Details (decide while building, not blocking)

- Exact ghost-stub visual (opacity, whether label hides).
- Dual-range-slider component: reuse an existing slider if present, else a minimal custom one.
- Whether anchored-vs-full-width is detected via `indicatorMeta` or an explicit flag.
