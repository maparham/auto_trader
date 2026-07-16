# Scope backtest + sweep results to tab+cell

## Problem
Backtest/sweep results should belong to one tab+cell. Today they leak: switching
tabs keeps showing the previous result. Storage is already per-scope; the live
view is driven by app-global signals nothing rebinds on tab/cell switch.

- `backtestResultSignal` (global): on unmount the owning cell doesn't clear it, so
  a new cell with no result won't (split-sibling guard) → stale panel.
- `sweepStateSignal` (global) has no scope keying at all; modal auto-reopens the
  *newest archive for the epic* → always shows last sweep regardless of tab.

## Fix

### A. Backtest
In `teardownArtifacts` (lib/backtest.ts), inside the existing
`backtestResultSignal.value === artifacts.result` owner block, also
`backtestResultSignal.set(null)`. On unmount this clears before the new tab's
cells rehydrate their own. Owner-gated → split siblings unaffected; re-run/TF
switch republishes immediately.

### B. Sweep (reuse server archive + per-scope pointer)
1. Thread `scope` into `BacktestSettingsModal` and `BacktestButton`
   (`focusedCell.scope` available at App mount sites).
2. Persist one value per scope+epic: the archive **id** of this cell's current
   sweep, key `ns(scope, "sweep."+epic)` (mirrored, survives reload). Store rows
   only server-side (existing archive), never duplicated into localStorage.
3. Modal mount / scope change: read pointer → reopen that archive into
   `sweepStateSignal`, else clear to null. Replaces auto-reopen-newest-for-epic.
4. On sweep completion (after `saveSweepArchive`) and on reopen-from-picker:
   write pointer = that id. On explicit clear: delete pointer.
5. Restore effect no-ops while `sweepStateSignal.value?.running`.

### C. Decision
Reopen picker stays **shared per instrument** (`listSweepArchives(epic)`
unchanged). Only the auto-shown/active result is per tab+cell.

## Known limitation
An in-flight sweep stays session-global until it finishes; it then writes its
origin cell's pointer.

## Tests
- backtest: teardown of owner nulls signal; non-owner teardown doesn't.
- sweep: pointer round-trip (write on run/reopen, restore on scope change, clear
  when absent); running guard.
