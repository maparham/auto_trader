# Sweep window robustness scoring

Date: 2026-07-15
Status: approved

## Problem

Sweeping parameters over a single continuous range optimizes for that one range's
flat P&L. The winner is often a combo whose entire profit came from one lucky
sub-period; run the same params on a single week inside the swept month and the
result can look nothing like the headline number. We want the sweep to surface
how *evenly* a combo earns across the range, so the user can prefer consistent
combos over one-lucky-week spikes.

Key insight that shaped the design: if sub-ranges tile the range contiguously,
the sum of sub-range P&Ls is nearly the flat-range P&L, so "optimize aggregate
P&L over sub-ranges" collapses back to today's behavior. The value is in
aggregating with something other than a plain sum: worst window, consistency,
variance-penalized mean.

## Approach (chosen: slice one continuous run)

Each combo still runs exactly **once** over the full range, as today. The
backend buckets that run's trades into N sub-windows by entry time and computes
per-window metrics plus robustness aggregates from the trade list. This costs
zero extra engine runs, does not interact with the combo caps, and reflects how
live trading actually carries indicator/position state across period
boundaries.

Rejected alternatives:

- Frontend aggregation over the existing period axis (combos x N runs, N times
  the compute, eats the 1000-combo cap, later windows re-process earlier
  candles).
- True independent engine runs per window (N times the compute; catches
  warm-up/state sensitivity but that is not the question being asked here).
  The existing period axis remains available when independent windows are
  explicitly wanted.

## 1. Windowing

When a sweep runs, the resolved range `[fromMs, toMs]` is split into N equal
contiguous windows. N is chosen automatically from the range length: roughly
daily windows for a week-scale range, weekly for a month-scale range, monthly
for a year-scale range, via `N = clamp(round(rangeDays / unitDays), 3, 30)`
where `unitDays` is the largest of (1, 7, 30) that yields at least 3 windows.
A numeric override field sits next to the existing sweep controls in
`BacktestSettingsModal`. Window boundaries are computed once in
`frontend/src/lib/sweep.ts` from the resolved range and sent with each chunk
request so backend and UI agree on edges exactly.

This is independent of, and can coexist with, the existing `PeriodAxis` sweep
dimension.

## 2. Backend

In `backtest_sweep` (`backend/auto_trader/api/routers/backtest.py`), after each
combo's engine run, a new helper in `backend/auto_trader/engine/metrics.py`:

- Buckets trades by **entry time** into the N windows (a trade spanning a
  boundary belongs to its entry window).
- Computes per-window `pnl` and `n_trades`.
- Derives four aggregates:
  - `worst_window_pnl`: min window pnl.
  - `median_window_pnl`: median window pnl.
  - `pct_windows_profitable`: windows with pnl > 0 over all N windows
    (a zero-trade window counts as not profitable).
  - `mean_window_pnl_minus_std`: mean window pnl minus 1 standard deviation
    across windows.

`SweepRowDTO` gains `windows: [{from, to, pnl, trades}]`, and the four
aggregates are added to its `metrics`. Aggregates are computed backend-side
(backend owns business logic); the raw window list ships too so the UI can
visualize the breakdown.

## 3. Frontend

- `runSweepChunk` (`frontend/src/api.ts`) passes the window boundaries with the
  request.
- `SweepResults.tsx` table: four new sortable columns under a collapsible
  "Robustness" group header. `better()` and null-gating extend to them; all
  four are higher-is-better. Failed combos keep `metrics = null` and sink as
  today.
- Heatmap: the color-metric dropdown gains the four aggregates.
- Row/cell hover: a per-window strip, one green/red mini bar per window scaled
  by |pnl|, with pnl and trade count per window and the four aggregates as a
  footer line. Answers "one lucky week or spread across the month?" at a
  glance.
- Applying a combo is unchanged.

### Tooltips

All new UI gets short informative tooltips via the shared `Tooltip` /
`InfoTip` components (never native `title=`). Copy (plain, no jargon beyond
standard trading terms):

- Windows override field (InfoTip): "The backtest range is split into equal
  windows to score consistency. Auto picks daily, weekly or monthly windows
  from the range length; set a number to override."
- Column "Worst wnd": "Worst window P&L. The most this combo lost (or least it
  made) in any single window. High values mean no disaster period."
- Column "Med wnd": "Median window P&L. The typical window's result, immune to
  one outlier week."
- Column "Wnd+": "Windows profitable. How many of the N windows ended
  positive. 4/4 means every period made money."
- Column "Mean-σ": "Mean window P&L minus one standard deviation. Rewards
  steady combos, punishes ones that swing between big wins and big losses."
- Robustness group header (InfoTip): "These score how evenly the P&L was
  earned across sub-windows of the range. A combo that wins on Net P&L but
  fails here likely got lucky in one period."
- Hover strip window bar (Tooltip): window date range, pnl, trade count.

## 4. Cost, errors, testing

- Zero extra engine runs; window math is arithmetic over trades already in
  memory.
- Failed combos: unchanged null-metric handling.
- Backend unit tests for the bucketing helper: boundary-spanning trade, empty
  window, single window, zero trades overall, aggregate values.
- Frontend test: robustness columns sort with correct null-gating; heatmap
  `better()` over the new metrics.

## Backlog (recorded, not built now)

1. **Plateau / parameter-neighborhood stability score**: smooth each combo's
   metric with its grid neighbors; spikes are overfit, plateaus are robust.
   Pure frontend arithmetic over existing sweep rows.
2. **Walk-forward validation**: optimize on window k, evaluate on window k+1,
   roll forward, report stitched out-of-sample P&L.
3. **Trade-order bootstrap**: resample trades to get outcome distributions and
   drawdown confidence bands in the Analysis tab.
4. **Deflated best-of-N label**: annotate the heatmap winner with the expected
   best-by-luck result given how many combos were tried.
5. **Cross-instrument / cross-timeframe echo check** of a chosen combo.
