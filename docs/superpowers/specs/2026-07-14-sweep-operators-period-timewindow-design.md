# Sweep: operators, trading period, and trading time window

Date: 2026-07-14
Status: Design approved, pending implementation plan

## Goal

Add three new dimensions to the backtest parameter sweep, and give each new
dimension a sweep editor that sits **inline, next to its subject field**:

1. **Operator** per rule term: sweep a rule's comparison operator across a
   user-chosen subset of the 7 operators (crosses above / crosses below /
   crosses / greater than / less than / greater or equal / less or equal).
2. **Trading period** (walk-forward): split the configured backtest range into
   N equal, contiguous, non-overlapping windows and run each.
3. **Trading time window**: sweep the intraday active-hours window
   (`mask.timeOfDay`) across a user-chosen discrete list of windows / session
   presets.

Retrofitting the existing numeric sweeps (indicator length, const value, risk
value/mult, exit "Nth time" count) from the separate `SweepAxisRow` block to
the same inline affordance is explicitly a **follow-up**, not part of this work.
New dimensions ship inline; existing numeric axes stay in their current block
for now. This is a known, temporary UX inconsistency that the follow-up removes.

## Background: how sweeps work today

- **Axis model** (`frontend/src/lib/sweep.ts`): a `SweepAxis` is numeric-only,
  `{ target, mirrorTarget?, label, from, to, step }`. `axisValues()` walks the
  range; `enumerateCombos()` takes the cartesian product across axes, producing
  `Array<Record<target, number>>`. Caps: `SWEEP_MAX_COMBOS = 200` total,
  `SWEEP_CHUNK_SIZE = 20` per request; backend `_SWEEP_MAX_COMBOS = 50` per
  request. Max **2** axes at a time (`BacktestSettingsModal.tsx`).
- **Target grammar**: `param:<name>`,
  `risk:<side>.<stop|target>.<value|mult>`,
  `rule:<side>.<entry|exit>.<idx>.<left|right>.<length|value>`,
  `rule:<side>.<entry|exit>.<idx>.count`. `idx` is the position in the
  **enabled-only** rule list (`activeGroup()` drops disabled rules before POST).
- **Wire** (`SweepDTO.combos: list[dict[str, float|int|bool|str]]`): the combo
  value type already allows `str`, so operator/tz strings need no wire change.
- **Backend apply** (`backend/.../routers/backtest.py`): `backtest_sweep` posts
  one request with `combos`; the rule branch fetches HTF candles once, then per
  combo calls `_apply_rule_combo(req, combo)` -> `_run_rule(patched, candles,
  htf)`. `_apply_rule_combo` regex-matches each target and patches the rule tree
  via pydantic `model_copy(update=...)`; `risk:` keys defer to `_apply_combo`.
  One combo's failure becomes a `SweepRowDTO(error=...)`; an `HTTPException`
  (request-shaped) fails the whole chunk.
- **Series alignment**: `_run_rule` -> `_assemble_rule_series` ->
  `build_rule_series(ops, candles, ...)` recomputes native (indicator) series
  **from the candles passed in**, so native series always align to those
  candles. Chart-operand (`kind:"series"`) arrays are browser-supplied,
  full-length, and indexed by bar position.
- **Results** (`SweepResults.tsx`): sortable metric table over `SweepRow[]`;
  for exactly 1-2 axes it also renders a diverging heatmap (x = axis[0], y =
  axis[1]). Clicking a row/cell applies that combo.

## A. Axis foundation: discriminated-union `SweepAxis`

Generalize `SweepAxis` from numeric-only to a discriminated union:

```ts
type SweepAxis =
  | { kind: "range"; target: string; mirrorTarget?: string; label: string;
      from: number; to: number; step: number }
  | { kind: "list"; target: string; label: string; options: SweepOption[] }

interface SweepOption {
  label: string;                              // shown on results axis / heatmap
  patch: Record<string, string | number>;    // one-or-more combo keys this option writes
}
```

