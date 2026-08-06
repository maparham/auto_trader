# Infix Cross Operators (`x>` / `x<`) — Design

**Date:** 2026-08-07
**Status:** Approved

## Goal

Add infix cross operators to the rule DSL so `EMA(9) x> EMA(50)` reads like a
comparison. `x` is the crossing glyph; the angle bracket carries the direction:

- `a x> b` — a crosses above b (≡ `crossAbove(a, b)`)
- `a x< b` — a crosses below b (≡ `crossBelow(a, b)`)

`crossAbove` / `crossBelow` remain valid everywhere they work today. The infix
form is preferred: it is what completions insert, what the catalog leads with,
and what default rule configs use.

## Grammar & semantics

A row is a conjunction over adjacent operand pairs, where **at most one** pair
may be a cross:

```
EMA(9) x> EMA(50)                       ≡ crossAbove(EMA(9), EMA(50))
candle.close x< EMA(9)@1H               ≡ crossBelow(candle.close, EMA(9)@1H)
count(EMA(9) x> EMA(50), 10) >= 2       ≡ count(crossAbove(...), 10) >= 2
EMA(9) x> EMA(50) > EMA(200)            = cross(9→50) AND 50 > 200
EMA(9) > EMA(50) x> EMA(200)            = 9 > 50 AND cross(50→200)
EMA(9) x> EMA(50) x> EMA(200)           → error: only one cross per row
```

Both surface forms produce the identical `Cross` node (`fn` stays
`"crossAbove"` / `"crossBelow"`). A row that is a lone cross — either form —
still parses to a bare `Cross` node, so every existing rule keeps its exact
AST. Only a mixed chain widens anything: `Chain.parts` becomes
`list[Compare | Cross]` (TS: `Array<CompareNode | CrossNode>`).

`x>` / `x<` are also accepted as `count()`'s first argument via
`parse_condition`, producing the same `Cross` the function form does.
`Row` and `Count.cond` unions are unchanged.

## Lexing

In the identifier branch: a `NAME` scan that yields exactly `"x"` and is
immediately followed by `>` or `<` emits `XGT` / `XLT` (two-char token). This
is unambiguous — the DSL's vocabulary is closed (registry indicators, wrappers,
`candle`, `entry`, `barsSinceEntry`, pattern names), so a bare `x` operand
never exists.

Known edge, pinned by test rather than fixed: `50x> 60` lexes as `NAME("50x")`
(the digit branch absorbs trailing alphanumerics, as it must for `4H`), so it
is **not** a cross. Numbers need a space: `50 x> 60`.

`x >` (space between) and `X>` are NOT the operator; see `bad_cross_op` below.

## Parsing & errors

`XGT` / `XLT` join the existing comparison-chain loop in `parse_row`
(backend `parser.py:49`, frontend `parser.ts:229`) with symbols `"x>"` /
`"x<"` mapping to `Cross` parts. After the loop, one post-check counts cross
parts. Same treatment in `parse_condition` (single-comparison form).

| Input | Code | Message |
|---|---|---|
| `EMA(9) x> EMA(50) x> EMA(200)` | `multiple_crosses` *(new)* | Only one cross per row. |
| `EMA(9) > (EMA(9) x> EMA(50))` | `cross_not_toplevel` *(existing)* | A comparison or cross can only be the whole row. |
| `EMA(9) x > EMA(50)`, `X> …` | `bad_cross_op` *(new)* | Write the cross operator as `x>` or `x<` — lowercase, no space. |

- `multiple_crosses` spans from the second cross operator's left operand start
  to its right operand end.
- `cross_not_toplevel` for nested infix crosses comes from one guard in
  `expect()`: if the token that fails an expectation is `XGT`/`XLT`, raise
  `cross_not_toplevel` instead of `unexpected_token`. That single site covers
  parens, call arguments, and `count`'s window.
- `bad_cross_op` fires when a bare `NAME` token that is exactly `x` or `X`
  shows up where an operator is expected (`EMA(9) x > EMA(50)` — the
  `expected_operator` raise site checks for it) or where an operand is
  expected (`x> …` at row start — `parse_primary` checks before falling
  through to unknown-name `Call`). It can never be a valid operand, so both
  checks are safe.
