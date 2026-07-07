# Sync indicators across layout cells — design

2026-07-07

## Goal

A new "Sync indicators" option in the layout dropdown. When on, all cells of the
tab share one indicator set: adding, removing, or editing an indicator in any
cell applies to every cell (full mirror, TradingView-style).

## Menu & persistence

- New checkbox in `LayoutPicker.tsx`, below "Sync date range", with an `InfoTip`:
  "All charts in this layout share the same indicators — adding, removing, or
  editing one applies everywhere."
- New `syncIndicators?: boolean` flag on `ChartTab`
  (`lib/persist/workspace.ts`), persisted with the tab like the other sync
  flags. Default off.
- "Lock charts" does **not** override it in either direction — lock is visual
  alignment; indicator content stays an independent choice
  (`effectiveSync*` helpers in `App.tsx` are untouched by this flag).

## Toggle-on (seed)

The focused cell's indicator set becomes the layout's set:

- Every other cell's indicators are removed, then replaced with copies of the
  focused cell's instances — **same instance ids**, same configs
  (`calcParams`, `visible`, `styles.lines`, `extendData`), including sub-pane
  indicators (MACD/RSI/Volume) and AVWAP anchors.
- Destructive to the other cells' sets by design; no confirmation prompt
  (consistent with the other sync toggles acting immediately).
- The seed reuses the pre-write/apply pattern from `applySymbolTemplate`
  (`lib/templates.ts`): write config + anchor, `applyIndicator`, then
  `saveIndicators` — but as a *replace*, not the template's additive merge.

## While on — replicate ops

A helper `replicateToSiblings(tabId, originCellId, op)` in App-level code (the
App owns the per-cell `ChartController`s) iterates the other cells of the tab
and applies the same operation against each cell's own scope via the existing
paths:

| Origin action | Replicated via |
|---|---|
| Add indicator | `applyIndicator` + `saveIndicators` on each sibling, same minted instance id |
| Remove (legend ✕, keyboard, modal) | `removeIndicatorById` on each sibling |
| Settings change (params, styles, visibility, MTF timeframe, curve labels, apply preset) | `saveIndicatorConfig` / `saveIndicatorVisible` + re-apply on each sibling |

Same instance id across cells is the invariant that makes settings edits
addressable everywhere.

Per-cell **view** state stays per-cell: sub-pane collapse/expand, legend
collapse.

No new event channel — this is the same direct-iteration pattern symbol and
interval sync already use (`App.tsx` `setSymbol` / `setCellPeriod`).

## AVWAP

The anchor is a timestamp stored outside indicator config, keyed
`scope + epic + instance id` (`lib/persist/artifacts.ts`
`saveAvwapAnchor`/`loadAvwapAnchor`). Mutation sites: anchor-placement click
(`ChartCore.tsx:1552`) and anchor drag/re-anchor (`ChartCore.tsx:1797`).

- Both write sites replicate when sync is on: write the same timestamp under
  each sibling's scope with the **sibling's own epic**
  (`avwap.<siblingEpic>.<id>`), then re-apply the AVWAP instance on the sibling
  chart so its curve recomputes.
- Add flow: the AVWAP instance replicates immediately like any indicator; the
  curve appears on all cells once the anchor click lands in the origin cell and
  the anchor write fans out. Siblings never wait for their own click.
- Different symbols per cell (Sync symbol off): a timestamp transfers cleanly —
  each cell anchors its own symbol's VWAP at the same moment in time.
- Toggle-on seed copies anchors along with instances, re-keyed to each
  sibling's epic.
- Symbol change within a synced cell: anchors are per-epic, so the new epic may
  have no anchor yet — the seed step writes it (same as the fresh-cell seed).

## New / changed cells while on

- Splitting into more cells: fresh cells get the synced set (seed from the
  focused cell).
- The seed runs before symbol-template auto-apply would
  (`maybeAutoApplyTemplate` only fires on cells with zero indicators), so
  templates won't double-apply.

## Toggle-off

Nothing is removed. Cells keep their mirrored indicators and start drifting
independently again.

## Interaction with other flows

- **Detach**: copies the cell's scope as today; the detached tab starts with
  the mirrored set. The flag is not carried to the new tab.
- **Merge tabs**: `syncIndicators` stays off on the merged tab (current flag
  defaults unchanged).
- **Named layouts**: the flag saves/restores with the tab.

## Testing

- Vitest: replicate helper — add/remove/config ops land on all sibling scopes
  with matching instance ids; toggle-on seed replaces sibling sets; AVWAP
  anchor fan-out re-keys to sibling epics.
- Browser sanity check on a two-row layout: add/edit/remove mirror live; AVWAP
  anchor drag mirrors.
