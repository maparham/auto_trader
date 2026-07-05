# Persist backtest trades & markers across timeframes

**Date:** 2026-07-05
**Status:** Approved (design)

## Problem

Backtest results — trade markers, the equity sub-pane, and the trades panel — live
only in memory. They are stored in a `WeakMap<Chart, BacktestArtifacts>` keyed by the
live chart plus module-global signals, with no copy in `localStorage`/backend.
`ChartCore` also calls `clearBacktest(chart)` unconditionally on every resolution or
symbol change (and on unmount). The net effect: switching timeframe wipes the markers,
and a page reload loses the result entirely.

We want a backtest result to persist so its trades and markers stay on the chart across
timeframe switches and page reloads. It should be cleared **only** when the user runs a
new backtest or clicks the "clear backtest" ✕ toolbar icon.

## Decisions (from brainstorming)

1. **Persistence:** Save to `localStorage` + backend `/api/state`, like drawings/alerts.
   Survives timeframe switches, symbol round-trips, and full page reload.
2. **Scope:** Per **cell + epic** (keyed by the cell `scope`, like drawings) — not
   global-per-epic. Another cell on the same symbol shows nothing unless it ran its own.
3. **Cross-timeframe markers:** Render saved markers on the backtest's native timeframe
   **and any finer (lower) timeframe** where each trade timestamp still lands exactly on a
   bar boundary. Hide them on coarser timeframes (timestamps fall mid-bar). Precise gate:
   `currentInterval <= savedInterval && savedInterval % currentInterval === 0`.
4. **Equity curve:** Render **only** on the native timeframe
   (`currentResolution === savedResolution`). Sparse per-bar equity on finer timeframes
   looks broken.
