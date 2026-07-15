# Sweep setup persistence + results clearing

Date: 2026-07-15
Status: approved (brainstorm with user; lifetime = across reloads, apply keeps axes)

## Problem

Preparing the backtest panel for a parameter sweep is tedious. Every round the
user must toggle the sweep button on each field and retype from/to/step. The
axis set lives in session-only React state (`sweepAxes` in
`BacktestSettingsModal.tsx`) and is cleared on modal close, on "Apply this
combo", and on mode switch, so every round starts from scratch. Separately,
once a sweep has run there is no way to clear its results table short of
closing the whole panel.

## Scope

Three features, all frontend-only:

1. **Per-field range memory.** The last-used from/to/step for each swept field
   is remembered and restored when that field's sweep is toggled back on.
2. **Sweep setup survives close/apply/reload.** The axis set (which fields are
   toggled on, with their ranges/options) persists per mode and per coded
   strategy file, and is restored when the panel reopens.
3. **Clear-results button.** A button on the sweep results block that clears
   the finished results and returns the results region to the normal backtest
   panel.

Out of scope: named sweep presets, refine-around-best-combo, range entry
syntax changes.

## Design

### 1. Range memory (`frontend/src/lib/sweepMemory.ts`, new)

A map of `memoryKey -> { from, to, step }` for **range axes only** (list and
period axes are cheap to re-create and their identity is less stable).

- **Key:** `<context>|<target>` where context is `"rules"` for rules mode or
  the coded strategy filename for coded mode. This stops `param:n` from two
  different .py files colliding. Rule targets are positional
  (`rule:long.entry.0.left.length`); a stale recall after rules are reordered
  is harmless because the value is only a seed the user can edit.
- **Write timing:** when a sweep run starts (in the run path that publishes
  `sweepAxesSignal`), record every range axis's from/to/step. Not on
  keystrokes: "last used" means "last actually swept with".
- **Read timing:** inside `toggleSweepAxis`, `toggleRiskSweepAxis`, and
  `toggleRuleSweepAxis`: a recalled range wins; the existing heuristics
  (min/max from ParamSpec, or current-value-to-2x) remain the fallback for
  never-swept fields.
- **Storage:** one flat key `auto-trader.sweepRanges` via the synced
  `save()`/`load()` in `lib/persist/core.ts` (same flavor as codedCfg, so no
  `DEVICE_LOCAL_FLAT_KEYS` entry is needed). Entries are LRU-capped at 300 so
  the map cannot grow unbounded.

### 2. Persistent axis set

- **Storage key:** per context, mirroring codedCfg's per-file keying to avoid
  whole-store snapshot races: `auto-trader.sweepAxes.rules` and
  `auto-trader.sweepAxes.coded.<filename>`, via synced `save()`.
- **Save:** whenever `sweepAxes` changes (write-through from the state
  setter), under the current context's key.
- **Restore:** on modal open and on coded-file switch, load the context's
  saved axes. Prune any axis whose target no longer resolves against the
  current config (`sweepAxisLabel` returns null, or a `param:` target absent
  from the strategy schema, or a `rule:` index out of range), so a deleted
  rule cannot leave a phantom axis.
- **Clearing behavior changes:**
  - Modal unmount cleanup (`BacktestSettingsModal.tsx:583`): keep clearing
    `sweepAxesSignal` and `sweepStateSignal` (in-flight run teardown), but no
    longer wipe the persisted axes; they restore on reopen.
  - `applySweepCombo` / `applyRuleSweepCombo`: stop calling
    `setSweepAxes([])`. The fields stay in sweep mode with their ranges so
    round two is immediate. `sweepAxesSignal.set([])` before `run(next)`
    stays, so the post-apply run is a plain backtest, not a sweep.
  - Mode switch (Rules <-> Strategy): still clears the in-memory axes for the
    documented correctness reason (stale cross-mode axes corrupt combos), but
    each mode's axes remain in ITS OWN storage key, so switching back
    restores them.

### 3. Clear-results button

In the `sweep-panel` block (`BacktestSettingsModal.tsx` results region), when
`sweepState` exists and is not running, render a ghost button "Clear results"
in the same spot the "Cancel sweep" button occupies while running. onClick:
`sweepStateSignal.set(null)` and `setRanAxes([])`. The results region then
falls back to the normal `BacktestPanel`. The sweep AXES are untouched: the
user can rerun the sweep immediately.

## Error handling

- Corrupt/missing stored values: `load()` already falls back to defaults;
  restore paths treat null/malformed as "no saved axes".
- Restored axes are validated (prune rule) before use, never trusted blindly
  into `enumerateCombos`.

## Testing

- `sweepMemory.test.ts`: key derivation (rules vs coded file), LRU cap,
  recall-beats-heuristic, absent-entry fallback.
- Modal-level tests (extend `BacktestSettingsModal.test.tsx`): toggle off/on
  restores the edited range; reopen restores the axis set; apply-combo keeps
  axes but the follow-up run is not a sweep; mode switch round-trip restores
  each mode's axes; stale rule axis is pruned on restore.
- Clear button: visible only when a non-running sweepState exists; click
  returns the region to BacktestPanel and leaves `sweepAxes` intact.
