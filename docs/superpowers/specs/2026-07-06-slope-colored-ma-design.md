# Slope-colored moving averages — design

**Date:** 2026-07-06
**Status:** Approved, ready for implementation plan

## Problem

A moving average line is a single flat color, so its direction has to be read
off its geometry. Traders routinely gate on "is the MA rising or falling"; making
that direction *visible* on the curve itself — the line looks one way while
rising, another while falling — turns a read-the-slope task into a glance.

This is the **visual/rendering** counterpart of the rules-side slope feature
(`2026-07-06-slope-conditions-design.md`). The two share the *definition* of
slope but are otherwise independent: that one adds a slope operand to
backtest/live rules; this one colors the plotted curve. This spec touches only
charting code.

## Goal

For the app's moving averages — **EMA, SMA (`MA`), VWAP, AVWAP** — color/style the
**main line** by its slope state:

- **Rising** — slope above the flat band.
- **Falling** — slope below the flat band.
- **Flat** — slope within an adjustable ± band around zero (noise / no clear
  direction).

Each state's **color, line style (solid/dashed/dotted) and thickness** are
editable in the indicator's settings modal, per instance. The feature is opt-in
per indicator instance and, when off, changes nothing.

## Scope

- **In:** EMA, SMA/`MA`, VWAP, AVWAP. Only the **main** line is colored.
- **Out:** a smoothing line, AVWAP bands, RSI/LR and any non-MA indicator keep
  their existing styling untouched.
- Per **instance** (multi-instance indicators): each EMA instance colors
  independently, config stored on that instance.

## Slope definition (shared with the rules spec)

Slope is measured in **percent per bar** over a lookback of `N` bars, identical
to `slopeOf` in `backtestSeries.ts`:

```
slopePctPerBar[i] = (v[i] − v[i−N]) / |v[i−N]| / N × 100
```

where `v` is the **plotted** main-line value (i.e. after Source/Offset/Smoothing
and, for an MTF indicator, after HTF alignment — see below). Percent-per-bar is
portable across instruments so a flat-band default is meaningful on EUR/USD and
gold alike; `÷ N` keeps the band stable as the lookback changes.

**State mapping** with an adjustable symmetric flat band `flatBandPct` (in %/bar):

```
slope is undefined (warm-up: i < N, v[i]/v[i−N] missing, or v[i−N] == 0) → flat/base look
|slope| ≤ flatBandPct                                                    → flat
slope >  flatBandPct                                                      → rising
slope < −flatBandPct                                                      → falling
```

- **Lookback `N`** default `1` (bar-to-bar; most responsive), min 1, editable.
- **`flatBandPct`** default `0.1` (so ±0.1 %/bar reads as flat, per the user's
  example), min 0, editable. Setting it to 0 collapses the feature to pure
  rising/falling (2-state).

## Config (per instance, in `extendData.slopeColor`)

```ts
type SlopeStateStyle = {
  color: string;                        // hex
  size: number;                         // px line width
  style: "solid" | "dashed" | "dotted";
};

type SlopeColorConfig = {
  enabled: boolean;                     // default false — off changes nothing
  len: number;                          // lookback N, default 1, min 1
  flatBandPct: number;                  // ± flat band %/bar, default 0.1, min 0
  up: SlopeStateStyle;                  // rising  — theme default green
  down: SlopeStateStyle;                // falling — theme default red
  flat: SlopeStateStyle;                // neutral — theme default muted grey
};
```

- Persisted the same way other per-instance config is (`currentConfig()` writes
  config-only `extendData`, never the bulky MTF series arrays).
- Defaults are **theme-aware** (resolved against light/dark at apply time). Line
  widths default to the indicator's current main-line width; styles default to
  solid, so day-one the three states differ by color only until the user tweaks
  dash/width.
- Absent `slopeColor` (or `enabled: false`) ⇒ the indicator renders exactly as
  today.

## Rendering — custom `draw`, single continuous line

When `slopeColor.enabled`:

