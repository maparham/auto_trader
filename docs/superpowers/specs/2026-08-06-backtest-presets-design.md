# Backtest presets: active-preset semantics + results-aware library

**Date:** 2026-08-06
**Status:** Approved

## Problem

The Presets tab of the backtest config panel has three rows that act on three
different subjects:

- **Save** acts on a free-text name field.
- **Load** / **Delete** act on a `<select>` (`loadName`).
- **Go live** acts on the panel's current config.

There is no notion of "the preset you are working on", and everything else
follows from that:

- No update path. Re-saving an edited strategy means retyping its exact name,
  and `saveBacktestPreset` (`frontend/src/lib/persist/defaults.ts`) then
  overwrites silently.
- No dirty state. Load a preset, change an exit rule, and nothing indicates the
  panel has diverged from what is stored.
- Load is destructive: it replaces the whole config with no confirm and no undo.
- Delete has no confirm.
- Presets are global by design but carry no provenance, so a 5m strategy loads
  onto a daily chart with no signal.
- localStorage only — no export/import, so strategies cannot be shared or
  backed up.
- The `<select>` does not scale: twenty strategies are twenty bare names, with
  no dates, no search, and nothing about whether any of them worked.
- Empty on first run: "Choose a preset…" with nothing behind it.

## Decision

Give presets a stable identity (one **active preset**, with dirty tracking and
a real update path), and turn the picker into a **results-aware library** — a
sortable table where each preset carries the summary of its last clean run.
A name-only list is a filing cabinet; the comparison table is what a preset
library in a backtester is for.

Preset identity is shown **inside the Presets tab only** — the panel header is
not touched. This keeps the change contained and avoids colliding with the
in-flight overlay/auto-hide work
(`2026-08-06-backtest-panel-overlay-design.md`), which owns panel chrome.

## Design

### Storage

New key `${PREFIX}.backtestPresets.v3`. The v2 key is **abandoned**, not
migrated — same approach v2 took with v1. Existing saved presets are lost.
This was an explicit call: the alternative (wrap v2 entries in the new envelope
with blank metadata) was offered and declined.

Each entry becomes an envelope instead of a bare config:

```ts
type BacktestPreset = {
  name: string;               // duplicated in the value so export/import round-trips
  cfg: SavedBacktestConfig;
  createdAt: number;
  updatedAt: number;
  origin?: { symbol: string; timeframe: string };   // the chart when it was saved
  lastRun?: {
    at: number;
    symbol: string;
    timeframe: string;
    netPnl: number;
    trades: number;
    winRate: number;
    maxDd: number;
  };
};
```

Stored as `Record<name, BacktestPreset>`; rename is delete + set.
`loadBacktestPresets` returns envelopes, and `normalizeBacktestConfig` keeps
folding config-shape drift forward inside `cfg` exactly as today — the envelope
is metadata only and does not change how configs are normalized.

`origin` is required at save time (the chart always has a symbol and timeframe)
but is typed optional so an imported preset from another user's export, or a
hand-edited JSON file, still loads.

### Preset identity and dirty state

The modal gains `activePreset: string | null`:

- Set by Load, and by Save as… after a successful save.
- Cleared by deleting the active preset.
- Not persisted across modal opens — a fresh open starts from the last-used
  config with no active preset, as today.

Dirty is computed as `!backtestConfigEquals(cfg, presets[active].cfg)`.
`backtestConfigEquals` is a new canonical comparison in
`frontend/src/lib/backtestConfig.ts` that compares via sorted-key
serialization, so key ordering never produces a false "edited". Both sides are
normalized before comparison, so an absent optional flag and its default value
compare equal.

The date range is part of `BacktestConfig` and therefore part of dirtiness:
changing the period marks the preset edited. This is deliberate — Save persists
the range, so hiding range changes from the dirty check would let Save write
something the indicator never warned about.

Identity renders as a bar at the top of the Presets tab:

```
● Momentum v3 · edited          [Save]  [Save as…]  [Revert]
```

- No active preset: the bar reads `Unsaved strategy`, **Save** and **Revert**
  are disabled, **Save as…** is enabled.
- Active and clean: the dot and "edited" are absent; **Save** is disabled
  (nothing to write); **Revert** is disabled.
- Active and dirty: **Save** writes `cfg` to the active preset and bumps
  `updatedAt`. **Revert** restores the saved config after a confirm.
- **Save as…** prompts for a name and confirms before overwriting an existing
  one. It never silently clobbers.

### Library list

The `<select>` is replaced by a table with a filter input:

| Name | Symbol/TF | Net P&L | Trades | Win% | Max DD | Modified | ⋯ |

- Sortable by any column; default sort is Modified descending.
- The active preset's row is marked.
- Result columns show `—` for a preset that has never recorded a clean run.
- A preset whose `origin` symbol or timeframe differs from the current chart
  shows a muted mismatch marker in its row, so the mismatch is visible before
  loading rather than after.
- The `⋯` row menu holds: Load, Duplicate, Rename, Delete (with confirm),
  Export.
- A footer row holds **Import JSON…** and **Export all**. Import validates the
  parsed JSON against the envelope shape and reports what it rejected rather
  than failing silently; name collisions prompt the same overwrite confirm as
  Save as.
- Empty state replaces the dead dropdown with a line telling the user to
  configure a strategy and press Save as…, plus the Import button.

Loading while the current config is dirty prompts three ways:
**Save & load** / **Discard & load** / **Cancel**.
Loading with no active preset and no dirty state loads immediately.

The existing Live / **Go live →** row stays where it is, with its current
"send the panel's current config to the Live panel" semantics, unchanged.

### Results capture

When a single backtest completes:

- If `activePreset` is set **and** the config is not dirty, write `lastRun`
  from `result.summary` (`net_pnl`, `n_trades`, `win_rate`, `max_drawdown` —
  all four already exist, so no backend change) plus the chart's symbol and
  timeframe.
- If dirty, or no active preset, write nothing. Numbers attached to a config
  the user has since edited would misdescribe the stored preset.
- Sweeps never write.

One run is stored per preset (last wins), so storage stays bounded.

## Out of scope

- Moving **Go live →** out of the Presets tab. It acts on the current config
  rather than on a preset, so it sits oddly here, but relocating it is a
  separate change.
- Any preset identity in the panel header.
- Run history beyond the last run, and any cross-preset charting.
- Server-side or cross-device preset sync. Export/Import is the sharing story.

## Testing

Component tests in the existing `BacktestSettingsModal.test.tsx` setup:

- Save as… creates a preset and makes it active; editing shows the dirty
  indicator and enables Save; Save clears it; Revert restores the saved config.
- Save as… onto an existing name prompts, and cancelling leaves the stored
  preset untouched.
- Loading while dirty prompts, and each of Save & load / Discard & load /
  Cancel behaves correctly.
- Rename, Duplicate, and Delete update the list, and deleting the active preset
  clears the active pointer.
- Export → Import round-trips a preset, including `lastRun`; malformed import
  JSON is rejected with a message and leaves the library unchanged.
- A completed run writes `lastRun` when clean and does not when dirty or when
  no preset is active.
- The list filters by name and sorts by each column.
- A preset whose `origin` differs from the current chart shows the mismatch
  marker.

Unit tests:

- `backtestConfigEquals`: key-order insensitivity, absent optional flag vs its
  default value, and a genuine difference in each config group.
- v3 storage helpers: save, load, rename, delete, and that the v2 key is
  ignored rather than read.
