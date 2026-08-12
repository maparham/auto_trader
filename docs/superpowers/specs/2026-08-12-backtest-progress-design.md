# Backtest progress in the UI — design

2026-08-12. Approved approach: polling side-channel (no SSE, no jobification).

## Problem

While a backtest runs, the UI shows only a static "Backtest running…" line. The
actual wait is minutes of candle-cache backfill (progress already computed and
logged server-side in `candle_cache.window()`) plus the engine simulation. None
of that progress reaches the browser.

Flow today: frontend `BacktestButton.run()` → `fetchRange` (GET `/api/candles`,
blocks while the cache backfills) → POST `/api/backtest` or `/api/expr/backtest`
with candles inline (engine runs synchronously **on the event loop**, so the
server cannot answer any request while simulating).

## Phase 1 — Downloading data (candle-cache backfill)

- Module-level registry of active backfills in
  `backend/auto_trader/core/candle_cache.py`, updated at exactly the three
  points that already emit log lines (start / per-chunk / finish), cleared in a
  `finally` so a failed walk can't strand an entry.
- Entry fields: series label, `done_chunks`, `total_chunks`, `bars`,
  `elapsed_s`, `eta_s`, `at` (timestamp reached), `updated_at`.
- New endpoint `GET /api/candle-cache/backfill/active` (charts.py) returning
  the list. Reads drop entries not updated in >60 s (crash safety).
- Global (not keyed): covers every backfill a run triggers — main series, HTF
  prefetches, minute data for exit-time resolution.

## Phase 2 — Simulating

- `BacktestRequest` and the expr-backtest request gain an optional
  `progressId` (client-generated UUID).
- Small in-memory progress registry (`{stage, done, total, updated_at}` keyed
  by progressId). Handlers register on entry, remove in `finally`.
- `Backtester.run` gains an optional `on_progress(i, total)` callback invoked
  every ~1% of bars. Cost-sensitivity re-runs update the stage label.
- `GET /api/backtest/progress/{id}` returns the entry, 404 when unknown/done.
- Wrap the single-run engine calls (`run_coded_sync` inside `_run_coded`,
  `engine.run` in the expr handler) in `asyncio.to_thread`. Required for
  polling to work at all; side effect: server stays responsive during long
  simulations. Sweeps/WFO already run in worker processes — unaffected.

## Frontend

- New `backtestProgressSignal`:
  `{ phase: "download" | "simulate", label, pct, etaS } | null`.
- `BacktestButton.run()` starts a 1 s poller when it sets
  `backtestRunningSignal`, stops it in the existing `finally`. While candles
  are being fetched it polls the backfill endpoint; once the POST is in flight
  it polls the progress endpoint (progressId included in the request body).
- `BacktestPanel` replaces the static "Backtest running…" with the live line +
  thin progress bar, e.g. "Downloading US100 5m — 21%, ~3m left" →
  "Simulating — 64%".
- Poll failures are silently ignored; progress is cosmetic and the run itself
  is unaffected.

## Error handling

- Registries always cleaned in `finally`; stale-entry GC on read (>60 s).
- Progress endpoints are read-only and cheap; polling stops when the run ends.

## Testing

- Backend: registry lifecycle (appears / updates / clears, stale GC), both
  endpoints, engine callback cadence, to_thread wrapping doesn't change
  results.
- Frontend: poller → signal → panel rendering states. Baseline has known
  failures on main; only gate on touched tests.

## Out of scope

- Sweep/WFO job progress (already has its own status polling).
- SSE/WebSocket transport; jobifying the single backtest.
- Progress on the toolbar Backtest button (panel only).
