# Backtest period shading — design

**Date:** 2026-07-05
**Status:** approved design, pending implementation plan

## Problem

A backtest runs over a **trading window** (`from → to`) and, optionally, a
**recurrence mask** that restricts trading to recurring active windows
(weekdays / months / a session or time-of-day band). Today the chart shows the
individual trade fills (markers) and the equity curve, but nothing shows *the
period(s) the strategy was allowed to trade in*. The user can't see, at a
glance, which stretch of the chart the backtest actually covered — or, with a
mask on, which recurring sessions were live.

## Goal

Shade the trading period(s) on the chart so they read at a glance, surviving
timeframe switches and reloads like the markers do, and never getting in the
way of the candles, markers, or the cursor's readouts.

## The rule (what gets shaded)

- **No mask** → one period: the single contiguous `from → to` window.
- **Mask on** → only the finer recurring active windows (each active session is
  its own period). **Never** a whole-window band underneath them.
- Periods are derived **only** from the configured window + mask — never from
  trade times (a window exists whether or not a trade fired in it).
- If a mask's active windows don't intersect the loaded bar range, **draw
  nothing** — no fallback to the whole-window band.
- The displayed window is **clamped to the loaded candle range**, so a relative
  window (e.g. last-year → now) never tints empty space past the last bar (same
  clamping discipline the marker code already uses).

## Visual treatment (settled via the interactive mockup)

**Band + axis, both faint**, drawn together:

1. A **faint full-height tint** over each period in the price pane — locates the
   period in price space. Neutral grey, low alpha (~0.06).
