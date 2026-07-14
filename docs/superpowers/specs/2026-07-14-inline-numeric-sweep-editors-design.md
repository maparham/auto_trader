# Inline numeric sweep editors (SweepAxisRow retrofit)

Date: 2026-07-14
Status: Design approved, pending implementation plan

## Goal

Move the numeric sweep editors (from/to/step) for the existing sweep targets
(indicator length, const value, risk value/mult, exit "Nth time" count, coded
strategy params) from the standalone `SweepAxisRow` blocks to render **inline,
directly beneath their subject field**, matching the pattern the new sweep
dimensions (operator, period, time window) ship with. This removes the known
temporary UX inconsistency called out in
`2026-07-14-sweep-operators-period-timewindow-design.md`.

## Background

Today the numeric sweeps are half inline: the toggle glyphs (`.sp-sweep`)
already sit next to their fields (`OperandPicker` length/value, `CountField`,
`RiskSection` stop/target value/mult, `StrategyParams` params), but the
editors render in three standalone blocks in `BacktestSettingsModal.tsx`:

1. After `StrategyParams` (coded mode): `param:` axes.
2. After each coded-mode `RiskSection`: `risk:<side>.` axes.
3. After `SidePanel` (rules mode): all `rule:` and `risk:` axes, deliberately
   outside the side panel so a swept field on the inactive side tab stayed
   visible.

## Design

**Approach: reuse `SweepAxisRow`, move its render sites inline.** No new
component, no change to axis state, enumeration, mirroring, or the run path.

- Each component that owns a numeric sweep glyph also renders the axis's
  `SweepAxisRow` (label + from/to/step inputs, unchanged) directly beneath the
  field's row whenever the axis exists:
  - `OperandPicker`: beneath the operand row, for its `length` / `value` axis.
  - `CountField`: beneath the count row, for its `count` axis.
  - `RiskSection`: beneath the stop/target row, for that field's
    `value` / `mult` axis.
  - `StrategyParams`: beneath the param input, for its `param:` axis.
- These components already receive a `sweep` prop with `axes` and a toggle
  callback. They gain one more callback, `onAxisChange(target, patch)`, that
  the modal implements with the existing
  `setSweepAxes(axes => axes.map(...))` patch logic (single shared
  implementation passed down, not re-derived per site).
- The three standalone render blocks are deleted, along with the
  cross-side-visibility comment.
- **Inactive side (rules mode)**: an axis whose field lives on the unselected
  side tab has no visible editor; it still sweeps and still counts in the
  footer combo counter. Switching tabs shows its glyph (on) and its inline
  editor. This is a deliberate user decision ("inline only").
- **Synced risk** ("Same for long & short"): the axis is canonical on
  `risk:long.*`. The subject field renders on both side tabs, so the inline
  editor renders beneath the field on whichever tab is visible and edits the
  same canonical axis. Match on the canonical target (the same mapping the
  glyph's `swept()` check already uses).
- Layout/styling: the existing `.sp-row.sweep-axis-row` styles are reused
  as-is; if nesting inside a rule term or risk row needs an indent or width
  tweak, extend the existing classes in `App.css` rather than inventing new
  ones.

## Out of scope

- Any change to `SweepAxisRow`'s fields or behavior.
- Any change to axis enumeration, caps, mirroring, wire format, or backend.
- The operator / period / time-window editors (already inline).

## Constraints

- Max 2 axes, caps, and session-only axis state are untouched.
- No em dashes in any new copy, comments, or test strings.
- Shared `Tooltip` component only, never `title=`.
- No legacy/back-compat code paths; the standalone blocks are removed, not
  kept behind a flag.

## Testing

- Per site (operand length, operand const value, count, risk value, coded
  param): toggling the glyph on renders a `sweep-axis-row` inline within that
  field's section; editing `from/to/step` updates the axis (assert via the
  footer combo count or the axis passed to the run signal); toggling off
  removes it.
- Synced risk: with sync on, toggling from the short tab shows the inline
  editor there, and the footer count reflects one axis.
- Existing tests that asserted the standalone block locations are updated,
  not deleted, so coverage of the from/to/step editing behavior survives.
