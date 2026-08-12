# Tab-bar search: full-catalogue fallback

Date: 2026-08-12
Status: approved

## Problem

The tab-bar "Find open symbol" search (Ctrl/Cmd+F) only highlights matching
*open* tabs/cells. When the typed keyword matches no open tab, the search
dead-ends: the user has to abandon it and reopen the toolbar Symbol search
modal to find the instrument.

## Design

### Trigger

While the tab-bar search is open with a non-empty query and
`matchingTabIds(tabs, query)` is empty, a dropdown appears anchored under the
search input. When at least one open tab matches, behavior is unchanged
(chip/cell highlighting only, no dropdown).

### Data

Results come from the cached per-broker catalogue (`fetchAllMarkets(brokerId)`
in `lib/feed.ts`, already session-cached). Matching is client-side and mirrors
`tabSearch.ts`: case-insensitive `includes` on epic or name. Capped at 8 rows.
No debounced broker round-trip. `TabBar` gains a `brokerId` prop.

A new pure helper in `lib/tabSearch.ts`:

```ts
catalogueMatches(all: Instrument[], query: string, limit = 8): Instrument[]
```

### UI

Dropdown structure, styled to match existing menus:

- Header line: "No open tab matches"
- Divider label: "All symbols"
- Up to 8 rows: SymbolIcon, epic, muted name
- Empty state (catalogue also has no match): `No symbols match "x".`

The dropdown lives inside `.tab-bar` so the existing outside-click handler
keeps the search open for clicks within it.

### Interaction

- Click a row, or ArrowUp/Down + Enter (first row pre-highlighted): opens the
  symbol as a NEW tab via a new `onOpenSymbol(instrument)` prop, records it in
  recent symbols (`pushRecentSymbol`), closes the search and clears the query.
- Escape / outside click: close search, as today.

### App wiring

`onOpenSymbol` in App builds a one-cell tab with `makeTab(symbol,
DEFAULT_PERIOD)` (same shape as addTab but without opening the symbol-search
modal), appends it, and activates it.

## Out of scope

- Showing catalogue results below tab hits when tabs DO match.
- Broker-side keyword search, favorites, synthetics in the dropdown (the full
  modal already covers those).

## Testing

- Unit tests for `catalogueMatches` (case-insensitivity, epic + name matching,
  cap, empty query).
- Component test for TabBar: no-match query shows dropdown rows; Enter/click
  calls `onOpenSymbol` with the right instrument; matching-tab query shows no
  dropdown.
