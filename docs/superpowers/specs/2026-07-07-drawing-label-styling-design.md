# Drawing label styling + position options

**Date:** 2026-07-07
**Scope:** Trend-line family only — `segment`, `rayLine`, `straightLine`.

## Problem

Trend-line drawings can carry a text label (`DrawingExtra.text`), rendered by the
custom overlays in `frontend/src/lib/customOverlays.ts` (`decorations()`). Today the
label is fixed: blue `#2962ff`, 12px, always centered above the line's midpoint. It
offers no styling or positioning, and (before the accompanying fix) it inherited
klinecharts' default blue text-box, making blue text unreadable on a blue box.

The other five drawing types (horizontal/vertical/price lines, parallel channel, fib)
are unmodified klinecharts built-ins with no label support — **out of scope** here.

## Goal

Give trend-line labels TradingView-style controls:

- **Styling:** text color, font size, bold, italic, optional background box (on/off + color).
- **Position:** preset anchors — *along the line* (start / middle / end) × *offset*
  (above / on / below).

## Data model

Extend `DrawingExtra` (in `frontend/src/lib/overlays.ts`). `text` (the content) is
unchanged; a new nested object carries appearance + placement:

```ts
export interface LabelStyle {
  color?: string;   // default = the drawing's line color
  size?: number;    // px, default 12
  bold?: boolean;
  italic?: boolean;
  box?: boolean;     // background box behind the text, default false
  boxColor?: string; // used only when box === true; default "rgba(20,23,34,0.85)"
  along?: "start" | "middle" | "end";  // default "middle"
  side?: "above" | "on" | "below";     // default "above"
}

interface DrawingExtra {
  // ...existing fields...
  text?: string;
  showMiddle?: boolean;
  labelStyle?: LabelStyle;   // NEW
}
```

`extendData` is persisted wholesale (`persist()` writes `extendData: ov.extendData`,
`rehydrate` reads it back), so no migration is needed. Absent fields fall back to the
defaults above — every default reproduces today's rendering as closely as possible
(blue-ish inherited color, 12px, above-middle), so existing labels don't jump.

## Rendering — `customOverlays.ts`

`decorations()` builds the label text figure. Two **pure, exported helpers** carry the
logic so they're unit-testable in isolation:

- `labelWeight(bold: boolean, italic: boolean): string`
  Returns the canvas font-weight token: `"italic bold"` | `"italic"` | `"bold"` |
  `"normal"`. Italic rides in the weight slot because klinecharts' text figure has no
  italic field; the CSS font shorthand (`font-style font-weight size family`) accepts
  `italic bold 12px …`, and klinecharts composes `ctx.font` as `${weight} ${size}px ${family}`.

- `labelPlacement(a, b, along, side, size): { x: number; y: number; baseline: "top" | "middle" | "bottom" }`
  `along`: `start → a`, `middle → midpoint(a,b)`, `end → b` (picks the anchor x/y).
  `side`: `above → baseline "bottom", y = anchorY - 6`; `on → baseline "middle",
  y = anchorY`; `below → baseline "top", y = anchorY + 6`. `align` is always `"center"`.

The text figure's styles:

- `color`: `labelStyle.color ?? overlay line color ?? "#2962ff"`.
- `size`: `labelStyle.size ?? 12`; `weight`: `labelWeight(...)`; fixed `family`.
- Box **off** (default): `backgroundColor` / `borderColor` `"transparent"`, zero border
  + padding — the readability fix; the label is plain text on the chart.
- Box **on**: `backgroundColor = boxColor`, small `borderRadius` (~3) and padding
  (~4/2), `borderColor` transparent — a filled pill behind the text.

The midpoint marker (`showMiddle`) is untouched.

## UI — `DrawingSettings.tsx` (Text tab, trend lines only)

Below the existing **Label** input and **Show midpoint marker** checkbox, add three
rows, always visible (they simply have no visible effect until text is entered):

1. **Text style:** color swatch (`ColorLineStylePicker`, color-only) · size **preset
   dropdown** (10 / 12 / 14 / 18 / 24 px) · **B** toggle · **I** toggle.
2. **Background:** "Show box" checkbox + color swatch (with opacity), the swatch
   enabled only when the box is on.
3. **Placement:** "Along line" select (Start / Middle / End) + "Offset" select
   (Above / On / Below).

The modal holds a single `label: LabelStyle` state object; each control writes the
whole updated object through one handler. `cancel()` restores the original label style
(alongside the existing style/points/visible/text restore).

## Plumbing — `OverlayManager`

Add one method, mirroring `setText` / `setShowMiddle`:

```ts
setLabelStyle(id: string, next: LabelStyle): void
```

Merges `next` into `extendData.labelStyle`, calls `overrideOverlay` (which re-runs
`createPointFigures`, repainting live), and `persist()`. Restore-on-cancel passes the
original object (or `{}` when there was none).

## Defaults / templates — `persist.ts` + config helpers

Add `labelStyle?: LabelStyle` to `SavedDrawingConfig` so the existing "Defaults" menu
(Save as default / named templates) captures the label **appearance and placement**
(not the text content, which is per-drawing). Touches:

- `getDrawingConfig` — read `labelStyle` off the live overlay's extendData.
- `applyDrawingConfig` — write it back via `setLabelStyle`.
- `seedFromDefault` — seed a fresh drawing's `extendData.labelStyle` from the default.
- `applyConfigHere` (modal) — refresh local `label` state when a config is applied.

## Testing

- Unit tests for `labelWeight` (all four bold/italic combinations) and
  `labelPlacement` (each `along` × `side`, checking anchor x/y and baseline).
- Extend the existing `DrawingSettings` test (if present) to cover the new controls
  writing through `setLabelStyle` and that `cancel()` restores the label style.

## Non-goals

- Label support on the other five drawing types.
- Free-drag label positioning (preset anchors only).
- Per-label font family choice.
