# Chained Comparisons Design

**Date:** 2026-07-22

**Goal:** Let a single rule expression chain comparisons, e.g.
`candle.close > EMA(9) > EMA(50)`, parsed as the AND of consecutive
comparisons. Today this raises `unexpected_token` ("Expected eof here.") and
surfaces as a 422.

## Motivation

`close > EMA(9) > EMA(50)` is the standard stacked-EMA alignment idiom
(price above the fast EMA, fast above the slow). Traders expect to write it in
one row. The grammar currently allows exactly one comparison per row, so the
second `>` is a parse error with a confusing message.

## Semantics

- `a op1 b op2 c op3 d …` means `(a op1 b) AND (b op2 c) AND (c op3 d) …`.
  Each link compares consecutive operands; the shared middle operand appears in
  two links.
- Operators may be mixed freely (`> < >= <=`); there is **no** direction
  (monotonicity) check. `close > EMA(9) < EMA(50)` is valid and means
  `close > EMA(9) AND EMA(9) < EMA(50)`.
- A chain is **atomic within its row**. When a rule group combines rows with
  OR, the chain's internal AND still holds: a chained row is one row, folded
  into the group as a unit.
- `crossAbove` / `crossBelow` remain whole-row only and cannot appear inside a
  chain (unchanged: the parser handles a cross function as an alternative top
  level, never as a chain operand).
- A single comparison (one link) is unchanged: it still parses to `Compare`,
  not `Chain`. Existing rules and their serialization are unaffected.

## Node model

New frozen dataclass in `backend/auto_trader/strategy/expr/nodes.py`:

```python
@dataclass(frozen=True, slots=True)
class Chain:
    parts: list["Compare"]   # length >= 2; consecutive links
    start: int
    end: int
```

- Added to the `Node` union.
- `contains_tf(Chain)` returns True if any part contains a `Tf`.
- The frontend mirror (`frontend/src/lib/expr/parser.ts`) gains an analogous
  `ChainNode { kind: "Chain"; parts: CompareNode[]; start; end }` added to the
  `Row` union.

Consecutive `Compare` parts share operand node objects (the right side of link
_i_ is the left side of link _i+1_). This is safe: nodes are immutable and the
evaluator caches by `id(node)`, so sharing only helps.

## Parser

`parse_row` (backend `parser.py`, frontend `parseRow`): after the first
`arith cmpop arith`, loop while the next token is a comparison operator,
building one `Compare` per link between consecutive operands.

- 1 link  -> return the `Compare` (backward compatible).
- 2+ links -> return `Chain(parts, parts[0].start, parts[-1].end)`.
- The cross-function branch is unchanged and returns before this loop.
- `expect("EOF")` runs after the loop, so trailing garbage still errors.

## Validation

`validate` (backend `validate.py`, frontend `walk`):

- `Chain`: validate each part's `left` and `right` operands with the existing
  operand walker. No new error codes.
