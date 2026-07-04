# Tooltip Migration — Phase 1 (High-Leverage Wrappers) — Design

Date: 2026-07-05

## Problem

The unified `<Tooltip>` component (and its `InfoTip` composition) now exists, but
most of the app still shows the slow, unstyled native browser tooltip via raw
`title=` attributes. A full survey found the real migration surface is smaller
than it looks:

- **37 sites** already render through `<Tooltip>` (via `InfoTip`) — done, no action.
- **26 call sites** are threaded through 3 wrapper components (`SortHeader`,
  `Stat`, `ColorLineStylePicker`) that each render one `title=` internally — fixing
  the wrapper fixes every call site for free.
- **~126 standalone sites** have `title=` written directly at the call site,
  scattered across ~20 files.
- **10 sites** are false positives — components that happen to have a `title` prop
  used as heading/label text (`Section`, `RuleGroupSection`, `ConfirmDialog`,
  `MarketInfoPopover`, `CandleCacheStatsModal`) — not tooltips, out of scope.
- **`src/IndicatorRow.tsx`** is a third, previously-uncounted hand-rolled ⓘ tooltip
  (its own `useState`/`useRef`/portal, duplicating what `InfoTip` already does),
  found during the unified-Tooltip final review. 2 call sites.

This phase covers the highest-leverage, lowest-risk slice: the 3 wrapper
components (26 call sites, 0 call-site changes needed) plus `IndicatorRow.tsx`
(2 call sites, self-contained file). The ~126 standalone direct sites are
explicitly deferred to a follow-up phase.

## Goals

- Fix `SortHeader`, `Stat`, and `ColorLineStylePicker` so every existing caller's
  `title` prop renders through `<Tooltip>` instead of a native `title=` attribute,
  with **zero changes to any call site**.
- Fold `IndicatorRow.tsx`'s hand-rolled tooltip mechanics onto the shared
  `InfoTip` component, removing the last hand-rolled portal-based tooltip in the
  codebase.
- No visual/behavioral regression: existing call sites keep working exactly as
  before, just with the new component's animation/timing/positioning.

## Non-goals

- Migrating the ~126 standalone direct `title=` sites — a separate follow-up spec.
- Renaming any prop (`title` stays `title` on all 3 wrapper components — only the
  internal render changes, so this phase touches 4 files total, not 24).
- Touching the 10 false-positive heading-prop components.

## Approach

For each of the 3 wrapper components, the prop signature and every call site are
left untouched. Only the internal render changes: the element that used to carry
`title={title}` is wrapped in `<Tooltip content={title}>...</Tooltip>` instead.
`Tooltip` already renders its children bare when `content` is empty/undefined (the
`isEmpty` check in `Tooltip.tsx`), so no conditional wrapping logic is needed —
wrap unconditionally, and callers who never pass `title` get an inert wrapper with
no behavior change.

### `SortHeader` (`frontend/src/PositionsPanel.tsx:754-780`)

Currently:
```tsx
<button
  className={`pp-sort${active ? " on" : ""}`}
  onClick={() => onSort(col)}
  title={title}
  aria-sort={...}
>
  ...
</button>
```
Becomes: the `<button>` (including its `aria-sort`, `onClick`, children) wrapped
in `<Tooltip content={title}>`, with the `title={title}` attribute removed from
the button itself. Fixes all 14 `<SortHeader>` call sites (every sortable column
header in the positions/orders table) with no call-site edits.

### `Stat` (`frontend/src/PositionsPanel.tsx:733-750`)

Currently:
```tsx
<div className="pp-stat" title={title}>
  <span className="pp-stat-label">{label}</span>
  <span className={...}>{value}</span>
</div>
```
Becomes: the `<div>` wrapped in `<Tooltip content={title}>`, `title` attribute
removed from the div. Fixes all 7 `<Stat>` call sites (the account stats strip —
Balance, Equity, Margin, etc.).

### `ColorLineStylePicker` (`frontend/src/ColorLineStylePicker.tsx`)

