# Friendly sweep axis labels + sweep progress in the backend log

Date: 2026-07-15
Status: Design approved, pending implementation plan

## Goal

Two small sweep UX improvements:

1. Rule and risk sweep axes get human labels (operand name + field) instead
   of raw target paths like `long.entry.0.right.value`, everywhere axes are
   shown: inline editors, footer count, heatmap pickers/ticks, hover detail,
   and the combo table.
2. The backend log shows sweep progress with real position in the whole
   sweep (`combos 21-40 of 48`), per chunk, at INFO level.

## Background

`SweepAxis.label` is the single display string used by every axis render
site (`comboAxisText` in `frontend/src/lib/sweep.ts` composes combo text
from it). Coded-param axes get a proper label from their `ParamSpec`. Rule
and risk axes have no spec to draw from, so their toggle handlers in
`BacktestSettingsModal.tsx` fall back to the target path:

- `toggleRuleSweepAxis` (~line 475): `label = target.replace(/^rule:/, "")`
- `toggleRiskSweepAxis` (~line 457): `label = target.split(".").slice(1).join(" ")`
- `toggleOpSweepAxis` (~line 494): `label = <path> + " op"`

This was flagged as follow-up work in the inline-sweep-editors feature.

For progress: the frontend chunks a sweep into ~20-combo requests to
`POST /api/backtest/sweep` and tracks done/total itself (it feeds the
in-app bar). The backend sees each chunk in isolation and logs nothing
about sweep progress.

## Design

### Part 1: axis labels resolved from the config

A pure resolver in a new module, `frontend/src/lib/sweepLabels.ts` (pure
function over the config, unit-testable without rendering the modal):

```
axisLabel(target: string, cfg: BacktestConfig): string
```

It parses `rule:`, `op:`, and `risk:` targets (the DTO grammar in
`SweepDTO`, mirrored in `sweep.ts` line 19) and looks the subject up in the
current config. `param:`, `period:`, and `timeWindow:` targets keep their
existing labels (ParamSpec label, "Period", time-window label) and never
reach the resolver.

Label format (decided with the user):

- Operand display name + operator symbol + field, no "entry" wording:
  - right-operand value: `MA Slope 9·SMA 9 > x`
  - left/right operand length: `MA Slope 9·SMA 9 length`
    (side of the comparison added only if both sides have a length axis on
    the same rule: `MA Slope 9·SMA 9 length (right)`)
  - exit count: `MA Slope 9·SMA 9 > x, Nth`
  - operator axis: `MA Slope 9·SMA 9 op`
- Operand display name comes from the operand itself: a `series` operand
  already carries `.label` (the chart-operand chip text, e.g.
  `MA Slope 9 · SMA 9`); native operands compose `<INDICATOR> <length>`
  (`EMA 21`, `RSI 14`), `price`, or `value` for a const. The exact
  composition helper is shared with nothing today and lives next to
  `axisLabel`.
- Disambiguation: if two axes would render the same label, prefix side and
  1-based rule number as `Long 1 · `, `Short 2 · ` (the word "entry" is
  never used; exit rules read `Long exit 1 · `). The prefix is applied to
  all colliding labels, not just the second one.
- Risk axes: `<Side> <stop|target> <kind>` using the existing kind wording,
  e.g. `Long stop %`, `Long stop ATR ×`, `Short target %`. When the
  "Same for long & short" sync is on, the label stays the long-side one
  (mirroring already canonicalizes to long).

When labels resolve:

- Pre-run render sites (inline `SweepAxisRow` editors, footer count) show
  `axisLabel(axis.target, cfg)` computed at render time, so editing a rule
  immediately updates its axis label.
- At run time, right where the axes are materialized and written for the
  run (the `materializePeriodAxes` call site), each axis's `label` is
  overwritten with `axisLabel(...)` against the config as it runs. Results
  (`ranAxes`: heatmap pickers, ticks, hover detail, combo table) therefore
  describe the run as it ran, even if rules are edited afterwards.
- The stored `label` written at toggle time becomes a fallback only (used
  if a target no longer resolves, e.g. the rule was deleted after the run
  snapshot, which cannot happen for `ranAxes` but keeps the function total).

Axes stay session-only, never persisted. Targets, enumeration, mirroring,
wire format: unchanged.

### Part 2: sweep progress in the backend log

Wire: `SweepDTO` gains two optional ints, `done` and `total`. The frontend
chunk sender in `runSweep` (`frontend/src/lib/sweep.ts`) fills them with
the combos completed before this chunk and the total combo count (it
already tracks both for the in-app progress bar). The backend reads them
for logging only; combos semantics, chunk size, retry, and `SweepResponse`
are untouched.

Backend (`backtest_sweep` in `auto_trader/api/routers/backtest.py`),
via the router's existing `logger`:

- Chunk start, INFO:
  `sweep US100 HOUR: combos 21-40 of 48 (rule mode)`
  (`coded mode` for the coded branch; the range is `done+1` to
  `done+len(combos)`).
- Chunk end, INFO:
  `sweep chunk done in 12.3s: 20 ok, 0 failed (40/48)`
  (`failed` counts rows returned with `error` set; elapsed via
  `time.monotonic`).
- Per combo, DEBUG: index in the whole sweep, the combo dict, and elapsed
  seconds, so a hung or slow combo is diagnosable.
- When `done`/`total` are absent (manual curl), the same lines log the
  chunk-local form: `sweep US100 HOUR: 20 combos (rule mode)` and
  `sweep chunk done in 12.3s: 20 ok, 0 failed`.

## Out of scope

- Single-run status monitor (dropped by user decision).
- Any change to the in-app sweep progress bar or a cancel control.
- Persisting labels or any sweep state.
- Backend validation of `done`/`total` beyond pydantic int typing (they
  are advisory, logging-only).

## Constraints

- No em dashes in any new copy, comments, or test strings.
- Shared `Tooltip` component only, never `title=`.
- Sweep axes and results remain session-only.
- No legacy/back-compat paths (the new DTO fields are optional because the
  value is genuinely optional, not to support old clients).
- Plain, concise label copy; standard trading terms are fine.

## Testing

- Label resolver unit tests (`frontend/src/lib/sweepLabels.test.ts`): rule
  right-value, operand length, exit count,
  operator axis, series-operand label passthrough, native operand
  composition, risk stop/target kinds, the collision prefix (`Long 1 · `),
  and the unresolvable-target fallback to the stored label.
- A test that ran results keep run-time labels: run a sweep (mocked), edit
  the rule, assert the results table/heatmap still show the run-time label
  while the inline editor shows the new one.
- Frontend: `runSweep` sends `done`/`total` on each chunk (assert on the
  mocked fetch bodies: 0/N then 20/N ...).
- Backend (`backend/tests/test_api_backtest_sweep.py`): a chunk with
  `done`/`total` logs the positioned start and done lines (caplog), a chunk
  without them logs the chunk-local form, and `failed` counts error rows.
