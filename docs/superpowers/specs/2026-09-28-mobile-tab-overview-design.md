# Mobile tab overview

## Goal

On mobile, the chart strip (`mobile/MobileChartStrip.tsx`) lists every chart of
the mirrored desktop layout in one scrolling row. With many tabs, the only way
to find one is the strip's search. Mobile also cannot change the layout.

This adds a pull-down overview that shows every tab at once, in the same shape
as the desktop tab bar, and lets mobile add, close, reorder and re-symbol tabs.
Edits write the saved layout, so desktop sees them live.

## Decisions (from the brainstorm)

- Overview style: wrapped tab chips, like the desktop tab bar (option C of the
  demo). One chip per tab, labelled with its first chart ("EURUSD 15m") plus a
  "+2" count for split tabs.
- Mobile edits write the shared saved layout. A desktop tab showing that layout
  picks the change up live through the existing backend push path.
- "+" opens symbol search. The new tab gets the picked symbol and the current
  chart's timeframe.
- Included: close tab (with Undo), change symbol, layout picker, search field in
  the overview, active tab highlighted and scrolled into view.
- Excluded: duplicate tab, moving a chart between tabs, mini chart previews.

## Interaction

- **Open:** a grab bar sits under the strip. Dragging it down follows the finger
  and opens past 60 px; a tap toggles. The overview covers the chart area below
  the strip.
- **Close:** drag the bottom grip up, or pick a chart. Picking returns to the
  linear strip with that chart shown.
- **Tap a chip:** opens the tab's chart. For a split tab, that is the cell last
  shown on mobile for that tab, else the first cell.
- **Hold (350 ms):** lifts the chip. Dragging then reorders; releasing without
  moving opens the tab menu. Moving more than 8 px before the hold fires cancels
  it, so vertical scrolling in the overview still works.
- **Tab menu:** Change symbol (single-chart tabs only), Close tab (disabled on
  the last tab), Cancel.
- **Close + Undo:** a toast "Tab closed · Undo" shows for about 4.5 s. The
  tab's scope content (drawings, indicators) is purged only when the toast
  expires, so Undo restores it intact. Desktop's `closeTab` purges immediately;
  mobile defers on purpose.
- **Header:** layout picker, "Find tab" search (filters chips by symbol; the
  empty state offers "+"), and the "+" button.
- **Active state:** the chip of the tab now shown is highlighted, and the
  overview opens scrolled to it.

## Layout choice on mobile

Today mobile always mirrors the default layout (else the first one). The picker
lets mobile show any saved layout. The choice is device-local (a new key beside
`activeLayoutId`, not mirrored), so picking a layout on the phone never changes
the desktop default. A removed layout falls back to today's rule.

If no saved layout exists, "+" creates one named "Mobile" and marks it default,
since there is nothing else for the edit to land in.

## Data flow

- New module `mobile/mobileLayoutEdit.ts`, the only writer. Each operation
  loads the chosen layout body, applies one change, and calls
  `saveLayout(id, name, ws)`, then `bumpMobileWorkspace()`:
  `addTab(instrument, period)`, `closeTab(tabId)` (returns an undo token;
  `commitClose` purges scope later), `reorderTab(from, to)`,
  `setTabSymbol(tabId, instrument)`.
- New tabs are built with `makeTab` / `newTabId` from `app/workspace.ts`, so ids
  and scopes match what desktop creates.
- Reorder uses the same index rule as desktop `reorderTab`
  (`app/useTabActions.ts:343`); extract it to a shared pure helper rather than
  copying it.
- Change symbol updates the cell's `symbol` only; its scope stays, as on desktop.
- `mobileWorkspace.ts` loses its "read-only" framing and gains the device-local
  layout choice (`mirroredWorkspace()` reads it first).
- Desktop needs no change: `useBackendSync.onBackendPush` already reseeds when
  the resolved tabs differ.

## Components

- `mobile/MobileTabOverview.tsx`: the panel (header, chip grid, grip, tab menu,
  toast). Mounted inside the chart view below the strip.
- `mobile/useHoldDrag.ts`: the hold, drag-reorder, hold-release gesture, kept
  apart so it can be tested on its own.
- `MobileChartStrip.tsx`: adds the grab bar; its chips and search stay as they
  are.
- Styles in `mobile/mobile.css`, reusing the strip's tokens. Active chip uses a
  muted fill, not solid accent (project rule for persistent states).

## Edge cases

- A backend push while the overview is open re-renders it; a drag in progress
  finishes against the fresh list by tab id, and an id that vanished is ignored.
- Closing the tab currently shown moves the chart to its neighbour, as desktop
  does.
- A filter active during a drag reorders only the visible chips; hidden tabs
  keep their slots.
- Demo mode: edits stay local like other demo edits (`persist/core` already
  gates the mirror); no extra handling.

## Testing

- `mobileLayoutEdit.test.ts`: each operation writes the expected body; close
  then undo restores the tabs and leaves scope content; commit purges it;
  reorder matches desktop's index rule.
- `useHoldDrag.test.ts`: tap, hold-release, hold-drag, early-move cancel.
- `MobileTabOverview.test.tsx`: renders one chip per tab with the "+N" count,
  active chip, filter, tap selects and closes, "+" routes through symbol search.
- Manual on a phone: drag gestures, scroll versus hold, and a desktop tab
  updating live.
