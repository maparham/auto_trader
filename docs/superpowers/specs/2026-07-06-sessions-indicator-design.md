# Sessions indicator — design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan

## Summary

A new custom sub-pane indicator, **Sessions**, that shades the FX trading
sessions (Sydney / Tokyo / London / New York by default) across the time axis in
a single compact pane — like a slim Volume pane. Overlapping sessions (e.g.
London + New York) are shown by **dynamically splitting** the row into stripes
only where the overlap occurs, so the pane stays one row tall while never hiding
a session. Sessions are DST-aware, follow their own exchange timezone, and are
fully editable (toggle, rename, recolor, retime, add/remove) via the existing
indicator settings modal.

Motivation: the user wants an at-a-glance session map (NY, Tokyo, London, …)
labelled at the bottom of the chart, without consuming much vertical space.

## Decisions (locked)

- **Layout:** single compact sub-pane (not a price overlay, not stacked lanes).
- **Overlap handling:** dynamic split — solo span = full pane height with the
  session name centered; overlap span = row split evenly among the active
  sessions as stripes, **no label** in the stripes (color + hover identify them).
- **Sessions:** FX big 4 by default, **editable** (add/remove/rename/recolor/
  retime/toggle). Not hardcoded.
- **Pane height:** fixed compact (~28 px), **not** user-resizable.
- **Timezone:** each session carries its own IANA timezone; membership is
  computed per bar and is DST-aware.

## Data model

One indicator instance holds a list of sessions on `extendData` (same
per-instance pattern as the Prev HL indicator's timezone override), so it
persists with layouts and symbol/indicator templates.

```ts
interface SessionDef {
  id: string;          // stable id (for settings-row identity + React keys)
  name: string;        // "New York"
  color: string;       // hex, e.g. "#f59300"
  timezone: string;    // IANA, e.g. "America/New_York" (from timezones.ts catalogue)
  open: string;        // "HH:MM" local exchange time
  close: string;       // "HH:MM" local exchange time (may be < open → crosses midnight)
  enabled: boolean;
}

interface SessionsExtend {
  sessions?: SessionDef[];   // defaults applied when absent
  hideLegendValue?: boolean; // mirror other indicators
}
```

**Defaults** (local exchange time):

| id      | name     | timezone            | open  | close | color    |
|---------|----------|---------------------|-------|-------|----------|
| sydney  | Sydney   | Australia/Sydney    | 07:00 | 16:00 | #7e57c2  |
| tokyo   | Tokyo    | Asia/Tokyo          | 09:00 | 18:00 | #16a394  |
| london  | London   | Europe/London       | 08:00 | 16:00 | #2962ff  |
| newyork | New York | America/New_York    | 08:00 | 17:00 | #f59300  |

(Colors are the mockup palette; final values can be nudged to sit well in both
light and dark themes.)

## Membership computation (`calc`)

For each bar in `dataList`, determine which enabled sessions are **active** at
that bar's timestamp:

1. For a session, convert its `open`/`close` local `HH:MM` to the actual UTC
   instants **for that bar's calendar day in the session's timezone** (DST-aware
   via `Intl.DateTimeFormat` / offset lookup, reusing helpers in
   `timezones.ts`). Handle `close <= open` as crossing midnight (the window
   spans into the next day — check both the current and previous day's window so
   a bar just after midnight still counts).
2. A bar is in-session if its timestamp falls in `[openUTC, closeUTC)`.
3. Store, per bar, the set of active session ids (a lightweight per-bar result
   object; non-figure fields, like RSI's `divs`, so klinecharts ignores them).

This per-bar approach makes weekends/holidays free: FX has no bars then, so
nothing draws; and it works on any timeframe (intraday shows fine detail, daily
collapses each bar to whichever session(s) its timestamp lands in).

Design the core as a pure function over `(dataList, sessions)` returning per-bar
active-id sets, plus a **segment builder** that collapses consecutive equal
active-sets into contiguous runs `{ startIndex, endIndex, activeIds[] }` — this
is what `draw` consumes and what unit tests assert against.

## Rendering (`draw` canvas callback)

Mirrors the RSI pattern (canvas draw over `indicator.result`, pane-local
`xAxis/yAxis.convertToPixel`, returns `false`). Because this pane has no
meaningful numeric scale, draw purely in pixel space using `bounding.width/height`.

For each contiguous segment with `k = activeIds.length`:
- Compute pixel x-range from the segment's start/end bar indices.
- Split the pane height into `k` equal horizontal stripes; fill stripe `i` with
  session `i`'s color.
- If `k === 1`, center the session name in the segment (skip if the segment is
  too narrow to fit the text).
- If `k > 1`, no text.

Ordering within a split: sessions ordered by their configured list order (stable),
so a given session tends to occupy a consistent stripe position within an overlap.

**Hover tooltip:** on hovering a band, show `name — open–close (local)` using the
shared `Tooltip` component. Implementation approach TBD in the plan (either a
DOM overlay hit-test like the backtest markers, or the legend/crosshair hook);
the plan should pick the lightest option consistent with existing panes.

## Pane configuration

- `series: IndicatorSeries.Normal` (sub-pane), **not** in `OVERLAY_INDICATORS`.
- No `figures` that produce a visible line/number; the visual is entirely the
  `draw` callback. Suppress the y-axis tick labels for this pane (fixed dummy
  range or pane options) so no stray numbers show.
- Fixed compact height, non-resizable: set the pane's height and disable its
  drag handle via klinecharts pane options. (Exact API — `setPaneOptions` with a
  fixed `height` and drag disabled — to be confirmed in the plan.)

## Settings modal

Extend the existing indicator settings modal with a Sessions editor:
- One row per session: enabled checkbox · name (text) · color (swatch) ·
  timezone (dropdown from `TIMEZONES`) · open (HH:MM) · close (HH:MM) · remove.
- "Add session" button (seeds a blank/near-blank row, e.g. Frankfurt).
- Writes back to `extendData.sessions`; recalculates on change.
- No global/app-level settings needed — everything is per-instance.

## Files

- `frontend/src/lib/indicators/sessions.ts` — template + `calc` (membership +
  segment builder) + `draw` (dynamic split). New module, mirrors `rsi.ts`.
- `frontend/src/lib/customIndicators.ts` — add `SESSIONS` to `CustomIndicatorType`,
  `BASE_TEMPLATES`, and re-export; leave out of `OVERLAY_INDICATORS`.
- `frontend/src/lib/indicatorMeta.ts` — add metadata (menu name, info tooltip).
- Indicator settings component — add the Sessions editor rows.
- `frontend/src/lib/indicators/sessions.test.ts` — unit tests.

## Testing

Unit (`sessions.test.ts`), asserting on the pure membership/segment functions:
- DST boundary: a session's UTC window shifts correctly across a DST change in
  its timezone (e.g. New York spring-forward / London BST).
- Midnight crossing: Sydney (crosses local midnight) marks bars on both sides
  correctly.
- Overlap segmentation: London + New York window produces a `k=2` segment with
  the right start/end indices; solo spans produce `k=1`.
- Empty/gap bars: no active session → no segment.
- Disabled session is excluded; reordering changes stripe order deterministically.

Rendering / settings verified via Playwright per the usual flow (add indicator,
see bands, open settings, toggle a session, add one).

## Out of scope (YAGNI)

- Session high/low or range levels drawn on the price pane.
- Killzones / custom sub-windows within a session.
- Volume-by-session statistics.
- Per-session alerts.

These can be layered later on the same data model if wanted.