- `enumerateCombos` writes a `range` axis as `{ [target]: value }` (plus the
  `mirrorTarget` write, unchanged) and a `list` axis by spreading
  `option.patch`. A single option may write several combo keys at once (period
  writes `from`+`to`; time window writes `startMin`+`endMin`+`tz`).
- **Label resolution stays on the frontend.** Combos carry only the scalar keys
  the backend consumes; no display-only keys go on the wire. `SweepResults`
  reconstructs a `list` axis's per-row label by finding the option whose `patch`
  matches that row's corresponding combo keys. This keeps the wire minimal and
  the backend free of display concerns.
- Heatmap: for a `list` axis, the axis ticks are the option `label`s (ordinal),
  not numbers. `range` axes are unchanged.
- Existing numeric axes become `kind: "range"` with no behavior change.

## B. Operator dimension

- **Target**: `op:<side>.<entry|exit>.<idx>` (same `side/group/idx` grammar and
  enabled-only index convention as `rule:`).
- **Axis**: `kind: "list"`; one option per ticked operator, e.g.
  `{ label: "crosses above", patch: { "op:long.entry.0": "crossesAbove" } }`.
  The user may tick **any subset of the 7** operators for that term.
- **UI**: a sweep glyph next to the operator dropdown in a rule term. Toggling
  it on expands, inline directly beneath the operator control, a chip
  multiselect of the 7 operators (labels from the existing `OPERATORS` array).
  The currently-selected operator is pre-ticked. The axis is dropped when the
  user unticks down to a single operator or toggles the glyph off.
- **Backend**: add `_OP_TARGET = re.compile(r"^op:(long|short)\.(entry|exit)\.(\d+)$")`
  handling to `_apply_rule_combo`. Resolve the rule by side/group/idx (422 on
  out-of-range, same as `rule:`), then patch `rule.op`. **Validate the value is
  one of the 7 operator literals and 422 otherwise** - pydantic
  `model_copy(update={"op": value})` does NOT re-validate the `Literal`, so an
  explicit membership check is required before the copy.

## C. Trading-time-window dimension

- **Target**: `timeWindow` (a single axis; options enumerate the windows).
- **Axis**: `kind: "list"`; each option patches the intraday window plus its
  timezone, e.g.
  `{ label: "London 08:00-12:00",
     patch: { "timeWindow:startMin": 480, "timeWindow:endMin": 720, "timeWindow:tz": "Europe/London" } }`.
  Session presets (NYSE/London/Frankfurt/Tokyo/Sydney/Crypto) are **resolved to
  `timeOfDay` + `tz` on the frontend** (the same `resolveMask` inlining used
  before POST today), so each option carries an explicit tz. Custom windows use
  the mask's current tz (default "UTC").
- **UI**: a sweep glyph next to the time-of-day / session control. Toggling it
  on expands, inline, a discrete-list editor: rows of candidate windows, each
  added via time inputs (start/end) or a session-preset picker. Reuses the
  existing session/time picker components.
- **Backend**: add `timeWindow:*` handling. For each such combo, patch
  `req.mask.timeOfDay = { startMin, endMin }` and `req.mask.tz`. **If
  `req.mask is None`, synthesize an `enabled=true` mask** with empty day/month
  filters (= all bars active) carrying only this `timeOfDay` + `tz`. This runs
  in the sweep application step; no candle change is needed (the mask gates
  which bars are active, exactly as a normal masked run).

## D. Trading-period dimension (walk-forward)

- **Target**: `period` (a single axis); one user input **N** = number of
  windows.
- **Windows**: split the configured range `[from, to]` into N equal,
  contiguous, non-overlapping segments. Each option patches
  `{ "period:from": <unixSeconds>, "period:to": <unixSeconds> }`. Option labels
  are e.g. `W1 ... WN` (optionally with the date sub-range).
- **Candle posting**: the frontend posts the **union** candle span once - the
  full configured range plus the usual warm-up head. All N windows are
  sub-ranges of this union.