2. A **faint labeled chip on the time axis** under each period — names it (the
   session clock `09:30–16:00`, or the window's date span). Neutral grey,
   ~0.2 alpha so the label reads.

Neutral grey (`#59646f` family) is deliberate: it stays clear of the green/red
trade markers (`#26a69a` / `#ef5350`) and the blue trade/selection lines
(`#2962ff`) already on the chart, so an always-on layer doesn't compete.

An **on/off toggle** lets the user hide it entirely (see Toggle below).

## Rendering

Draw each computed period as a **klinecharts custom overlay** (the same family
as the existing `tradeZone` and `backtestMarker` overlays — created directly via
`chart.createOverlay`, so it's ephemeral and NOT persisted as a user drawing).
One overlay per period band.

- `createPointFigures` — a full-pane-height `rect` using `bounding.height` and
  the two time-anchored points' x-pixels, filled at the faint band alpha.
- `createXAxisFigures` — the faint chip + centered time label in the X-axis
  pane, natively anchored to the same time span. This is the idiomatic way to
  "draw on the time axis," and it pans/zooms with the axis for free.
- `lock: true` and every figure `ignoreEvent: true` — non-interactive, never
  intercepts clicks or the crosshair (same discipline as the marker/zone
  overlays).

Overlays (rather than the DOM-over-canvas layer used for the aggregate pills)
are the right choice **here** because: (a) rendering is non-interactive, so the
overlay-event unreliability that pushed the aggregate pills to DOM doesn't
apply; (b) `createXAxisFigures` gives us the axis chip natively; (c) klinecharts
re-projects the time-anchored points on every pan/zoom, so no manual
projection/redraw-loop plumbing is needed.

**Independent of `markerMode`.** Period bands are pure time spans and are valid
on every timeframe (native / finer / coarser), unlike markers. They render
whenever a result with a `period` is shown and the toggle is on — even when
markers are in `"none"` mode.

### Hard constraint: the cursor's timestamp pill stays visible

The time-axis timestamp pill that follows the cursor is klinecharts' native
crosshair x-axis label, drawn on the crosshair layer **above** the overlay layer
our axis chip lives on. So the chip cannot occlude it. The faint (~0.2 alpha)
grey chip is a second guarantee: the solid dark-on-light pill reads over it
regardless of layer order. This mirrors the `crosshair-label-vs-alert-tag`
discipline (the cursor readout is never hidden by chart chrome). **Verification
must confirm** the pill remains fully legible while hovering across an axis chip,
in both grey and (if ever chosen) blue.

## Data / persistence

`StoredBacktestResult` currently carries `trades / markers / equity / resolution`
but not the window or mask. Add an optional period descriptor so the shading
survives a timeframe switch and reload exactly like the markers:

```ts
interface BacktestPeriod {
  fromMs: number;
  toMs: number;
  mask?: RecurrenceMask; // RESOLVED (resolveMask output), omitted when disabled
}
// StoredBacktestResult gains: period?: BacktestPeriod
```

`BacktestButton.run` already computes `windowFromMs`, `windowToMs`, and the
resolved mask (`cfg.range.mask?.enabled ? resolveMask(...)`). Thread these into
`runAndRender` (new `period` argument), which attaches `period` to the result
before it saves and renders. Rehydrate reads it back off the saved result.

## Interval math (pure, tested) — new `lib/backtestPeriods.ts`

```ts
computePeriodBands(period: BacktestPeriod, barTimes: number[]): {fromMs, toMs}[]
```

- Clamp `[period.fromMs, period.toMs]` to `[barTimes[0], barTimes.at(-1)]`.
  Empty `barTimes` or a non-overlapping window → `[]`.
- **No mask** → `[[clampedFrom, clampedTo]]`.
- **Mask** → walk the clamped window day by day in the mask's timezone, emitting
  each active day's band, then **coalesce touching bands** into maximal
  contiguous periods (so a run of active days with no time-of-day filter reads as
  one multi-day block; a session filter keeps each day separate across the
  overnight gap).
  - Reuse `resolveMask` / `isActive` from `lib/backtestSchedule.ts` — the SAME
    functions the mask-preview heatstrip uses. Do **not** hand-roll a second
    DOW/month/time-of-day implementation.
  - Handle the overnight-wrap case (`endMin < startMin`) explicitly.
  - Cap the day-walk (e.g. ≤ ~2000 days) as a runaway guard.

Pure and exported for unit tests.

## Lifecycle / integration (in `lib/backtest.ts`)

- `BacktestArtifacts` gains `periodBandIds: string[]`.
- `renderArtifacts` (after recording `result` / `markerMode`): if the toggle is
  on and `result.period` exists, `computePeriodBands(result.period, barTimes)`
  and create one overlay per band, tracking ids. Runs regardless of `markerMode`.
- `teardownArtifacts` removes the period overlays and clears the ids.
- History-coverage page-back: recompute the bands too (they clamp to the loaded
  range, so a period can extend once older bars load) — alongside
  `reanchorBacktestMarkers`, or a sibling `reanchorPeriodBands`.

## Toggle

- A small on/off control in the **backtest results pane header**
  (`BacktestSettingsModal`'s results region, near the ✕ clear), grouped with the
  backtest itself.
- Persisted **device-local per cell** (scope), default **on** — a display
  preference, so it must be a device-local key (see the
  device-local-persist-keys guard so `hydrateFromBackend` doesn't prune it).
- Toggling re-renders: off removes the period overlays; on recomputes and draws
  them. Drive via a signal the way the other backtest artifacts are driven.

## Verification

- **Unit tests** on `computePeriodBands` (mirror `backtestMarkerWindow.test.ts`):
  no-mask clamp; window past last bar clamps; DOW filter; month filter;
  session/time-of-day band; **overnight wrap**; coalescing contiguous days;
  empty intersection → `[]`.
- **The discriminating invariant:** with a mask on, **no trade marker falls
  outside a computed band.** A pure test over shared fixtures (result markers +
  `computePeriodBands`) asserting every `marker.time` lands in some band. A
  failure means either a band bug or a pre-existing FE/BE mask mismatch — both
  worth surfacing.
- **Manual (Playwright / real app):** run a backtest with and without a mask;
  confirm the faint band + axis chips draw on the right spans, survive a
  timeframe switch and a reload, vanish when toggled off, and — the explicit
  requirement — the **cursor timestamp pill stays fully legible** while hovering
  across an axis chip.

## Out of scope (YAGNI)

- Per-case auto-switching of marking style (band vs rail vs gutter) — the mockup
  explored rail / gutter / axis-only variants; we settled on band+axis for both
  cases.
- Hover/click interactivity on the period bands.
- Backend changes — the window + mask are known frontend-side at run time.
