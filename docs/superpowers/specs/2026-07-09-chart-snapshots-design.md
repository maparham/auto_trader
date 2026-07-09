# Chart Snapshots — Design

**Date:** 2026-07-09
**Status:** Approved

## Problem

An interesting pattern shows up on a chart and the user wants to revisit it later to
see how it developed — even after the drawings and indicators on the live chart have
changed or been deleted. Today the only option is a manual screenshot, which is not
interactive and loses all chart state.

## Decision summary

- **Restore mode: live restore.** A restored snapshot is a normal, fully editable
  chart scrolled to the saved date range. Everything after the snapshot moment is
  visible — scrolling right shows how the pattern developed. No frozen candle data
  is stored.
- **Scope: one chart cell.** A snapshot covers the focused cell: symbol, timeframe,
  visible range, drawings, indicators. Not the whole tab layout.
- **Browse UI: gallery with thumbnails.** Each snapshot stores a small chart image
  captured at save time.
- **Restore target: a fresh one-cell tab.** Snapshots are immutable; restoring
  copies state into a new tab's scope. Edits there never touch the snapshot, and the
  same snapshot can be restored repeatedly.
- **Snapshot-moment marker: included.** The restored chart marks the taken-at moment
  so "right of this line is the future" stays readable.

## Relationship to chart replay (backlog)

Adjacent, not overlapping. Replay = jump to a past date and play closed bars forward,
hiding the future; it needs a playback engine and a cache forward-fetch path that
don't exist yet. Snapshots need neither: the restored chart is live and the future is
simply visible. **Future hook (not built now):** a snapshot records the exact
`takenAt` timestamp and full chart state, so once replay exists, a "Replay from this
snapshot" action on a gallery card becomes nearly free.

## Data model & storage (`lib/persist.ts`)

```ts
interface ChartSnapshot {
  id: string
  name: string            // default: "SYMBOL TF · date", editable in gallery
  note?: string           // editable in gallery
  epic: string
  period: Period          // same shape cells persist
  takenAt: number         // ms timestamp of capture
  range: { from: number; to: number }  // visible range as bar timestamps
  // The blobs below reuse the existing persisted per-cell shapes VERBATIM
  // (same contract symbol-templates shuttle):
  indicators: IndicatorInstance[]
  indicatorConfigs: Record<string, SavedIndicatorConfig>
  drawings: SavedOverlay[]
  avwapAnchors: Record<string, number>
  thumb?: string          // small JPEG data-URI from klinecharts canvas export
}
```

Storage: **one key per snapshot** — `auto-trader.snapshot.<id>` — plus an index key
`auto-trader.snapshots` holding the ordered id list. Per-snapshot keys mean editing a
name or deleting one snapshot doesn't rewrite the whole gallery, and each key rides
the existing backend mirror for cross-device sync. Thumbnails target tens of KB
(JPEG, ~480px wide, includes overlays).

Accessors: `loadSnapshotIndex`, `loadSnapshot(id)`, `saveSnapshot`,
`deleteSnapshot(id)` (removes key + index entry).

## Capture (`lib/snapshots.ts` + Toolbar camera button)

A camera icon in the toolbar saves the focused cell **instantly** — no dialog:

1. Read the persisted scope stores (authoritative — kept current by
   OverlayManager.persist / saveIndicators on every edit), same read path as
   `captureSymbolTemplate`, plus each AVWAP's separately-stored anchor.
2. Read the current visible range from the chart and convert to bar timestamps.
3. Export the thumbnail via klinecharts' picture export (with overlays, light
   background). If export fails, save without a thumbnail — never fail the snapshot.
4. Default name `SYMBOL TF · <date>`; snackbar confirms the save. Renaming and
   notes happen in the gallery.

## Restore

Restoring a snapshot:

1. **Create a new one-cell tab** via the existing detach/clone-tab machinery, with
   the snapshot's symbol and period, and switch to it.
2. **Write blobs into the fresh primary scope** before the chart hydrates. Order is
   load-bearing (proven by templates): AVWAP anchors first (rehydrate reads them),
   then indicators/configs/drawings. Fresh scope → plain writes, no merge logic.
3. Write the scope's `snapshotMeta` (see marker section).
4. Normal cell mount + hydration runs — indicators and drawings appear exactly as
   the standard rehydrate path renders them.
5. **Scroll to the saved range:** page history back until `range.from` is covered,
   then position the visible window on `[from, to]` — reusing the scroll-back
   coverage approach already used for drawing anchors and backtest row selection.
   If the broker/cache can't serve data that old, land at the oldest available bar
   and surface a small notice; drawings and the marker still render where data
   exists.

The restored tab is a completely normal chart afterwards. The snapshot record is
never mutated by anything the user does in that tab.

## Snapshot-moment marker

The restored scope persists a small `snapshotMeta` key:
`{ snapshotId, name, takenAt }`. While present, the cell renders a subtle vertical
line + time-axis chip at `takenAt` (same visual family as backtest period shading:
grey, flat, unobtrusive), labeled with the snapshot name. It survives reloads of that
tab and is dismissible from the chart (dismiss deletes the scope's `snapshotMeta`;
the snapshot itself is unaffected).

## Gallery

A "Snapshots" entry opens a **FloatingModal** (non-blocking shell already in the
app): a grid of cards, newest first. Each card shows the thumbnail, editable name,
`SYMBOL @ TF`, taken date, optional note, and **Restore** / **Delete** (with
confirm) actions. Light theme first, flat (no shadows), content-sized, dismiss on
outside click — per standing UX conventions. No filtering/search in v1.

## Error handling

- Thumbnail export failure → snapshot saves without `thumb`; card shows a neutral
  placeholder.
- History unavailable back to `range.from` → restore still completes; window lands
  at the oldest covered bar with a notice.
- Restoring a snapshot whose epic is unknown to the current broker → surface the
  standard symbol-not-found behavior; snapshot is not deleted.
- Deleting a snapshot never touches tabs previously restored from it (they only
  hold copies).

## Testing

- **Unit** (`lib/persist.test.ts`, `lib/snapshots.test.ts`): snapshot round-trip
  (save/load/delete + index maintenance), capture reads the persisted stores and
  assembles the record, restore writes in the required order (anchors before
  indicator blobs), `snapshotMeta` round-trip.
- **e2e** (`e2e/snapshots.spec.ts`): draw + add indicator → snapshot → clear the
  chart → restore from gallery → new tab shows the drawing/indicator and the
  window sits on the saved range, marker visible. Must stub `/api/state*` empty
  for isolation (established lesson from the symbol-template e2e).

## Out of scope (v1)

- Whole-tab-layout snapshots.
- Frozen candle data / play-forward reveal (that's chart replay's territory).
- Gallery search/filter, tags, folders.
- "Replay from snapshot" (future hook once replay exists).