- **Backend, per period combo** (handled in the sweep loop, not
  `_apply_rule_combo`, because it touches candles):
  1. Set `tradeFromTime = period:from` (gates entries to the window start).
  2. Truncate the candle list to `time <= period:to`. Because we only cut the
     **end** and keep the union start, the truncated list is always a **prefix**
     of the posted candles. This preserves the warm-up head and lets:
     - native series recompute correctly from the prefix
       (`build_rule_series` is causal), and
     - chart-operand (`kind:"series"`) arrays slice to `[:len(prefix)]` and stay
       index-aligned (a prefix slice keeps position `i` on bar `i`).
  3. Run with the sliced candles + sliced chart series.
- **Metrics comparability** (verified): `compute_metrics` is span-invariant.
  `return_pct = net_pnl / starting_cash * 100`; `max_drawdown_pct` is
  peak-to-trough over the equity curve seeded at `starting_cash`; trade stats
  and `avg_duration_bars` are per-trade. A flat warm-up head at `starting_cash`
  adds **zero** drawdown and does not bias any reported metric, so the fact that
  later windows carry a longer flat head is harmless. No equity-windowing is
  needed; candle truncation is sufficient.
- **UI**: a sweep glyph next to the range / period control. Toggling it on
  expands, inline, a small "Windows: N" stepper.

## E. Inline sweep UI (new dimensions only)

One affordance for the three new dimensions: toggling a field's sweep glyph
expands that field's sweep editor **inline, directly beneath the field**:

- operator dropdown -> 7-operator chip multiselect,
- range/period control -> "Windows: N" stepper,
- time-of-day/session control -> candidate-window list editor.

The existing numeric axes (length/value/risk/count) keep rendering in the
current separate `SweepAxisRow` block until the follow-up unifies them. Follow
`CLAUDE.md`: use the shared `Tooltip`/`InfoTip` and existing shared components
(session picker, `NumberField`, chip inputs); do not hand-roll.

## Constraints and invariants

- **Max 2 axes** stays (a 3-way cross is a follow-up). The heatmap still renders
  for exactly 1-2 axes; a `list` axis contributes its option labels as ordinal
  ticks. Combo caps unchanged (200 total / 20 per request front, 50 back).
- Operator/period/time-window axes each count as one of the two axes and share
  the same enumerate/chunk/results pipeline as numeric axes.
- `SweepDTO.combos` wire type is unchanged (`str` already allowed).
- Combo values reaching the engine are validated server-side: operator ∈ the 7;
  bad/out-of-range `op:`/`period:`/`timeWindow:` targets 422 (request-shaped),
  consistent with the existing `rule:`/`risk:` behavior. A per-combo *runtime*
  failure still degrades to a `SweepRowDTO(error=...)` row.
- Disabled rules remain non-sweepable (their `idx` isn't in the enabled list).

## Implementation phasing

1. **Axis foundation**: discriminated-union `SweepAxis`, `enumerateCombos`
   list-axis support, `SweepResults` label resolution + heatmap ordinal ticks.
   Existing numeric axes migrate to `kind: "range"` with no behavior change.
2. **Operator** (validates the foundation end-to-end): frontend axis + inline
   chip multiselect; backend `_OP_TARGET` + operator validation.
3. **Time window**: frontend axis + inline window-list editor (session
   resolution to timeOfDay+tz); backend `timeWindow:*` patch + None-mask
   synthesis.
4. **Period**: frontend axis + inline N stepper + union-span posting; backend
   sweep-loop candle truncation + chart-series prefix slice + `tradeFromTime`.

Each phase is independently testable. Foundation and operator are the smallest
and de-risk the rest.

## Out of scope (follow-ups)

- Moving the existing numeric sweeps (length/value/risk/count) to the inline
  affordance.
- Crossing 3+ dimensions at once (raising the axis cap; non-heatmap results for
  3+ axes).
- Fixed-length + stride ("walk-forward with overlap") period windows; this spec
  does equal contiguous split only.
