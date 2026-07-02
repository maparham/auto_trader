# Drawing tools: left sidebar, favorites, and expanded tool set

Date: 2026-07-02
Status: approved (brainstorm w/ user)

## Goal

Replace the flat top-toolbar drawing dropdown with a TradingView-style left
sidebar, add a favorites system, and grow the tool set from 8 tools to the
full TV Lines/Channels/Annotations/Fib families — phased so each step lands
usable on its own.

Prompted by the TV drawing-menu screenshot (Lines + Channels sections, star
favorites, per-tool glyphs). The related "Don't extend changes the slope" bug
was root-caused and fixed separately (commit `faffacb`: `setExtend`/
`getDrawing` dropped `dataIndex`, teleporting future-whitespace anchors to
x=0 on recreate).

## 1. Left sidebar

A slim vertical strip (~38 px wide, light-first, no shadows, content-sized)
on the left edge of each **tab**, spanning all chart cells — one sidebar per
tab, like TV. A tool draws into whichever cell the user clicks.

Top → bottom:

1. **Favorites zone** — starred tools as direct one-click buttons (hidden/
   empty until something is starred).
2. **Family buttons** — Lines, Channels, Fib/Projections, Annotations.
   - Clicking the button activates the family's **last-used** tool; the
     button's icon is that tool's glyph.
   - A small corner-caret (visible on hover) opens the family **flyout** to
     pick a different variant (TV behavior).
3. **Measure** and **magnet** — moved here from the top toolbar.
4. **Bottom cluster** (acts on the focused cell):
   - Hide all drawings (eye toggle)
   - Lock all drawings
   - Delete all drawings (with confirm)

The old top-toolbar drawing dropdown is **removed** (no legacy fallback).

## 2. Flyouts, favorites, glyphs

- Flyout panel matches the indicator-dropdown idiom: section headers, rows,
  dismiss on outside click.
- Each row: **tool glyph (mini SVG depicting the tool, like TV)** + label +
  **star on hover** to favorite. The same glyph set drives the sidebar family
  buttons and the favorites zone.
- Favorites are stored **globally** (same storage idiom as indicator
  favorites), not per tab/layout. Last-used-per-family is device-local.
- No keyboard shortcuts for now (deferred).

## 3. Tool inventory and build order

Phased; each phase ships independently.

### Phase 1 — sidebar + favorites (existing 8 tools regrouped)

No new overlays. TV-parity naming: "Trend line" = `segment` (2-point,
extendable via settings as today); "Extended line" = `straightLine`;
"Ray" = `rayLine`.

### Phase 2 — cheap Lines variants

- **Horizontal ray**, **vertical ray/segment** — klinecharts built-ins
  (`horizontalRayLine`, `horizontalSegment`, `verticalRayLine`,
  `verticalSegment`; confirm exact names against `getSupportedOverlays()`).
- **Crossline** — H+V line through one point; tiny custom overlay.
- **Info line** — trendline + pill showing Δprice / % / bars / angle;
  reuses the measure tool's math.
- **Trend angle** — trendline + angle arc + degree label.

### Phase 3 — Channels (3-point custom overlays, translucent fill)

- Improve **Parallel channel**: fill + optional midline + extend.
- **Flat top/bottom**.
- **Disjoint channel**.
- **Regression trend** — linear regression + ±σ bands over the anchored
  range (needs candle data access in the overlay figure builder).

### Phase 4 — Annotations

Standalone **Text**, **Arrow**, **Callout/Note**, **Price label**.

### Phase 5 — Fib / Projections

- **Fib extension** (3-point).
- Editable fib levels on the existing retracement.
- **Long/Short position tool** — entry/SL/TP risk-reward box. Designed so a
  later task can hand it off to the paper executor as a real bracket; that
  hookup is out of scope here.

All new overlays follow the `customOverlays.ts` pattern (registered names,
config on `extendData`), so persistence, clipboard, clone, per-interval
visibility, and the settings modal come along via existing `SavedOverlay`
plumbing. `DrawingSettings.tsx` grows per-type sections only where needed
(channel fill color, fib levels, position-tool sizes).

## 4. Deferred / noted

- **Future-anchor persistence**: endpoints past the last candle still snap
  wrong on save/reload — a future point cannot round-trip through timestamp
  (klinecharts snaps future timestamps to the last bar). Needs a
  bars-past-end representation in `SavedOverlay`. Follow-up task.
- Keyboard shortcuts (⌥T etc.), Gann fan, floating favorites toolbar.

## 5. Testing

- Unit tests in `overlays.test.ts` for new overlay state paths.
- Playwright probes in `scripts/verify-drawings.mjs`: draw each new tool,
  assert figures paint (pixel-diff idiom) + persist round-trip.
- e2e for the sidebar favorites/star flow, mirroring the indicator-menu e2e.