1. **Suppress the default main line.** The main line figure is rendered
   transparent / size-0 (via the styles passed to `overrideIndicator`), so
   klinecharts' own single-color stroke doesn't show. `calc` still returns the
   real main-line values, so **hover, legend and curve-end labels keep working**
   (one legend entry, one curve-end label — unchanged).

   > Note: the base figure being drawn transparent is the primary mechanism —
   > we do **not** rely on a `draw`-returns-true "skip default" contract, which
   > is unverified for line figures. The existing `draw` precedents (RSI
   > divergence, Sessions shading) *add* to default rendering rather than
   > replace it.

2. **Compute per-bar slope state** from the plotted values (see MTF below),
   yielding one of `rising | falling | flat` (or flat/base for warm-up) per bar.

3. **Stroke the polyline segment-by-segment** in the `draw` hook. Each segment
   `[i-1, i]` is styled (color + width + dash) by the state at its **newer
   endpoint** `i`. Consecutive same-state segments can be batched into one path
   for fewer stroke calls. Warm-up / undefined-slope bars use the **flat** look.

When `slopeColor.enabled` is false, no `draw` work happens and the figure is the
ordinary single-color line — zero cost and byte-for-byte the current behavior.

While enabled, the main line's ordinary **Style-tab color/width/dash is
superseded** by the three slope-state styles (its Style-tab row still edits the
smoothing line / other figures as before).

## MTF correctness (the trap)

For a higher-timeframe MA the plotted line is a forward-filled staircase (one HTF
value held across many base bars). Computing slope from that staircase would read
**flat within each HTF bar and spike at every boundary** — garbage.

Instead: **compute slope on the native HTF values, producing one state per HTF
bar, then forward-fill the *state* onto the chart bars** — using the same
`MaExtend.mtf.htfSeries` / `htfStarts` the MA already carries, with the same
no-lookahead (closed-bar) rule. This mirrors the "MTF trap" the rules spec calls
out. For a base-timeframe MA there's no HTF series and slope is taken directly on
the plotted per-bar values.

## Settings modal — a gated "Slope" tab

Add a **"Slope"** tab to `IndicatorSettings.tsx`, shown only for the four
supported indicators (gated the way the "Divergence" tab is gated to RSI). It
contains:

- **Enable** toggle (`ind-check`).
- **Lookback N** — integer input (`IntInput`), min 1.
- **Flat band ±** — number input in **%/bar** (with a `%/bar` hint next to it),
  min 0.
- **Three `ColorLineStylePicker` rows** — **Rising / Falling / Flat** — reusing
  the existing portaled picker for color + opacity + thickness + line-style.

No other modal changes. Slope coloring composes with the existing Inputs tab
(Source/Offset/Smoothing/Timeframe) and with per-instance multi-instance config.

## Defaults / UX

- Rising = green, Falling = red, Flat = muted grey (theme-resolved).
- Widths inherit the indicator's current main-line width; styles solid.
- The curve-end label and legend stay a single entry; they are **not** tinted to
  the live state in this version (see non-goals).

## Non-goals

- **Magnitude gradient** (color intensity scaled to |slope|) — a fixed 3-state
  palette only.
- **Angle-in-degrees** slope — chart/zoom dependent, ill-defined; %/bar only.
- Coloring the **smoothing line** or **AVWAP bands**.
- Tinting the **curve-end label / legend swatch** to the live slope state —
  possible follow-up, not in this version.
- Any change to the **rules-side** slope operand; the shared piece is only the
  %/bar definition, not the code.

## Testing

- **Slope→state mapping** (unit): rising / falling / flat around the band edges,
  warm-up (`i < N`) → flat/base, `v[i−N] == 0` → flat/base, `flatBandPct == 0`
  collapses to 2-state. Reuse/mirror the `slopeOf` numeric expectations.
- **MTF anti-regression** (unit): for an HTF MA, state is computed on native HTF
  values then forward-filled — assert it is **not** the "flat-within-bar,
  flip-at-boundary" staircase artifact (a steadily-rising HTF EMA is `rising`
  across the whole held span).
- **Config round-trip**: `slopeColor` persists through `extendData` save/restore;
  absent/`enabled:false` renders identically to today.
- **Rendering** is canvas pixel output — verify segment coloring via
  Playwright / manual visual check (not a unit test).
- Baseline to keep green: vitest, pytest, tsc (23 pre-existing tsc errors
  unrelated).
