# Time Highlight indicator — design

**Date:** 2026-07-09
**Status:** approved

## Goal

A chart indicator that highlights candles falling inside user-defined
time-of-day windows, interpreted in the device's current timezone. Example:
shade every bar between 09:00 and 11:00 local time so the user can see at a
glance which candles printed during their trading hours.

## Decisions (from brainstorming)

- **Visual style:** configurable per window — translucent background band,
  recolored candles, or both.
- **Windows:** multiple per indicator instance (a list, like the Sessions
  indicator's session list), each independently configurable.
- **Timezone:** always the device's local timezone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`); no per-window zone
  picker. If the OS timezone changes, highlights shift with it — accepted.
- **Day-of-week filter:** none. A window applies every day its time-of-day
  matches.

## Architecture

A new figure-less custom indicator template `TIME_HIGHLIGHT`, modeled on
`SESSIONS_TEMPLATE`, but attached to the **main candle pane** (stacked, like
EMA overlays) instead of a sub-pane.

- **File:** `frontend/src/lib/indicators/timeHighlight.ts`
- **Registration:** added to `customIndicators.ts` (`CUSTOM_TEMPLATES`,
  indicator type union) and the indicator menu metadata so it appears in the
  Indicators dropdown as **"Time Highlight"**.
- **Rendering:** `calc` computes per-bar window membership onto
  `indicator.result`; `draw` paints in pure pixel space and returns `true`
  (isCover) so klinecharts draws no default figures.

## Config shape (`extendData.windows`)

```ts
export interface TimeWindowDef {
  id: string;
  color: string;
  from: string;   // "HH:MM" device-local
  to: string;     // "HH:MM"; to <= from wraps past local midnight
  mode: "band" | "candles" | "both";
  enabled: boolean;
}
```

Default: one window `{ from: "09:00", to: "17:00", mode: "band" }` in a soft
blue.

## Time math

Reuse the existing DST-safe helpers exported by
`frontend/src/lib/indicators/sessions.ts` — `localTimeToUtc` (memoized
per zone/date/HH:MM) — with the device zone. A bar is inside a window when its
open timestamp `ts` satisfies:

- normal window (`to > from`): `fromUtc <= ts < toUtc`
- wrapping window (`to <= from`): `ts >= fromUtc || ts < toUtc`, both resolved
  on the bar's own local date (same rule as `sessionActiveAt`).

## Drawing

- **Band mode:** collapse consecutive in-window bars into segments (reuse
  `buildSegments`-style logic per window); fill each segment's span
  (± half a bar width at the edges) full pane height with the window color at
  low alpha (~12%).
- **Candles mode:** for each in-window bar, redraw its wick (1px line
  high→low) and body (open→close rect) in the window color, opaque, on top of
  the original candle. One color per window regardless of direction — up/down
  stays readable from the candle shape.
- **Both:** band first, then candles.
- **Overlaps:** windows paint in list order; later windows paint over earlier
  ones. No stripe-splitting (unlike Sessions).

## Settings modal

Mirror the Sessions editor in the indicator settings modal: one row per
window with from/to time inputs, shared `ColorLineStylePicker` for color,
mode dropdown (Band / Candles / Both), enable checkbox, and add/remove-row
controls. Legend shows the indicator name only (`hideLegendValue`, like
Sessions).

## Persistence

Nothing new: the indicator persists through the existing per-cell indicator
persistence (`extendData` round-trips like Sessions' session list). Indicator
defaults/presets machinery applies automatically.

## Testing

- **Unit (`timeHighlight.test.ts`):** membership function — normal window,
  midnight-wrap window, DST transition day, disabled window, multiple
  overlapping windows; segment collapsing.
- **Manual:** add the indicator in the browser, verify band + recolor + both
  modes render, survive TF switches and pan/zoom, and the settings modal
  edits round-trip.

## Out of scope

- Per-window timezone picker (device-local only).
- Day-of-week filters.
- Using the highlight as a backtest/rule operand (SESSIONS-style operand is
  already deferred; same applies here).
