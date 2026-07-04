# Inline leg autocomplete for synthetic expressions

**Date:** 2026-07-04
**Status:** Implemented — interaction model revised during build (see Revision below)

## Revision (as-built)

The interaction model changed while building, at the user's request:

- **A result click ADDS the symbol to the field — it never opens the chart.** The
  modal stays open so the user keeps composing. (Originally a plain click opened
  the symbol and a per-row **"+"** started the formula. The **"+" was removed**;
  the row click now does the insert.)
- **Enter opens the chart** — a valid synthetic expression (via `pickSynthetic`),
  or a single plain symbol that resolves to a catalogue epic (via `pick`). A
  matching single symbol also shows an **"↵ Open <epic>"** row (click to open).
- **Spread-operators toolbar (TradingView-style):** a toggle at the right of the
  input reveals clickable operator buttons **`÷ × + − ( ) 1/`** that insert into
  the box, so an expression can be built entirely with clicks. Power (`^`) is
  omitted — the backend combiner doesn't support it.

The rest of the design (formula-mode fragment search, `activeLegFragment` /
`insertLeg` helpers, last-token scope) is as written below.

## Summary

Make composing a synthetic expression (e.g. `OIL_CRUDE/DXY`) in the symbol-search
modal work like TradingView: the search box becomes **expression-aware** so a user
who doesn't know the exact epics can find each leg by name and insert it, instead
of having to type both epics from memory. Today a single click on a result opens
that symbol and closes the modal — there's no way to pick a leg for a formula.

This builds on the existing synthetic feature (typed-expression detection,
`registerSynthetic`, the "= … Synthetic" create-row). It changes only the
symbol-search modal's composition UX; the synthetic engine, registry, and chart
behavior are unchanged.

## Decisions (locked)

| Question | Decision |
|---|---|
| Approach | Inline leg autocomplete (expression-aware search box) |
| Start/extend a formula | A per-row **"+"** (add-to-formula) button; plain click still opens |
| Autocomplete scope | The **last** token (text after the last operator) — NOT cursor-aware in v1 |
| Open the synthetic | Enter, or the existing "= …" create-row (both gated on a valid expression) |
| Out of scope (v1) | Cursor-aware editing of a middle leg; a dedicated builder dialog; operator auto-suggestion |

## Behavior

### Formula mode
The box is in **formula mode** when its text contains any operator (`+ - * / ( )`)
— reuse the existing `isSyntheticExpr(text)`. In formula mode:

1. The results list searches only the **active leg fragment** (see below), not the
   whole box text.
2. A plain result **click inserts** that leg into the box (does not open / does not
   close the modal).
3. **Enter** — or clicking the existing "= …" create-row — opens the synthetic,
   but only when the whole expression parses and every leg resolves against the
   catalogue (the existing `syntheticCandidate` validation).

Outside formula mode the modal behaves exactly as today: the debounced keyword
search runs on the whole query, a plain click opens the symbol and closes the
modal, and the category chips browse the catalogue.

### The per-row "+" button
Every result row gains a small **"+"** button beside the existing star. It
`stopPropagation`s (so it never triggers the row's open-on-click) and inserts the
row's epic into the box via `insertLeg` (below), then keeps the modal open and
returns focus to the input with the cursor at the end. This is the entry point for
the **first** leg (which would otherwise open on click) and a convenience for later
legs. Once the box already contains an operator, a plain row click inserts too (the
user is clearly composing) — the "+" and the row click do the same thing in that
state.

### Active leg fragment + insertion (pure helpers, in `syntheticExpr.ts`)

- `activeLegFragment(text: string): string` — the substring after the last
  operator/paren in `text`, trimmed. For `"OIL_CRUDE / dx"` → `"dx"`; for
  `"OIL_CRUDE /"` → `""`; for `"oil"` → `"oil"`. This is what the results search
  targets in formula mode, and what a pick replaces.
- `insertLeg(text: string, epic: string): string` — returns `text` with the active
  leg fragment replaced by `epic`, normalizing spacing so the result reads
  cleanly. Cases:
  - empty/whitespace `text` → `epic`
  - `text` ends in an operator (optionally + spaces) → `text` + `" "` + `epic`
    (e.g. `"OIL_CRUDE / "` → `"OIL_CRUDE / DXY"`)
  - `text` ends in a leg fragment → replace that fragment with `epic`
    (e.g. `"OIL_CRUDE / dx"` → `"OIL_CRUDE / DXY"`)
  The returned string always leaves the cursor conceptually at the end (callers set
  the input value then move the caret to `value.length`).

### Results search in formula mode
The existing debounced search effect (keyed on `[query, brokerId]`, calling
`searchInstruments`) is changed to search `activeLegFragment(query)` when in
formula mode, and the whole `query` otherwise. When the active fragment is empty
(the user just typed an operator), the list shows a hint row
("Type to search the next leg…") instead of running an empty search.

### Opening on Enter
Add an `onKeyDown` on the search input: when `Enter` is pressed and
`syntheticCandidate` is present with `missing.length === 0`, call the existing
`pickSynthetic(expr)` (register + `onPick` + close). Otherwise Enter does nothing
new (no first-result-open behavior is being added — that's out of scope). The
create-row remains clickable as the visible equivalent.

## Components / files

- `frontend/src/lib/syntheticExpr.ts` — add `activeLegFragment` and `insertLeg`
  (pure). Extend `syntheticExpr.test.ts`.
- `frontend/src/SymbolSearchModal.tsx` — formula-mode search targeting, the per-row
  "+" button + insert handler, the empty-fragment hint, and the Enter-to-open
  handler. Extend `SymbolSearchModal.test.tsx`.
- `frontend/src/App.css` — style the "+" button (mirror `.ss-star`) and, if needed,
  the hint row.

No backend changes. No change to `syntheticRegistry`, the feed, or the chart.

## Testing

- **Pure (`syntheticExpr.test.ts`):**
  - `activeLegFragment`: `"OIL_CRUDE / dx"`→`"dx"`, `"OIL_CRUDE /"`→`""`,
    `"oil"`→`"oil"`, `"(AAPL+ms"`→`"ms"`, trailing spaces trimmed.
  - `insertLeg`: empty→epic; ends-in-operator appends; ends-in-fragment replaces;
    spacing normalized (`"OIL_CRUDE / dx"`,`"DXY"`→`"OIL_CRUDE / DXY"`).
- **Component (`SymbolSearchModal.test.tsx`, RTL + jsdom, mock `./lib/feed`):**
  - Clicking a row's "+" inserts its epic into the box and does NOT call `onPick`
    or close the modal.
  - In formula mode, typing after an operator searches the active fragment (assert
    the mocked `searchInstruments` was called with the fragment, not the whole box),
    and a plain row click replaces the fragment (does not open).
  - Pressing Enter on a valid expression (`OIL_CRUDE/DXY`, both legs in the mocked
    catalogue) calls `onPick` with a `SYN_` epic and `type === "SYNTHETIC"`.
  - An unknown leg still shows the "Unknown instrument…" message and no open.

## Out of scope (v1)

- Cursor-aware autocomplete (editing a leg in the middle of the expression).
- A dedicated synthetic builder dialog.
- Operator auto-suggestion / auto-formatting of the box while typing.
- Any change to how synthetic charts render, persist, or compute.
