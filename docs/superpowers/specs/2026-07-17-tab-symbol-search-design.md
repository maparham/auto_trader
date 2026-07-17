# Tab symbol search (find an open chart)

**Date:** 2026-07-17
**Status:** Approved

## Requirement

A symbol can be open in several tabs, and inside multi-cell layouts it is hard
to find. Add a search control that highlights every tab containing a cell with
a matching symbol, and helps the user land on the exact cell.

## Control (Option A: expand-on-click magnifier)

- A magnifier icon button sits at the end of the tab strip in `TabBar`.
- Clicking it swaps the icon for an inline text input, focused immediately.
- Ctrl+F / Cmd+F acts as clicking the icon: opens (and focuses) the search
  from anywhere in the app, `preventDefault()`ing the browser's native find.
  The shortcut is suppressed while an editable element (input/textarea/
  contenteditable) has focus, so typing in other fields stays normal. If the
  search is already open, the shortcut just re-focuses/selects the input.
- Escape, input blur, or outside-click collapses the input back to the icon
  and clears the query (and therefore all highlights).
- Search state is transient component state — never persisted, per browser
  tab only.

## Matching

- Case-insensitive substring match of the query against each cell's
  `symbol.epic` and `symbol.name`, across all tabs of the current session.
- Empty query matches nothing (no highlights).
- Implemented as a pure helper (new `frontend/src/lib/tabSearch.ts`), e.g.
  `matchingTabIds(tabs, query): Set<string>` and
  `matchingCellIds(tab, query): string[]`, unit-tested with vitest.

## Tab highlight

- While the query is non-empty, every tab whose cells include at least one
  match gets a highlight style on its tab chip: tinted background + accent
  border (visible on both the active and inactive tab states).
- Non-matching tabs keep their normal look — no dimming.

## Click-to-jump

- Clicking a highlighted tab activates it normally, plus:
  - the tab's first matching cell becomes `activeCellId`;
  - every matching cell in the tab gets a temporary outline glow that fades
    after ~2s, so the chart is spottable in a 2–4 cell layout.
- The search input stays open after the jump so the user can hop between
  matching tabs; highlights stay live until the search closes.
- If the currently active tab has matches when the query is typed, its
  matching cells glow too (same treatment) without needing a tab click.

## Out of scope

- No result list / popover (Option C rejected).
- No searching of closed/recent symbols — open cells only; the existing
  `SymbolSearchModal` remains the way to open new charts.

## Testing

- `tabSearch.test.ts`: matcher semantics (case-insensitivity, epic vs name,
  empty query, multi-cell tabs, no-match).
- Cell-glow + jump wiring verified manually in the running app (multi-cell
  tab with duplicate symbols).
