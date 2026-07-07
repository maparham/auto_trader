# Preserve the selected backtest trade across a timeframe switch

## Problem

While studying a backtest trade, the user selects its row in the BacktestPanel.
The chart draws the trade's risk/reward zone and scrolls to center it. The user
then switches timeframe to study what happened around the position (e.g. why it
closed at a loss). After every timeframe switch the chart jumps to the latest
candles and the row is deselected, so the user must re-click the trade row each
time.

## Root cause

On a resolution change (`ChartCore.tsx`), two things discard the trade view:

1. New bars load and the chart calls `scrollToRealTime()` (`ChartCore.tsx:3332`),
   jumping to the latest candles.
2. `rehydrateBacktest()` (`lib/backtest.ts:1148`) calls `teardownArtifacts()`,
   which — when this chart owns the active backtest — explicitly resets the
   shared `selectedTradeSignal` to `null` (`lib/backtest.ts:1210-1213`). The same
   backtest re-renders on the new timeframe, but with no row selected.

The navigation path itself is unchanged and already handles the hard case: the
`selectedTradeSignal` subscription (`lib/backtest.ts:1055-1104`) draws the zone
and scrolls, and when a trade is off-screen on a finer timeframe it pages history
back via the registered pager (`coverBacktestTradeTo`) before drawing
(`lib/backtest.ts:1082-1099`). Nothing re-triggers that path after a switch.

## Decision

- After a timeframe switch, **re-center on the selected trade** — reproduce the
  state as if the user had re-clicked the row.
- If the trade is off-screen on a finer timeframe, **page history back
  automatically** (reuse the existing pager), accepting the brief history load.
  This matches how re-clicking the row already behaves, including the existing
  "Loading history for this trade…" / "older than available history" notices.

## Approach (chosen: preserve & re-select)

Capture the selected trade index in `rehydrateBacktest()` before teardown clears
it, then re-emit it after the backtest re-renders. The existing subscription does
the rest — redraw the zone, page back if needed, scroll to center — and its work
runs after `scrollToRealTime()`, so it overrides the jump-to-latest.

Scoping the capture/restore to `rehydrateBacktest()` (rather than changing
`teardownArtifacts()`'s clearing rule) keeps `teardownArtifacts()`'s general
contract intact: a genuine clear, panel close, or new run still resets the
selection as today.

### Change

In `lib/backtest.ts`, `rehydrateBacktest()`:

1. Before `teardownArtifacts(chart)` runs, capture the current selection only when
   this chart owns the active backtest (the existing `owned` flag already
   expresses this):

   ```ts
   const prevSelected = owned ? selectedTradeSignal.value : null;
   ```

2. After `renderArtifacts(...)` and `backtestResultSignal.set(saved)` (which
   re-installs the selection subscription and re-binds identity to `saved`),
   re-emit the captured index:

   ```ts
   if (prevSelected != null) selectedTradeSignal.set(prevSelected);
   ```

### Why this is correct

- **Ownership.** `prevSelected` is captured only when `owned` is true, so a split
  layout cell that doesn't own the panel never re-emits and can't disturb another
  cell's selection — same guard the rest of this function already uses.
- **Index validity.** The index refers to the same backtest's `trades` array
  (`saved` is the same persisted result), so the index maps to the same trade on
  the new timeframe.
- **Firing.** `teardownArtifacts()` sets `selectedTradeSignal` to `null`; setting
  it back to `prevSelected` is a real change, so the freshly-installed
  subscription fires. At that point `backtestResultSignal.value === saved` and the
  subscription closes over `saved`, so its `backtestResultSignal.value !== result`
  guard passes and it navigates.
- **Ordering.** `scrollToRealTime()` runs earlier in the switch
  (`ChartCore.tsx:3332`); this re-emit runs at the end of `rehydrateBacktest()`
  (`ChartCore.tsx:3348`), so the trade-centering scroll wins.
- **Off-window trades.** Handled by the unchanged pager branch — auto page-back,
  with the existing notices for the too-far-back case.

## Out of scope

- Preserving the exact prior visible window/zoom across timeframes (approach C).
  The user chose re-center, not window preservation.
- Changing `teardownArtifacts()`'s selection-clearing contract (approach B).
- Any change to marker/equity render modes across timeframes.

## Testing / verification

- Unit: no pure function changes; the logic is a signal capture/re-emit. If a
  focused test is warranted, assert that `rehydrateBacktest()` re-emits a
  previously-selected index when `owned`, and does not when not owned.
- Manual (primary): run a backtest, select a trade so the chart centers on it,
  switch timeframe (both coarser and finer), and confirm the chart re-centers on
  the same trade and the row stays selected. On a finer timeframe with an old
  trade, confirm the "Loading history…" notice appears and the chart then
  centers, or the too-far-back notice shows when unreachable.
- Regression: in a split layout, switch timeframe on a cell that does not own the
  panel and confirm the owning cell's selection is untouched. Confirm a fresh run
  and the toolbar ✕ clear still deselect as before.
