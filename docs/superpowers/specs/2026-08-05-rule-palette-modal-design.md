# Rule palette as a modal

## Problem

The insert palette in the backtest rule editor renders inline, expanded under the
rule row it belongs to (`RulePalette` mounted inside `.bt-rule-row`). It pushes
the rules below it down, it has no styling of its own (`.rule-palette*` appears
nowhere in `App.css`), and it competes for width with the rule card.

## Design

The `+` on a rule row opens the palette as a **floating modal** instead of an
inline strip.

### RulePalette

Wraps its body in the shared `FloatingModal`:

- Props: `onInsert(text)`, `onClose()`, `title` (the call site passes
  `Insert into rule N`).
- `width={420}`, `initialPlacement="center"`. Drag handle, ✕, Esc, and
  click-away all come from `FloatingModal`.
- Body: an autofocused filter input, then the existing six groups — Candle,
  Indicators, Wrappers, Crosses, Conditions, Timeframes — as wrapping chip rows.
  Catalog entries keep their `Tooltip` detail.
- Filtering is case-insensitive against name, signature, and detail (candle
  fields and timeframe aliases match on their own text). Groups with no surviving
  item are hidden; when nothing matches at all, an `.al-note` "No matches" line
  shows. Enter inserts the first visible match.
- Picking an item calls `onInsert(text)` then `onClose()` — one insert per
  opening.

### Call site (`BacktestSettingsModal`)

- `paletteRow` stays as the open-row index; it now drives a single portaled
  modal rendered once per group rather than markup inside the row.
- The outside-mousedown + Escape effect and `paletteHostRef` are deleted —
  `FloatingModal` owns both. That effect's guard against Escape while the
  CodeMirror completion popup is up is dropped: the editor can't be focused
  while the palette is open, since a pick closes the modal immediately.
- The `+` button always opens (`setPaletteRow(i)`) and always reads `+`. It no
  longer toggles: `FloatingModal`'s capture-phase mousedown closer fires before
  the click, so a toggle would close-then-reopen.
- Disabled rows keep their frozen behavior — `+` disabled, and disabling a row
  closes an open palette.

### Styling

New `.rule-palette*` block in `App.css` beside the other `.bt-rule-*` rules:
group heading as a dim small-caps label, items as wrapping chip rows built on
the same tokens as `.bt-chip`, filter input matching the rule-card input chrome.

### Tests

`RulePalette.test.tsx` covers: portaled render with title, insert on click,
`onClose` after insert, filter narrows items and hides empty groups, Enter
inserts the first match, "No matches" for a dead filter. Existing group and
insert assertions carry over.
