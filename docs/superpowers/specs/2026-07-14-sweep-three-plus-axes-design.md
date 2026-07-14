# Sweep with 3+ axes

Date: 2026-07-14
Status: Design approved, pending implementation plan

## Goal

Lift the 2-axis cap on backtest parameter sweeps: any number of sweep axes
can be active at once, bounded only by the total combo cap (raised to 1000).
The results heatmap stays a single 2D grid; with 3+ axes the user picks which
two axes form its rows and columns, and each cell shows the best result over
the collapsed (unpicked) axes.

This was deferred out of
`2026-07-14-sweep-operators-period-timewindow-design.md` ("Max 2 axes stays;
a 3-way cross is a follow-up").

## Background

Sweep enumeration is already N-axis generic: `enumerateCombos`,
`comboCount`, chunked execution (20 combos/request with progress + cancel),
risk mirroring, and the wire format all iterate over an arbitrary axis list.
Exactly two places assume 2 axes today:

1. `addAxis` in `BacktestSettingsModal.tsx` (~line 428): appends the new
   axis, then slices to the last 2 (FIFO drop-oldest).
2. `SweepResults.tsx` (~line 132): the heatmap renders only when
   `axes.length <= 2`, and `SweepHeatmap` hardcodes `axes[0]` / `axes[1]`
   as X/Y with an exact-match cell lookup (each cell matches exactly one
   row).

## Design

### Axis state and caps

- `addAxis` loses the slice: toggling a sweep glyph on always appends. There
  is no axis-count cap.
- `SWEEP_MAX_COMBOS` in `frontend/src/lib/sweep.ts` goes from 200 to 1000.
  Enforcement is unchanged: the modal footer shows the combo count and the
  Run button stays disabled while over cap.
- Everything else in the axis lifecycle (enumeration order, chunk size 20,
  progress, cancel, one-retry-per-chunk, `mirrorRiskAxes`,
  `materializePeriodAxes`, session-only state) is untouched.

### Heatmap with axis pickers (`SweepResults.tsx`)

- The `axes.length <= 2` gate is removed: the heatmap renders whenever at
  least one axis exists.
- With 3+ axes, two dropdowns render beside the existing color-metric
  dropdown: **X** and **Y**, listing the axes by label. Defaults: X = first
  axis, Y = second axis. Selecting in X the axis currently held by Y (or
  vice versa) swaps them, so X and Y can never be the same axis. With 1 or 2
  axes the pickers do not render and the layout is exactly today's.
- Picker state is component-local `useState` (like the color metric), never
  persisted. Pickers store axis **targets** (stable strings), not indexes;
  if a stored target is absent from the current axis list (a new sweep with
  different axes), that picker falls back to its default (X = first axis,
  Y = second axis, skipping whichever the other picker holds).
- **Cell semantics:** a cell matches every result row whose combo carries
  that cell's X and Y values. Among the matches, the cell represents the
  **best row by the selected color metric**: highest value wins, except
  `max_drawdown` where the smallest value wins (the same direction rule as
  the table's best-per-column highlight). The cell displays that best row's
  metric value. If every matching row failed (`metrics === null`), the cell
  shows `err` with the error tooltip, as today. With 1-2 axes each cell
  matches at most one row, so behavior is identical to today by
  construction.
- **Hover detail:** the existing header metric strip shows the best row's
  full metrics; when axes are collapsed (3+ axes), it is prefixed with the
  collapsed axes' values from that row, e.g. `@ RSI len 14`, so the user
  knows which underlying combo the cell represents.
- **Click:** applies the best row's combo (all axes' values, including the
  collapsed ones). The disabled-while-streaming rule is unchanged.
- No aggregate-function choice (mean/median/etc.): best-by-color-metric
  only.

### Combo table

Unchanged. It already renders every combo with full axis labels, sorting,
and best-per-column highlights, at any axis count.

## Out of scope

- Faceted / small-multiple heatmaps.
- Aggregate-function toggles (mean, median, worst).
- Persisting picker or heatmap state (sweep state stays session-only).
- Fixed-length + stride period windows (separate spec).
- Backend changes: none needed; the sweep wire format and chunk endpoint are
  already axis-count agnostic.

## Constraints

- No em dashes in any new copy, comments, or test strings.
- Shared `Tooltip` component only, never `title=`.
- Sweep axes and results remain session-only, never persisted.
- No legacy/back-compat paths: the FIFO drop and the `<= 2` gate are
  removed, not flagged.

## Testing

- `frontend/src/lib/sweep.test.ts`: 3-axis `enumerateCombos` produces the
  full cross-product in axis order; `comboCount` multiplies across 3+ axes;
  `SWEEP_MAX_COMBOS` is 1000.
- `frontend/src/BacktestSettingsModal.test.tsx`: toggling a third sweep
  glyph keeps all three axes active (no FIFO drop) and the footer count
  multiplies all three.
- `frontend/src/SweepResults.test.tsx`:
  - 3 axes render the X/Y pickers; 2 axes do not.
  - A cell whose X/Y values match multiple rows shows the best row's value
    for the selected metric, and clicking it applies that best row's full
    combo.
  - With `max_drawdown` selected, the best row is the minimum.
  - Picking X = current Y swaps the two pickers.
  - Hover on an aggregated cell includes the collapsed axis value in the
    detail strip.