This file has 5 distinct native `title=` locations — the swatch trigger (threaded
via the `title` prop, line 146) plus 4 more that are internal to this component
regardless of the `title` prop (palette cell hex code at line 190, "Custom color"
at line 202, thickness presets at line 244, line-style presets at line 265). Since
the file is already being touched for the wrapper-prop fix, all 5 are wrapped in
this same task rather than leaving the file half-migrated:

- Line 146 (main swatch `<button>`): wrap in `<Tooltip content={title ?? "Color & line style"}>`.
- Line 190 (palette cell `<button>`, one per swatch in the 60-color grid): wrap in `<Tooltip content={c}>`.
- Line 202 ("Custom color" `<button>`): wrap in `<Tooltip content="Custom color">`.
- Line 244 (thickness preset `<button>`, one per size in `SIZES`): wrap in `<Tooltip content={`${s}px`}>`.
- Line 265 (line-style preset `<button>`, one per option in `lineStyleOptions`): wrap in `<Tooltip content={LINE_STYLE_LABEL[opt]}>`.

Fixes the 5 explicit callers (`Settings.tsx:159,169,185`, `IndicatorSettings.tsx:1923,2024`)
plus the 4 callers relying on the default title, with no call-site edits, and
brings the popover's own internal titles onto the new component too.

### `IndicatorRow.tsx`

Currently a self-contained hand-rolled tooltip: local `useState<{x,y}|null>`,
`useRef`, a `showTip()` that reads `getBoundingClientRect()`, manual
`onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur`, and its own `createPortal(...,
document.body)` rendering a raw `.ind-tooltip` div. This duplicates exactly what
`InfoTip` already does.

Becomes:
```tsx
import InfoTip from "./components/InfoTip";
// ...
{desc && <InfoTip title={title} text={desc} />}
```
removing the local `tip` state, `infoRef`, `showTip`, and the manual portal block
entirely (~25 lines deleted). The favorite-star button's native `title=` (line 34,
`"Remove from favorites"` / `"Add to favorites"`) is also wrapped in
`<Tooltip content={...}>` in this same task, since the file is already open for
the fold. The file-header comment (lines 1-7) explaining the manual-portal
clipping workaround is now obsolete (the workaround is inherited for free from
`InfoTip`/`Tooltip`'s own portal-to-`<body>` strategy) and gets updated to reflect
the simpler implementation. 2 call sites in `Toolbar.tsx:586,598` (the "add
indicator" dropdown for the main pane and sub-panes) need no changes.

## Testing

- Each wrapper component (`SortHeader`, `Stat`, `ColorLineStylePicker`) already
  has behavior covered indirectly by whatever existing tests exercise
  `PositionsPanel`/settings-modal rendering; this phase's tests specifically
  verify the wrapping is correct: rendering with a `title` prop shows a
  `role="tooltip"` on hover/focus (via `Tooltip`'s own already-tested mechanics),
  and rendering without one behaves identically to today (no tooltip, no crash).
- `IndicatorRow.tsx` gets a focused test: renders with a `desc`, hover/focus the
  ⓘ shows the description via `InfoTip`; renders without a `desc`, no ⓘ button at
  all (existing `desc &&` guard preserved); the star button's tooltip text
  matches favorite state.
- Full suite + `tsc --noEmit` clean after each task.
- **Visual layout check required for `SortHeader` and `Stat`.** The final review
  of the original `Tooltip`/`InfoTip` work established that wrapping a *trailing*
  icon (preceded by a `flex:1` sibling) in `Tooltip`'s `inline-flex` span is
  layout-inert. `SortHeader` and `Stat` are a different DOM context — the button
  (inside a `<th>`) or the div (inside a flex stats row) is the *sole* / *sized*
  child, so the wrapper span becomes the new flex/cell child instead of the
  original element. This is expected to still be layout-neutral (`inline-flex`
  sizes to its content, same as the element it wraps), but must be visually
  confirmed by running the app and checking the positions table header row and
  the account stats strip, not just asserted from the CSS.

## Out of scope / follow-up

The ~126 standalone direct `title=` sites (mechanical `title="x"` →
`<Tooltip content="x">` wraps across ~20 files, no shared wrapper to fix) are a
separate follow-up spec, tackled next.
