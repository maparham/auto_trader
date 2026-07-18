# Prune degenerate (impossible) sweep combos

## Problem

A sweep grid can contain combos that are guaranteed to produce zero trades
because the entry rules contradict each other. Example (from the field): two
ANDed entry rules on the same operand, one `MA Slope 9 > 0.5` and one
`MA Slope 9 < -1`. No value satisfies both, so the combo runs, trades nothing,
and shows up as a `+0.00 / 0 trades` junk row. These waste sweep slots (compute
time), inflate the combo count and ETA, and clutter the results grid.

We want to detect and skip combos that are **provably impossible** before they
are submitted.

## Scope (decided)

- **Prune only provably-empty combos** (guaranteed 0 trades). No cross-combo
  dedup, no "redundant duplicate rule" pruning. One crisp meaning: impossible =
  skipped.
- **Prune before submit** on the frontend. Pruned combos never reach the
  backend, so combo count, the >1000 warning, and ETA all reflect the real grid.
- **Single-point ranges are kept.** `x >= a AND x <= a` means `x == a`, which is
  a real satisfiable condition — do not prune it. Only truly empty intervals go.
- **Bias toward under-pruning.** A false prune silently drops a wanted result
  with no error. Whenever operand identity or the proof is uncertain, keep the
  combo.

### Expanding past the literal selection (flag for review)

The user picked "const + equal-bound" scope and did **not** pick the separate
"also same-series contradictions" option. We fold same-series in anyway because
it is the *same* interval math with the bound placed on the operand difference
(`X > Y  ⇔  (X − Y) > 0`), so it costs ~zero extra code and is equally provable.
If you'd rather keep it out, delete the same-series normalization branch in
`normalizeRule` (below) and the two-non-const case simply never contributes a
constraint. **Call this out at the review gate.**

## Approach

### Module

New pure module `frontend/src/lib/sweepPrune.ts`. No React, no I/O. Unit-tested
in isolation (`sweepPrune.test.ts`).

### Operand identity

Reuse `seriesName(op)` from `backtestConfig.ts` as the canonical identity of a
non-const operand. It already encodes indicator + length + anchor + per-operand
`@timeframe` and `~slope` suffixes, so `slope@5m` and `slope@1h` are correctly
*different* identities and never collapse into a false contradiction. `const`
operands are not identities — they are the numeric bound. The `entry`
(entry-price) operand gets a fixed sentinel identity string.

### Resolving a combo to its effective rules

`applyComboToConfig(cfg, combo)` — a minimal frontend mirror of the backend's
`apply_rule_combo`, restricted to what satisfiability needs:

- `op:<side>.<entry>.<idx>` → patch that entry rule's `op`.
- `rule:<side>.<entry>.<idx>.(left|right).value` → patch that operand's const value.

Only **entry** groups are resolved (exit contradictions don't zero out trades —
they just never exit). `left/right.length`, `count`, `risk:`, `param:`,
`period:`, `timeWindow:` targets are irrelevant to entry satisfiability and are
ignored. Index convention matches the rest of the sweep code: position in the
**enabled-only** rule list. If a target's index is out of range for the current
config, skip that patch (do not throw) and, to stay safe, treat that group as
*not provably empty*.

Keep this mirror deliberately minimal; when in doubt it under-prunes.

### Normalizing a rule to a single interval constraint

`normalizeRule(rule) -> { key, bound, side, strict } | null`

Only rules whose `op ∈ {gt, gte, lt, lte}` produce a constraint; `crossesAbove`,
`crossesBelow`, `crosses` return `null` (transient events, not range bounds — a
group can still be proven empty from its remaining rules).

Cases:

1. **One const side** (`expr OP const`, or `const OP expr` — normalize by which
   side is the const, flipping the operator when the const is on the left):
   - `key = seriesName(expr)`
   - `bound = constValue`
   - `gt`/`gte` → lower bound (`side: "lower"`); `lt`/`lte` → upper bound.
   - `strict = (op === gt || op === lt)`.

2. **Both sides non-const** (`X OP Y`, both series/indicator/price/entry) — the
   same-series case. Canonicalize the pair by sorted identity so `X OP Y` and
   `Y OP' X` land on the same key:
   - `ka = seriesName(X)`, `kb = seriesName(Y)`; if `ka === kb` the two operands
     are identical → `X OP X` is a pure operator truth (`>` always false, `>=`
     always true) — handle as a constant truth (see step below), not an interval.
   - Order the pair; `key = "diff(" + min + "|" + max + ")"`. The constraint is
     on `signedDiff = first − second`. If we swapped operands to sort, flip the
     operator.
   - `bound = 0`, plus lower/upper/strict exactly as case 1 on that signed diff.

3. **Both const** (`c1 OP c2`): evaluate directly. If false, the whole group is
   unsatisfiable regardless of other rules (short-circuit). If true, contributes
   nothing.