- The existing nested-comparison guard (`cross_not_toplevel`: "A comparison or
  cross can only be the whole row.") is extended to also reject a `Chain`
  reached as a sub-node, for symmetry. In practice the parser never nests a
  Chain, so this is defensive.

## Warmup

`warmup_bars(Chain)` = `max(warmup_bars(part) for part in parts)` (backend
`warmup.py`, frontend `warmupNode`). Each part's warmup is the existing
`Compare` warmup (max of its two operands).

## Evaluation

`backend/auto_trader/strategy/expr/evaluate.py`:

- Extract the per-`Compare` boolean logic in `CompiledRow.evaluate` into a
  helper `_eval_compare(op, l, r) -> bool` (or evaluate a single Compare node).
- `CompiledRow.node` type widens to `Compare | Cross | Chain`.
- `evaluate(i, entry)`: for a `Chain`, return True only if every part holds
  (AND). An undefined operand in any part makes that part False (existing
  `_defined` semantics), so the chain is False.
- `compile_row`: precompute operand arrays for every part's `left` and `right`
  (loop the parts, reuse the existing `_precompute` per operand).

## Closeness (heatmap)

`backend/auto_trader/strategy/expr/closeness.py`:

- `row_closeness(Chain, …)`: compute `row_closeness` for each part and fold with
  `min` per bar (AND), poisoning the bar to None if any part is None. This is
  the same strict-fuzzy AND used by `group_closeness`. Factor the AND fold so
  both call sites share it, or inline the min-with-None-poison loop.
- `row_gap_series` stays single-gap and is not called for a `Chain` directly;
  `row_closeness` dispatches on `Chain` before computing a gap series.
- `group_closeness` is unchanged: it calls `row_closeness` per row, which now
  handles `Chain`. A group of chained and plain rows folds normally.

Effect: the heatmap warms toward 1 only as the *whole* stack approaches
alignment; the least-close link caps the row (min), matching the AND meaning.

## Router

`backend/auto_trader/api/routers/expr.py`:

- `_referenced_tfs(Chain)` = union of `_referenced_tfs` over all parts'
  operands.
- The `/api/expr/series` plot picks the primary series to draw. Today:
  `top = node.left if hasattr(node, "left") else node.a`. For a `Chain`, plot
  the first part's `left` operand (`node.parts[0].left`).

No changes to `sweep_apply.py`, `routers/charts.py`, or `routers/strategy.py`:
they parse/validate/compile through the shared functions, which now handle
`Chain`. Type hints that read `Compare | Cross` may be widened for accuracy but
are not enforced at runtime.

## Frontend mirror

`frontend/src/lib/expr/parser.ts` drives the CodeMirror editor's lint,
validation, warmup readout, and chart-token extraction. Without the matching
change it would red-underline a valid chained expression. Update, mirroring the
backend:

- `Row` union gains `ChainNode`.
- `parseRow` loops over trailing comparison operators (same 1-link vs 2+-link
  rule).
- `walk` (validate) handles `Chain`.
- `containsTf`, `warmupNode` handle `Chain`.
- `render` renders a `Chain` as its parts joined by their operators
  (`a > b > c`), so round-tripping a chained row is stable.
- `hasIndicator` and the chart-token `collect` handle `Chain` (collect from the
  first part's left operand, matching the series-plot choice).

Token highlighting (`highlight.ts`) and completion (`complete.ts`) are
token-based, not AST-based, so they already handle repeated operators and need
no change.

## Testing

Backend (pytest):

- Parser: `a > b > c` -> `Chain` with 2 parts and correct shared operands;
  `a > b` -> `Compare` (no Chain); mixed operators `a > b < c` parses; a chain
  with a trailing operator errors; cross function still whole-row.
- Validate: a chain with a bad operand (e.g. `candle` without a field, bad
  arity) raises the existing error; a valid chain passes.
- Warmup: `close > EMA(9) > EMA(50)` warmup == 50.
- Evaluate: on a candle series, a chain is True only when every link holds;
  one undefined operand makes it False.
- Closeness: a chain's row closeness equals the per-bar min of its parts'
  closeness, None-poisoned; verify against `row_closeness` of each part.
- Router: `/api/expr/series` on a chain returns the first-left series;
  `_referenced_tfs` unions across parts (`close@D > EMA(9)@H > EMA(50)`).
- Regression: the original failing rule `candle.close>EMA(9)>EMA(50)` now
  parses, validates, and returns closeness without a 422.

Frontend (vitest): mirror the parser/validate/warmup/render cases in
`parser.test.ts`; a chained expression lints clean (no diagnostics).

## Out of scope (YAGNI)

- Explicit boolean `AND` / `OR` keywords inside an expression. Chains cover the
  requested idiom; group-level combine already provides OR.
- Direction/monotonicity enforcement (decided: allow any mix).
- Betweenness sugar or interval syntax.
