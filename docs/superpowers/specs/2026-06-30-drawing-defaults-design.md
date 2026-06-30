# Drawing defaults + templates

**Date:** 2026-06-30
**Status:** Approved design, pre-implementation

## Goal

Give drawing tools the same "set as default" + named-templates capability that
indicators already have. A user tunes a drawing's style once, saves it as the
default, and every new drawing of that type is created with those settings.
Named templates let them keep several saved looks per type and apply on demand.

This is the first of two independent pieces of work the user asked for; the
second — adding more drawing *tools* (Rectangle, Circle, etc.) — is deferred to a
later round.

## Scope

- A per-type **default** that auto-seeds freshly drawn shapes.
- Per-type **named templates** applied on demand from a footer dropdown.
- Works on the 8 existing line tools (the only drawings that exist today).
- A "Defaults ▾" dropdown in the drawing settings modal, mirroring the indicator
  settings modal.

Out of scope: new shape tools; any change to indicator defaults; saving a
drawing's text content or coordinates into a reusable default.

## Key concept: defaults are per drawing TYPE

The "type" is the klinecharts overlay **name** (`segment`, `rayLine`,
`straightLine`, `horizontalStraightLine`, `verticalStraightLine`, `priceLine`,
`priceChannelLine`, `fibonacciLine`). A default saved on a segment only seeds new
segments; rays, trend lines, and fibs keep their own independent defaults. Named
templates are scoped the same way — a template saved on a segment only appears in
the menu while editing a segment. This is exact parity with the indicator
defaults (keyed by indicator type) and with TradingView.

### Why "extend" is not a saved field

The user picked "Style + appearance flags," whose description listed extend mode.
But in this app the trend-line family is split into three *separate tools* by
extend behavior:

- `segment` — line between two points, no extend
- `rayLine` — extends off one end
- `straightLine` — extends off both ends

Changing "Extend" in the modal morphs the overlay into a different one of those
three (its klinecharts name changes — see `overlays.setExtend`). So extend is not
a stored property; it is fully determined by **which of the three tools you save
the default under**. A default saved on an extended line attaches to
`straightLine`; a fresh Trend-line draw seeds from it. The net effect matches what
the user wants with no redundant flag.

Everything else is stored: line color, width, dash style, midpoint marker,
price-axis label, and the visible-intervals allow-list. The drawing's **text
content** and **coordinates** are excluded (position- and instance-specific).

## What gets stored: `SavedDrawingConfig`

```ts
export interface SavedDrawingConfig {
  line?: { color?: string; size?: number; style?: LineType };
  showMiddle?: boolean;        // midpoint marker (trend family only)
  priceLabels?: boolean;       // y-axis value tag
  intervals?: string[] | null; // visible-intervals allow-list (null = all)
}
```

Not included: `text` (content), `userVisible` (a new draw is always visible),
points/coordinates, and extend (captured by the type key as above).

## Components

### 1. Storage — `frontend/src/lib/persist.ts`

Add a drawing analogue of the indicator default/preset block
(`persist.ts:815-864`), keyed by overlay name. Same two-layer shape, **mirrored to
the backend identically** (`save()` for writes, `mirrorDelete()` for clears — do
not skip the mirror; it is easy to miss when copying the indicator block).

```
${PREFIX}.drawingDefault.<name>   →  loadDrawingDefault / saveDrawingDefault / clearDrawingDefault
${PREFIX}.drawingPresets.<name>   →  loadDrawingPresets / saveDrawingPreset / deleteDrawingPreset
```

- `loadDrawingDefault(name): SavedDrawingConfig | null`
- `saveDrawingDefault(name, cfg)`
- `clearDrawingDefault(name)` — `localStorage.removeItem` + `mirrorDelete`
- `loadDrawingPresets(name): Record<string, SavedDrawingConfig>`
- `saveDrawingPreset(name, presetName, cfg)`
- `deleteDrawingPreset(name, presetName)`

Global (not per-cell, not per-symbol) — a personal preference, like the indicator
defaults.

