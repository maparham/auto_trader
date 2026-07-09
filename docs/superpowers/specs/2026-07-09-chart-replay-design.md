# Chart Replay — Design

**Date:** 2026-07-09
**Status:** Approved for planning

## Purpose

TradingView-style bar replay: jump to a point in the past and play closed bars
forward, to practice strategies manually **without knowledge of what comes
next**. Blindness is a first-class goal, not an afterthought — the feature
exists to remove hindsight bias, so the UX must never leak future bars or
(in blind mode) real dates.

## Scope

### In scope (v1)

- Replay in a **single cell**; other cells stay live.
- **Minute-and-above** timeframes, including derived TFs (2W, 1M, … served by
  the backend from cached DAY/WEEK bars). Sub-minute is excluded from this
  feature entirely (not deferred — out of the feature's scope for good;
  sub-minute bars are tick-built, in-memory only, and not backfillable).
- Start selection: **pick on chart with curtain** or **random jump** within a
  user-chosen window, with re-roll.
- **Masked clock** ("hide dates") for blind sessions; real dates revealed on
  exit.
- Controls: play/pause, speed (1×/2×/5×/10×), step forward, **step back**,
  pick-new-start, exit. Floating-pill layout (TV style, bottom-center).
- Timeframe switching mid-replay; cursor keeps the same moment in time.
- Indicators and drawings function normally with **no future leakage**
  (higher-TF indicator data clamped to the cursor).
- **Manual paper trading** during replay with a per-session ledger and an
  exit report card.
- **Strategy reveal**: pre-run backtest whose markers/trades/equity appear
  progressively as the cursor passes them.
- Session persistence per cell (survives reload mid-session).

### Out of scope (possible later)

- Masked symbol (random hidden instrument from a pool).
- Scrubber/timeline bar with drag-to-any-point (engine supports it; UI only).
- Tab-wide synced replay (shared time cursor across cells).
- Feeding the live rule engine with replayed bars (live-parity simulation).
- Session history archive (past session reports).

## Architecture decision

**Frontend-driven slicing.** The browser holds the replay bars locally and
renders only bars at or before the cursor. No backend replay session, no new
backend state. Rationale:

- The backend candle cache (sqlite, contiguous closed-bar coverage) was built
  as replay's substrate; `fetchRange` → `/api/candles` already serves any
  past window. Replay never crosses "now", so the cache's known limitation
  (no forward-fetch above the live watermark) is irrelevant.
- Stepping must feel instant; local bars make step/play/step-back free of
  network latency. The rejected alternative — a stateful backend replay
  session (create at T, serve the next bar on request) — adds round-trips
  per step, rewind state, and session lifecycle management for no felt
  benefit.
- Memory cost is acceptable: even months of 1m bars is tens of MB.

## Components

### 1. `ReplayController` (new, `frontend/src/lib/replay.ts`)

Per-cell controller hung off `ChartController` (same pattern as `overlays`).
One state signal:

```ts
{
  mode: 'off' | 'picking' | 'active',
  startMs: number,        // chosen start point
  cursorMs: number,       // current replay position (timestamp, never an index)
  highWaterMs: number,    // furthest point ever played to (trading gate)
  masked: boolean,        // hide-dates session
  playing: boolean,
  speed: number,          // ms per bar
}
```

Responsibilities:

- **Bar store**: full bar array for the loaded range at the current
  resolution, fetched via existing `fetchRange` (rides the candle cache).
  Initial load: `[start − visible context, start]` plus a **forward buffer**
  of ~200 bars past the cursor. Buffer refills in the background when the
  cursor comes within ~50 bars of its edge, so stepping never blocks on the
  network in the normal case.
- **Slicing**: chart receives exactly the bars with close time ≤ `cursorMs`.
  Step-forward appends one bar (`chart.updateData`); step-back re-applies the
  slice minus one bar; play is a timer at `speed`.
- **TF switch**: keep `cursorMs`, refetch bars at the new resolution, show
  only bars **fully closed** by the cursor (at 14:30 the 14:00 hourly bar
  does not exist yet). Derived TFs follow the backend's existing
  whole-bucket snapping.

### 2. ChartCore integration

- While a cell's replay `mode !== 'off'`: skip/close that cell's live
  websocket, ignore live candle pushes, and ignore incoming crosshair/range
  sync from sibling cells (the replaying cell lives at a different time).
  Publishing sync out is also suppressed.
- Scroll-back paging left of the start point keeps working through the
  existing `loadDataCallback` path — older context is browsable anytime.
