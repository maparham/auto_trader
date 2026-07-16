# Backtest panel redesign (declutter + sweep inline chips + resize) — design

Date: 2026-07-16
Status: approved

## Problem

The backtest panel (`BacktestSettingsModal.tsx`, a fixed 720px docked `<aside>`) is
crowded and confusing, especially with sweep axes on:

- Each swept field injects a separate `SweepAxisRow` beneath its rule card with a
  duplicated label ("MA Slope 9 · SMA 9 < x sweep" + from/to/step), doubling the
  vertical footprint of every swept rule.
- Every rule row shows ~7 always-visible icon buttons (Δ, sweep, +, eye, swap,
  delete, kebab) and wraps raggedly when operands are long.
- Two stacked full-width colored segmented bars (Rules/Strategy, Long/Short) plus
  four group headers compete visually with the content.
- The footer mixes Inspect, Close, Go live, "9 × 5 = 45 runs", "45 combos",
  Sweep off, and Run sweep with no clear primary action.
- The panel width is fixed; wide rules have no room.

## Relationship to in-flight work

A separate agent is implementing the approved explicit Backtest/Sweep mode spec
(`2026-07-16-backtest-sweep-mode-design.md`): `backtestModeSignal`, a
`[ Backtest | Sweep ]` segmented switch with a combo/progress badge, mode-gated Run,
and results-follow-mode. **This redesign builds on that work and must not start
until it lands.** The mode switch slots into the new footer (section 5); dimmed
sweep editors in Backtest mode apply to the new range chips.

## Decisions (user-approved)

- Structural redesign, approach C: extract only the genuinely new pieces
  (`RangeChip`, `RunBar`), restructure rule rows in place, restyle the rest.
- Sweep range editing stays **inline** at the field it sweeps, as an in-place
  range chip (not a consolidated sweep section, not a separate injected row).
- Rule rows use a **structured two-line grid** — deliberate second line, never
  ragged wrapping.
- Coverage: rule card density, footer/run bar, section hierarchy, results region
  styling, no-linebreak rule rows, and left-edge panel resize.

## Design

### 1. Resizable panel

A 5px grab strip on the panel's left edge (`col-resize` cursor, subtle hover
highlight) drags the panel width. Clamp: min 560px, max `viewport − 380px`.
Width persists device-local as a flat key (`bt-panel-width`) added to
`DEVICE_LOCAL_FLAT_KEYS` so backend hydration doesn't prune it. Double-click
resets to the 720px default. Implementation mirrors the existing
settings/results vertical splitter (pointer capture on the handle).

### 2. Rule rows — structured two-line grid

Restructured inside `RuleGroupSection` (shared with `LiveTradingPanel`, which
inherits the new look):

- **Line 1**: left operand · operator · right operand. Operand chips get
  `min-width: 0` + ellipsis, full name in a shared `Tooltip`. Selects size to
  content. This line never wraps.
- **Line 2**: value or `RangeChip`, modifiers (Δ slope toggle, Nth-occurrence
  field, overflow @TF selects), right-aligned actions.
- **Actions**: only the sweep toggle and a kebab stay visible; eye (disable),
  swap, copy, delete move into the kebab menu. Icons render at 40% opacity
  until the row is hovered or focus is within. All existing aria-labels are
  preserved (tests select rule actions by accessible name).

### 3. `RangeChip` component

New `components/RangeChip.tsx`. When a field's sweep axis is on, the field's
value input is replaced in place by a chip reading `-2 … 2 / 0.5` with a small
step-count badge (`9×`). Clicking opens a popover with from/to/step
`NumberField`s, the per-axis run count, and a "Remove from sweep" action. The
chip reuses the existing axis-patch plumbing (`onAxisChange` etc.);
`SweepAxisRow` and its injected row are retired. Used for rule thresholds, risk
(SL/TP) fields, and coded-strategy params. In Backtest mode chips render dimmed
and disabled with the "Switch to Sweep mode to edit sweep ranges" tooltip (per
the mode spec).

### 4. Section hierarchy

- Rules/Strategy and Long/Short shrink from full-width colored bars to compact
  standard `seg` segmented controls; Long/Short keeps its side color as a small
  dot, not a fill.
- The "Trade the long side" arm switch row is folded compactly into the
  Long/Short area.
- Group headers (Buy to open, Sell to close, Stop & take profit, Scaling) get
  one unified small-caps style and consistent vertical rhythm; the AND/OR
  toggle moves into the group header line; group-level actions (copy-all,
  delete-all, collapse) are hover-revealed.

### 5. Footer — `RunBar` component

New `components/RunBar.tsx`, one clear primary action:

```
[ Backtest | Sweep ⚡45 ]      Inspect · Go live →      [ Run sweep ]
```

- Mode segment (from the mode spec) on the left with combo/progress badge.
- The "9 × 5 = 45 runs · 45 combos" duplication collapses into the badge plus
  one quiet caption near Run while in Sweep mode.
- Inspect and Go live become quiet text buttons; Close leaves the footer (the
  header × covers it).
- Run is the only filled primary button.

### 6. Results region + visual language

RESULTS header, sweep table, and heatmap adopt the same small-caps headers,
spacing, and tabular numerals. No structural change (results-follow-mode is the
mode spec's scope). Throughout: light-first, flat (no shadows), content-sized
controls, shared `Tooltip`/`InfoTip`, no em dashes in user-facing copy.

## Error handling / edge cases

- Range chip with an invalid range (step ≤ 0, from > to): chip shows a warning
  tint; the popover keeps the existing NumberField validation; Run disabling
  stays as-is (combo count logic unchanged).
- Resize on small viewports: if `viewport − 380px < 560px`, the panel pins to
  min width and the handle stops (no chart-destroying widths).
- Kebab menu obeys the app's dismiss-on-outside-click convention.

## Testing

- `RangeChip`: renders range + count, popover edits patch the axis, remove
  clears the axis, disabled/dimmed in Backtest mode.
- Rule row: existing `BacktestSettingsModal.test.tsx` rule-action tests keep
  passing via unchanged aria-labels; add a test that actions moved into the
  kebab remain reachable.
- `RunBar`: primary Run per mode, badge combo count, no Close button.
- Resize: drag updates width within clamps; double-click resets; width
  restored on reload (device-local key survives hydration).

## Sequencing

Implementation starts only after the explicit-mode agent's changes are
committed to main, and builds directly on `backtestModeSignal` and its footer
switch.
