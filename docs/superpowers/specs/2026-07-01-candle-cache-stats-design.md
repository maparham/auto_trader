# Candle cache statistics display — design

## Goal

Show per-chart candle-cache statistics (coverage, hit/miss rate, freshness, raw debug numbers) so cache behavior can be observed and debugged directly from the chart UI, without adding load or risk to the actual candle-fetch path.

## Background

The backend candle cache (`backend/auto_trader/core/candle_cache.py`, see `candle-cache` memory) already tracks per-series coverage watermarks (`_coverage(key)` → `oldest_ts, newest_ts`) and cached bar counts (`_cached_count(key)`) per `(broker, epic, resolution, side)` key, but exposes none of this over HTTP. It has no hit/miss counters and no last-fetch timestamp today.

The frontend chart legend (`frontend/src/ChartLegend.tsx`, driven from `frontend/src/ChartCore.tsx`) is a DOM overlay — row 0 shows symbol/period/OHLC/change, updated imperatively via `ChartLegendHandle.updateValues` (no React re-render per tick). `frontend/src/InstrumentDetailsModal.tsx` is an existing draggable, Escape-closable popover that renders arbitrary key/value rows — the template for a stats popover.

## Scope

Per chart cell, not global-only: each `ChartController` instance (one per cell in a multi-chart layout) shows stats for its own displayed series (broker/epic/resolution/side), matching the cache's existing per-key granularity. A global cache-wide summary (across all series) is also shown, nested inside the same popover, not as a separate view.

## Backend

**New instrumentation on `CandleCache`** (in-memory, resets on process restart — acceptable, this is a debug aid, not durable telemetry):
- Hit counter and miss counter per series key, incremented at the existing branch points in `window()`/`recent()` where a request is served fully from cache ("hit") vs. requires a backfill/live fetch ("miss").
- `last_fetch_ts` per series key, set whenever `fetch_range`/`fetch_recent` actually calls out to the broker.

**New routes** (in `backend/auto_trader/api/app.py`, alongside the existing candle routes):
- `GET /api/candle-cache/stats?broker=&epic=&resolution=&side=` → `{ oldest_ts, newest_ts, cached_bar_count, hits, misses, last_fetch_ts }`. If the series has no coverage row yet, return a shape indicating "no cache data" (e.g. all fields `null`) rather than a 404 — the frontend should treat this as an empty/neutral state, not an error.
- `GET /api/candle-cache/stats/global` → `{ total_bars, total_hits, total_misses, db_size_bytes }`, computed by summing counters across all known series keys and `os.stat`-ing the single sqlite DB file (`settings.candle_db_path`).

Both routes are read-only and must not mutate cache state or trigger any fetch.

## Frontend

**Badge (always visible):**
- `ChartLegend` row 0 gains a small badge (e.g. a dot + short label such as freshness age) appended after the existing OHLC/change fields.
- Polled on an interval per chart cell (same imperative-update mechanism as OHLC values — no extra re-renders), calling the per-series stats endpoint for that cell's current broker/epic/resolution/side.
- If the endpoint errors or returns "no cache data", the badge shows a neutral/empty state. It must never block chart rendering or interaction.

**Popover (on click):**
- Clicking the badge opens a popover modeled on `InstrumentDetailsModal` (draggable via `useDraggable`, closes on Escape via `useCloseOnEscape`, generic humanized key/value row rendering).
- Top section: this chart's series stats — coverage range (oldest↔newest), cached bar count, hit rate (hits / (hits+misses)), last fetch time (relative, e.g. "2m ago").
- Bottom section: global cache summary — total bars, DB size (human-readable), overall hit rate — fetched from `/stats/global` when the popover opens (not polled continuously).

**Per-cell independence:**
- Each `ChartController` cell owns its own `ChartLegend` instance and passes its own series identity to the stats poll — cells in a multi-chart layout show independent stats with no cross-cell coupling, consistent with existing per-cell scoping (see `multi-chart-layouts` memory).

## Error handling

- Stats endpoints failing, timing out, or returning empty data must degrade to a neutral badge/popover state, never an error dialog or blocked chart. This mirrors the existing pattern of not letting ancillary chart features affect core chart usability.

## Testing

- Backend: unit tests for hit/miss counter increments (hit path, miss/backfill path), the `/stats` and `/stats/global` routes (happy path, and the "no cache data yet" empty-series case).
- Frontend: extend existing chart-legend Playwright coverage to assert the badge renders, and that clicking it opens the popover with expected fields; stub the new endpoints in e2e tests the same way other API calls are stubbed (see `symbol-templates` memory note on stubbing `/api/state`).

## Out of scope

- Persisting hit/miss counters across restarts.
- Real-time push of stats (e.g. over the live-stream session) — polling/on-open-fetch is sufficient since these numbers change slowly.
- Per-resolution/side breakdown beyond what's already keyed (each chart cell only ever needs its own displayed series).