- On exit: restore live data (`fetchRecent` + `openLive`) exactly as a
  symbol/TF change does today.

### 3. Start selection UI

Entering replay (cell-toolbar `⟲ Replay` button) opens *picking* mode:

- **Pick on chart (curtained)**: a DOM curtain (opaque panel) covers
  everything right of the pointer; candles to the right are fully hidden,
  not dimmed. Click sets `startMs`.
- **Random jump panel**: window preset (past week / month / 3 months / year /
  custom range) + **Jump** button + re-roll (die) button. Picks a uniform
  random timestamp in the window and snaps to the nearest bar with data.
  A **"Hide dates" checkbox** (default ON for random jumps, OFF for manual
  picks) arms the masked clock.
- Weekend/dead-zone landings auto re-roll (bounded attempts, then widen the
  search window). Cold-cache jumps show a loading state while the backend
  backfills from the broker.

### 4. Controls — floating pill

Bottom-center pill over the chart (TV-familiar): step-back ∙ play/pause ∙
step-forward ∙ speed select ∙ pick-new-start ∙ exit. The cell border carries
a subtle accent tint while in replay so the mode is visible even when the
pill idles. State is designed so a scrubber/timeline can be added later
without engine changes.

### 5. Masked clock

During a masked session, klinecharts' `customApi.formatDate` is swapped for a
relative formatter anchored at the jump point: axis labels, crosshair label,
and pill readout all show `Day N · HH:MM`. No absolute date renders anywhere
on the cell. Real dates are revealed on exit (report card). Drawings created
during a masked session persist with real timestamps — the bars underneath
are real; only the display formatting is masked.

### 6. Manual trading — replay session ledger

Reuses the existing paper executor (limit/SL/TP OHLC trigger logic, draggable
on-chart order lines, pending-merge) pointed at a **replay session ledger**,
fully separate from the real paper journal.

- Orders evaluate bar-by-bar as the cursor advances.
- **High-water rule**: fills and ledger mutations only occur when the cursor
  advances past `highWaterMs`. Step-back is **view-only rewind** — trades do
  not un-happen, and while `cursorMs < highWaterMs` order placement is
  disabled (ticket greyed with a "rewind — return to <time> to trade" note).
  This closes the rewind-and-cheat loophole.
- **Session report card** on exit or restart: trades taken, win rate, net
  P&L, and the date reveal if the session was masked.

### 7. Strategy reveal

If the cell has an active strategy, a "Show strategy" toggle runs the normal
backtest once over `[start − warmup, now]`, then filters rendering to
`time ≤ cursorMs`: markers pop in as bars arrive, dock rows appear as trades
"happen", the equity curve draws up to the cursor. No engine changes — the
existing `runAndRender` artifacts with a cursor filter. Strategy markers do
not leak dates under masking.

### 8. Indicator honesty (no lookahead)

`fetchHtfBars` (MTF coordinator) receives a cursor clamp when the cell is
replaying: higher-TF indicator series may only use HTF bars whose close is
≤ `cursorMs` — the same no-lookahead rule the backtester enforces. HTF
arrays refetch in chunks as the cursor advances. klinecharts recomputes
indicators automatically on data change, so per-step recomputation needs no
extra wiring.

### 9. Persistence

Active session state (start, cursor, high-water, masked flag, ledger) is
persisted per cell scope, device-local — same pattern as persisted backtest
results. Reload mid-session resumes exactly, masked state intact. Ended
sessions are not archived.

## Edge cases

- **Random jump lands where no bars exist** → auto re-roll, bounded, then
  widen the window.
- **Reaching "now"** → playback stops at the last closed bar; rejoining the
  live edge requires an explicit exit (no silent replay→live transition).
- **Cold cache on a first-visit range** → loading state while the backend
  backfills; subsequent visits are instant.
- **Sibling-cell sync** → a replaying cell neither consumes nor publishes
  crosshair/range sync.

## Error handling

- Fetch failures during buffer refill: retry with backoff; if the cursor
  reaches the end of buffered bars with the network down, playback pauses
  with a non-blocking notice rather than exiting the session.
- Broker/cache 404 on a jump target: treated as a dead zone → re-roll.

## Testing

- **Unit**: cursor slicing (closed-bar rule per TF, derived-TF buckets),
  high-water trading gate, relative-date formatter, random-jump re-roll
  bounds.
- **Playwright** (existing screenshot harness): enter replay → curtain →
  pick → step/play → strategy markers appear progressively → step-back
  disables the ticket → exit report card. Assert no websocket traffic to the
  replaying cell and no absolute date strings in the cell DOM during a
  masked session.
