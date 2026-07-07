# Fib retracement tool — TV-style overhaul (design)

Date: 2026-07-07
Status: approved

## Problem

The Fib tool is klinecharts' built-in `fibonacciLine` overlay. It hard-codes the
7 classic levels and draws every level line across the FULL chart width
(`x=0 → bounding.width`), so one fib drawing swallows the whole view. TV draws
each level only between the two anchors, with an Extend option and a rich,
per-level settings panel.

Scope decision: **Core TV parity** — anchored spans + Extend, editable level
list (toggle / value / per-level color), level+price labels, trend line toggle,
Reverse. Explicitly out of scope this pass: background gradient fill,
"use one color", label position dropdowns, prices/values mode split, font size,
log-scale levels.

## Approach

Override the built-in by re-registering the same name (`fibonacciLine`) in
`frontend/src/lib/customOverlays.ts` — the proven pattern used for
`segment`/`rayLine`/`straightLine`/`rect`. Same name ⇒ zero changes to
persistence, drawTools, chart-operand code; already-saved fibs simply render
with the new defaults (a bug fix, no migration — none wanted).

## Rendering

- Each **enabled** level paints a horizontal line spanning the two anchors'
  x-range only. `extend` widens that span to the pane edge(s):
  `"none" | "left" | "right" | "both"` (default `none`).
- Level y interpolates between anchor y's: `y = y1 + (y0 − y1) × level`
  (levels outside [0,1] extrapolate naturally). `reverse: true` swaps which
  anchor is level 0 vs level 1.
- Optional dashed **trend line** connecting the two anchors (default on).
- Per-level **label** `"<ratio> (<price>)"` (price at the drawing's precision)
  rendered at the **right end** of the level span, above the line
  (matches the user's TV reference). Toggleable via `labels` (default on).
- Line **width + solid/dashed** come from the overlay's `styles.line`
  (shared across levels, edited by the existing Line control); **color** is
  per-level.
- Keeps `needDefaultPointFigure/XAxis/YAxis` so anchor handles + axis tags
  behave like every other drawing.

## Config & persistence

New `fib` object inside the drawing's `extendData` (`DrawingExtra`), next to
`text`/`showMiddle`/`visibility` — all of which already persist and flow
through drawing defaults/templates:

```ts
interface FibLevel { value: number; enabled: boolean; color: string }
interface FibConfig {
  levels: FibLevel[];
  extend: "none" | "left" | "right" | "both"; // default "none"
  reverse: boolean;                            // default false
  trendLine: boolean;                          // default true
  labels: boolean;                             // default true
}
```

Default levels: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1 enabled (TV-ish palette:
0/1 strong, mid levels distinct muted hues), plus 1.618, 2.618, −0.236 present
but disabled. Values editable; rows can be added/removed (more flexible than
TV's fixed 24 slots, no wall of inputs).

A missing/partial `fib` in extendData resolves to defaults via an
`asFibConfig()` normalizer (same idiom as `asDrawingExtra`).

## Settings modal

`DrawingSettings.tsx` grows a fib branch on the **Style** tab:

- Two-column level grid: checkbox · value input · color swatch per row,
  ✕ to remove a row, "+ Add level" appends a disabled-by-default row.
- Extend dropdown, Trend line toggle, Reverse toggle, Labels toggle.
- All edits live-preview via a new `OverlayManager.setFibConfig(id, cfg)`
  (writes extendData like `setText`); Cancel restores the opening snapshot
  through the existing extendData restore path.
- `fib` joins `SavedDrawingConfig`, `getDrawingConfig`, `applyDrawingConfig`
  so **Defaults ▾ / named templates / reset** work unchanged.
- Text tab: not applicable to fib (keeps the existing "available on trend
  lines and rectangles" note). Coordinates & Visibility tabs work as-is.

## Testing

- Pure helper (e.g. `fibLevelSegments(cfg, coords, points, bounding)`) that
  returns per-level `{ y, x1, x2, label }` — unit-tested: interpolation,
  reverse, extend variants, disabled levels skipped, extrapolated levels.
- `asFibConfig` normalizer tests (missing / partial / bad input).
- Existing suites must stay green; manual chart verification for visuals.