- The `expected_operator` message in both parsers gains the new operators:
  "Expected a comparison operator (> < >= <= x> x<)."

## Invariant

Because both forms produce the same `Cross` node, evaluation/warmup/closeness
semantics for lone crosses and `count` conditions are untouched. The ONLY
semantic addition is `Cross` appearing inside `Chain.parts`.

## Chain consumers: what a `Cross` part touches

**No change** (already generic or already Cross-aware per part):
- `warmup.py:32` / `parser.ts:841` `warmupNode` — recurse per part; `Cross`
  case exists.
- `closeness.py:130` `row_closeness` — recurses per part via
  `row_gap_series`, which handles `Cross`.
- `nodes.py` `contains_tf` / `contains_bars_since_entry` — per-part recursion
  handles any node.

**Small change:**
- `evaluate.py:390` — `Chain` evaluation switches from
  `all(self._cmp(p, ...))` to `all(self._match_at(p, ...))`; `_match_at`
  already dispatches `Compare | Cross | Predicate`, reusing the existing
  cross-at-bar logic. (Predicate never appears in a chain; harmless.)
- `literals.py:149` and `validate.py:10` (frontend `parser.ts:756`, `:408`) —
  both walk `parts[0].left` / `p.right`; add a two-line part-operand accessor
  (left = `.left` | `.a`, right = `.right` | `.b`). Literal labelling for a
  cross part follows the existing top-level-`Cross` rule (`"constant"`).
- `nodes.py` `Chain.parts` type; `parser.ts:89` `ChainNode.parts`.

## Frontend surfaces

- **Lexer/parser** (`parser.ts`): mirror lexer token, `parse_row`,
  `parse_condition`, `expect` guard, new error codes.
- **Highlight** (`highlight.ts`): `classify` returns early on non-`NAME`
  operator types, so add `XGT`/`XLT` before that check, mapped to the `cross`
  mark (`cm-tok-cross`) — same color as `crossAbove`, not the generic
  `operator` mark.
- **Catalog** (`catalog.ts`): new `CROSS_OPS` entries
  (`x>` — "a crosses above b", `x<` — "a crosses below b") listed ahead of the
  function forms; the function-form entries stay.
- **Completion** (`complete.ts`): offer the infix operators when the user
  types `x`. Needs a candidate shape without `fnCandidate`'s paren-based
  `argFrom`/`argTo` scan (infix inserts have no parens); insert e.g.
  `x> EMA(50)` selecting the right operand, or plain `x> ` — implementer's
  choice, consistent with how comparisons behave today.
- **Defaults** (`backtestConfig.ts:196`): the default rule builder switches to
  infix strings; update `backtestConfig.test.ts` and
  `BacktestSettingsModal.test.tsx` accordingly.

## Parity corpus

`frontend/src/lib/expr/corpus.json` is the single shared fixture (consumed by
both `corpus.test.ts` and `backend/tests/test_expr_parser_corpus.py`). Add:

- lone infix crosses (both directions, with `@tf` pins and arithmetic operands)
- infix cross inside `count(...)`
- mixed chain: cross + comparison, in both orders
- `multiple_crosses`, `bad_cross_op` (spaced `x >`, uppercase `X>`),
  nested-in-parens `cross_not_toplevel` — with exact spans
- the `50x> 60` lexing edge (parses as unknown name → whatever error the
  validator produces today, pinned)

## Testing

Backend: extend `test_expr_parser.py` (parse shapes, error codes/spans),
`test_expr_evaluate.py` (mixed chain truth table incl. warm-up/undefined
bars), `test_expr_warmup.py`, `test_expr_closeness.py` (chain-with-cross
fold), `test_expr_validate.py`. Frontend: `parser.test.ts`,
`complete.test.ts`, corpus. Both suites: `.venv/bin/pytest` from `backend/`,
`cd frontend && npm run test:unit`.

## Out of scope

- Migrating stored `crossAbove(...)` strings (they stay valid).
- Migrating the ~126 native `title=` sites or any UI beyond the listed edit
  sites.
- New cross semantics (touch handling, equality windows) — the predicate is
  byte-for-byte the existing one.