### Detecting an unsatisfiable AND group

`isGroupUnsatisfiable(group) -> boolean`

- Return `false` unless `group.combine === "AND"` (an OR group can satisfy any
  single branch).
- Consider only `enabled !== false` rules.
- If any constant-vs-constant rule (case 3) evaluates false → `true`.
- Bucket all interval constraints by `key`. For each key compute
  `maxLower` (value + strictness, strict wins ties) and `minUpper`. Empty iff
  `maxLower > minUpper`, **or** `maxLower === minUpper && (lowerStrict ||
  upperStrict)`. Any key empty → group is unsatisfiable → `true`.
- Otherwise `false`.

Boundary truth table (verified): `x>=5 ∧ x<=5` keep · `x>5 ∧ x<=5` prune ·
`x>=5 ∧ x<5` prune · `x>=5 ∧ x<=3` prune · `x>5 ∧ x>3` keep.

### Degenerate combo = proven 0 trades

`isComboDegenerate(cfg, combo) -> boolean`

Resolve the combo (`applyComboToConfig`). A combo is degenerate iff **every
enabled entry side that has entry rules** is unsatisfiable:

- Long counts only if `longEnabled` and `longEntry.rules` is non-empty.
- Short counts only if `shortEnabled` and `shortEntry.rules` is non-empty.
- If neither side qualifies (no enabled side has entry rules), return `false`
  (we can't prove 0 trades — don't prune).
- Return `true` only when at least one side qualifies and *all* qualifying sides
  are `isGroupUnsatisfiable`.

This guarantees we never prune a combo whose other side can still trade.

### Public API

```ts
export function pruneCombos(
  combos: SweepCombo[],
  cfg: LabelConfig,          // reuse the existing rules-config slice
): { kept: SweepCombo[]; prunedCount: number };
```

## Wiring

The >1000 warning and the combo count shown in the modal are computed from
`comboCount(axes)` **before** `runSweep`. To keep count, warning, and submit on a
single source of truth, the modal does the enumerate + prune and hands the kept
set to `runSweep` via the existing `combosOverride` param:

- Modal: `const all = enumerateCombos(materialized); const { kept, prunedCount }
  = pruneCombos(all, cfg);`
- Warning/threshold and the displayed count use `kept.length`.
- Show `prunedCount` when > 0, e.g. `"420 combos (12 skipped: contradictory
  rules)"`.
- Pass `combosOverride: kept` to `runSweep`.

`runSweep` / `enumerateCombos` are otherwise unchanged (`enumerateCombos` only
has axes, not the rule config, so it cannot host the prune).

### Random search

Random search already samples a subset and submits it via `combosOverride`.
Prune the sampled set too; **accept fewer** submitted combos rather than
resampling to backfill (simpler; the sample is already approximate). Log/annotate
the pruned count the same way.

### All combos pruned

If `kept.length === 0` and `all.length > 0`, do **not** submit. Show a clear
message in place of the run, e.g. `"All N combos have contradictory entry rules
(0 possible to run)."` No job is created.

### Results grid

User chose prune-not-show, so pruned combos are simply absent. Confirm the
heatmap renders a missing combo as an empty hole without misaligning neighboring
cells (it already tolerates `metrics === null`; verify absence behaves the same).

## Testing

`sweepPrune.test.ts` covers:

- The five boundary cases in the truth table above.
- Const-on-left normalization (`0.5 < slope` ≡ `slope > 0.5`).
- Same-series contradiction (`X > Y ∧ X < Y` prune; `X >= Y ∧ X <= Y` keep) and
  the swapped-order pairing (`X > Y ∧ Y > X` prune).
- Per-timeframe identity: `slope@5m > 1 ∧ slope@1h < 1` is **kept** (different
  operands).
- `crosses` rules never cause a prune; a group of only-crosses is kept.
- OR group is never pruned even with contradictory branches.
- Two-sided: long-entry impossible but short still tradeable → kept; both sides
  impossible → pruned; disabled side ignored.
- Combo resolution: an `op:` axis flipping `>` to `<` turns a satisfiable base
  config into a pruned combo (and vice versa); out-of-range index → not pruned.
- `pruneCombos` returns correct `kept` + `prunedCount`; all-pruned case.

## Files

- `frontend/src/lib/sweepPrune.ts` (new)
- `frontend/src/lib/sweepPrune.test.ts` (new)
- `frontend/src/BacktestSettingsModal.tsx` (wire prune into count/warning/submit,
  all-pruned message)
- possibly `frontend/src/lib/sweepSearch.ts` (prune the random-search sample)

## Non-goals

- Cross-combo deduplication.
- Pruning redundant-but-satisfiable rules.
- Reasoning about `crosses` event operators.
- Backend changes (the backend still runs whatever it is given; this is a
  submit-side optimization).