5. **Coarser-timeframe UX:** Nothing extra on the chart. Markers/equity simply hide; the
   saved result stays intact and reappears on a fine-enough timeframe. The off-chart trades
   panel / summary chip may stay populated (they don't depend on bar alignment).

## Architecture

### 1. Persistence layer — `frontend/src/lib/persist.ts`

New per-cell store mirroring the drawings functions:

- `saveBacktestResult(scope, epic, result)`
- `loadBacktestResult(scope, epic)`
- `clearBacktestResult(scope, epic)`

Key: `ns(scope, "backtest." + epic)` →
`auto-trader.tab.<tabId>.cell.<cellId>.backtest.<epic>`.

Every `persist.ts` `save()` already mirrors per-key to the backend and rehydrates on
startup / via the `/ws/state` subscription, so no additional backend wiring is needed.

**Saved shape:** strip the bulky `candles` array before persisting. Keep `epic`,
`resolution`, `markers`, `trades`, `equity`, `summary`, `metrics`. Redraw does not need
candles — markers and equity attach to bars by absolute timestamp, against whatever bars
are currently loaded.

### 2. Split `clearBacktest` into two operations — `frontend/src/lib/backtest.ts`

Root cause of the disappearance: a single `clearBacktest(chart)` is used both for the
user's explicit clear and for internal teardown on TF/symbol change + unmount. Separate
them:

- **`teardownArtifacts(chart)`** — removes live marker overlays, the EQUITY indicator pane,
  selection/highlight overlays, and calls `artifacts.unsub()`. **Does NOT touch the
  persisted store or reset the global signals' saved data.** Used by `ChartCore` on
  TF/symbol change and on unmount.
- **`clearBacktest(chart, scope, epic)`** (user action) — `teardownArtifacts(chart)` +
  `clearBacktestResult(scope, epic)` + reset `backtestResultSignal` /
  `highlightTradeSignal` / `selectedTradeSignal`. Wired to the toolbar ✕ and used by the
  run-new path (a fresh run overwrites the store anyway, so ordering must save the new
  result *after* teardown of the old artifacts).

### 3. Factor drawing out of `runAndRender` — `frontend/src/lib/backtest.ts`

`runAndRender` currently couples fetch + run + draw. Extract:

**`renderArtifacts(chart, result, { drawMarkers, drawEquity })`** — creates the marker
overlays, the equity indicator, wires the trades-panel signal and the per-marker
hover/click/selection subscriptions (everything that currently lives inline in
`runAndRender` after the result is obtained). Selection/highlight wiring is identical
whether the result came from a fresh run or a rehydrate.

Both callers use it:

- `runAndRender` = `teardownArtifacts` → fetch → run → `saveBacktestResult(scope, epic, result)`
  → `renderArtifacts(chart, result, { drawMarkers: true, drawEquity: true })`.
- Rehydrate (below) = `loadBacktestResult` → `renderArtifacts` with resolution-gated flags.

### 4. Rehydrate seam — `frontend/src/ChartCore.tsx`

- **~line 2796** (symbol/period-change effect): replace the unconditional
  `clearBacktest(chart)` with **`teardownArtifacts(chart)`** so the saved result is kept.
- **~line 2885** (right after `overlays.rehydrate(period.resolution)`): add
  **`rehydrateBacktest(chart, scope, epic, period.resolution)`**:
  1. `const saved = loadBacktestResult(scope, epic)`; if none → return.
  2. `drawMarkers = currentInterval <= savedInterval && savedInterval % currentInterval === 0`.
  3. `drawEquity = currentResolution === saved.resolution`.
  4. `renderArtifacts(chart, saved, { drawMarkers, drawEquity })`.
  5. Re-publish `backtestResultSignal` (and the summary chip) so the trades panel/readout
     repopulate — even on a coarser timeframe where nothing is drawn on the chart.

Interval comparison uses the existing resolution→interval helper (the same one the
timeframe/aggregation code uses); no new time math is introduced beyond the divisibility
check.

### 5. `frontend/src/BacktestButton.tsx`

- The `[epic, resolution]` effect (~line 47) that currently resets the readout must stop
  nulling `backtestResultSignal` — `rehydrateBacktest` now owns repopulating it.
- The clear ✕ handler calls the new `clearBacktest(chart, scope, epic)`.
- The run flow passes `scope`/`epic` through to `runAndRender` so it can save.

## Data flow

```
Run backtest ──► runAndRender(chart, req, scope, epic)
                   ├─ teardownArtifacts(chart)      (drop old live overlays)
                   ├─ fetch candles + run strategy  → result
                   ├─ saveBacktestResult(scope, epic, result)   (strip candles)
                   └─ renderArtifacts(chart, result, {markers:true, equity:true})

TF / symbol change ──► ChartCore effect
                   ├─ teardownArtifacts(chart)      (keep store)
                   ├─ overlays.rehydrate(resolution)
                   └─ rehydrateBacktest(chart, scope, epic, resolution)
                        ├─ loadBacktestResult(scope, epic) → saved | null
                        ├─ drawMarkers = finer-or-equal & aligned
                        ├─ drawEquity  = native TF only
                        ├─ renderArtifacts(chart, saved, {markers, equity})
                        └─ backtestResultSignal.set(saved)

Clear ✕ ──► clearBacktest(chart, scope, epic)
                   ├─ teardownArtifacts(chart)
                   ├─ clearBacktestResult(scope, epic)
                   └─ reset backtest signals

Page reload ──► persist.hydrateFromBackend() restores the key,
                first rehydrateBacktest redraws it.
```

## Edge cases

- **Symbol switch:** per-epic keying means the previous epic's backtest stays saved under
  its own key; the new epic rehydrates its own result or nothing. No cross-contamination.
- **Marker/equity timestamp outside the loaded window:** klinecharts shows it once scrolled
  into view — same behavior as drawings, acceptable.
- **Multiple cells, one global trades panel:** a cell that *has* a saved result publishes
  it on rehydrate (last-writer-wins among cells that have one — acceptable single-panel
  behavior). A cell with *no* saved result only clears the panel when it was the one that
  owned it (captured before teardown via `artifactsByChart` + signal identity) — so on a
  split-layout reload, an empty cell can't wipe another cell's just-published result.
- **Non-divisible finer timeframe** (e.g. backtest on 5m viewed on 3m): the `% === 0` gate
  fails, so markers hide — correct, because 10:05 is not a 3m bar boundary.
- **Coarser timeframe:** both flags false → chart shows nothing, store intact, panel/chip
  may stay populated; markers reappear when back on a fine-enough timeframe.

## Testing

- Persistence unit test: save → load round-trips the stripped shape; `candles` absent.
- `teardownArtifacts` removes live overlays but leaves the store readable afterward.
- `clearBacktest` removes both live overlays and the stored key.
- Resolution gate: table-test `drawMarkers`/`drawEquity` for native, finer-aligned,
  finer-non-divisible, and coarser cases.
- Manual/e2e: run a backtest on 5m → switch to 1m (markers stay, equity hidden) → switch to
  1D (both hidden) → back to 5m (both return) → reload page (result restored) → clear ✕
  (gone, and stays gone after reload).

## Out of scope

- Re-running the backtest per timeframe (we redraw the one stored result, we do not
  recompute).
- Multi-panel / per-cell trades panels.
- Snapping mid-bar markers onto coarser bars (explicitly rejected in favor of hiding).