### 2. Seeding new draws — `frontend/src/lib/overlays.ts`

`addDrawing(name)` (overlays.ts:682) is the **interactive-draw path only**;
rehydrate, paste, and clone go through `placeDrawing` / the restore path
(~overlays.ts:1113). So seeding here touches only freshly drawn shapes and needs
**no rehydrate guard** (simpler than the indicator path).

Change: `addDrawing` looks up `loadDrawingDefault(name)` and, if present, passes
its `styles` (`{ line: cfg.line }`) and an `extendData` built from
`{ showMiddle, priceLabels, intervals }` into the `create()` call, so the shape
previews in the default style while being drawn.

**Verification step for the plan:** confirm klinecharts applies `styles` /
`extendData` to an in-progress (point-less) interactive overlay. If it does not
preview correctly, fall back to applying the default on `onDrawEnd` (where the
interactive draw already persists). The plan must state which path was used.

A `SavedDrawingConfig → {styles, extendData}` adapter (and its inverse, reading a
live overlay into a `SavedDrawingConfig`) lives near the existing `asDrawingExtra`
helper so both the modal and `addDrawing` share one mapping.

### 3. UI — `frontend/src/DrawingSettings.tsx`

Add a "Defaults ▾" dropdown pinned bottom-left of the modal footer
(`DrawingSettings.tsx:376-382`), mirroring the indicator menu
(`IndicatorSettings.tsx:1914-1987`). Menu items:

- **Reset settings** — apply this type's default to the open drawing.
- **Save as default** — read the **live overlay** via `overlays.getDrawing(curId)`
  (not stale React state), build a `SavedDrawingConfig`, `saveDrawingDefault(name, …)`.
  Reading the live overlay is what makes the extend-via-key model correct: an
  extended line resolves to name `straightLine` and saves under that key.
- **Clear default** — shown only when a default exists.
- **Named templates list** — each applies on click, with a ✕ to delete.
- **Save as preset…** — inline name field.

Applying a default/template to the open drawing reuses the existing setters
(`overlays.setStyle / setShowMiddle / setPriceLabels / setVisibleIntervals` on
`curId`). No recreate is needed — a template never changes the overlay name
(templates are name-keyed, so applying one stays within the same type).

## Data flow

```
Draw a new segment
  → Toolbar.addDrawing("segment")
  → overlays.addDrawing("segment")
  → loadDrawingDefault("segment")  →  styles + extendData into create()
  → shape drawn in default style, persists on onDrawEnd

Edit a drawing → "Defaults ▾" → "Save as default"
  → read overlays.getDrawing(curId)  →  SavedDrawingConfig
  → saveDrawingDefault(curId.name, cfg)  →  localStorage + backend mirror

Edit a drawing → "Defaults ▾" → pick template "Fast red"
  → loadDrawingPresets(name)["Fast red"]
  → overlays.setStyle/setShowMiddle/setPriceLabels/setVisibleIntervals(curId, …)
```

## Error handling

- Missing/old default (no extendData) → all-defaults, same as a drawing with no
  saved config today. `asDrawingExtra` already narrows non-objects to `{}`.
- Persist failures are non-fatal (matches existing `clear*` try/catch).
- Deleting a template that is gone is a no-op (matches `deleteIndicatorPreset`).

## Testing

- Set a segment default (blue, dashed, width 2); draw a new segment → it appears
  blue/dashed/2; draw a new ray → unaffected.
- Save default on an extended line → stored under `straightLine`; new Trend-line
  draw seeds from it; new Segment draw does not.
- Save, apply, and delete a named template; confirm scoping to the same type.
- Reload the page → default and templates persist (backend mirror).
- Existing/rehydrated drawings are byte-identical after the change (no seeding on
  the restore path).

## Open implementation checks (resolve in the plan, not the design)

1. Confirm klinecharts honors `styles`/`extendData` on an in-progress interactive
   overlay; else use the `onDrawEnd` fallback.
2. Confirm `addDrawing` is the only interactive-draw entry point and that
   rehydrate/paste/clone do not route through it.
