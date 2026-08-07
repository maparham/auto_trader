# Equality operator (`==`) for expression rules

**Date:** 2026-08-07
**Status:** design

## Motivation

The expression engine supports four comparison operators — `>`, `<`, `>=`, `<=` —
plus the cross operators `x>` / `x<`. It has no equality.

That omission was deliberate for price and indicator series: these are floats, so
`EMA(9) == EMA(21)` would essentially never be exactly true, and the proximity
machinery in `closeness.py` exists to answer "are these near each other" instead.

But `count(cond, window)` returns an exact integer (`evaluate.py:228-245` builds it
from a prefix-sum of booleans), as does `barsSinceEntry`. For those, equality is
exactly right and nothing else expresses it:

    count(candle.close > candle.open, 5) >= 3    -- works today
    count(candle.close > candle.open, 5) == 3    -- "exactly 3 of the last 5", unexpressible

This adds `==` as a fourth comparison operator.

## Scope decisions

**`==` is general, not restricted to integer-valued operands.** `EMA(9) == EMA(21)`
parses and evaluates; as a firing condition it is nearly always false, but it is a
first-class query for the proximity heatmap, which reports how close the two lines
are on every bar. Restricting `==` to integral operands would require a static
domain-inference pass over the AST (is `count(...) + 1` integral? is `avg(...)`?)
duplicated across both language stacks, plus a new error code — a large subsystem
for a guardrail a documentation sentence covers. The engine already permits
conditions that never fire.

**Bare `=` is rejected with targeted copy, not accepted as a synonym.** `=` has no
other role in this grammar, so every `=` that is not part of `==` is a mistyped
equality. It gets the message "Use == for equality." rather than the generic
`bad_char` "Unexpected character '='." This follows the existing `x>=` → `bad_cross_op`
precedent: one canonical spelling plus a sharp near-miss error.

**`!=` is out of scope.** Not YAGNI-by-default: `closeness.signed_gap` must return a
distance for every `Compare` op, and "how close is this to being unequal" has no
sensible answer. Adding `!=` means either inventing a convention or special-casing
it out of the heatmap. Deferred until there is a concrete use for it.

**`x==` is not a cross near-miss.** The lexer's `x`-fusion (`lexer.py:102-109`) and the
bare-`x` hint (`parser.py:155`) exist because `x>` / `x<` have plausible mistypings.
There is no cross-equality concept, so `x == 3` lexes as `NAME(x)` `EQ` `NUMBER(3)`
and is reported as an unknown variable `x` — which is what it is.

## Grammar

A new token type `EQ`, value `"=="`, symbol `"=="`.

`==` joins the comparison operators everywhere they are recognised, at the same
precedence — below arithmetic, and participating in comparison chains. `a == b == c`
is therefore a chain of two conjoined comparisons, consistent with how
`EMA(9) > EMA(21) > EMA(50)` already works. No new precedence level.

Both readings of "count needs equality" are supported, because they are separate
code paths:

    count(candle.close > candle.open, 5) == 3    -- compare the count (row op)
    count(EMA(9) == EMA(21), 20)                 -- equality inside the condition

### Consolidating the operator lists

The comparison-operator set is currently spelled out in several hard-coded tuples
that would each need `EQ` added. Rather than adding a fifth and sixth literal list,
introduce a shared constant and derive from it:

    _CMP_OPS = ("GT", "LT", "GE", "LE", "EQ")
    _ROW_OPS = _CMP_OPS + ("XGT", "XLT")

`parse_condition`'s tuple (`parser.py:177`) becomes `_CMP_OPS`. The TypeScript mirror
gets the same treatment: `ROW_OP_TYPES` (`parser.ts:263`) derived from a new
`CMP_OP_TYPES`, and `parseCondition`'s four-way `!==` chain (`parser.ts:452`) replaced
by a membership test. The two `symOf` records (`parser.ts:317`, `parser.ts:460`) collapse
into one module-level constant.

This matters for correctness, not tidiness: miss `parse_condition` and top-level
`== 3` works while `count(… == 3, 5)` errors, an inconsistency no single test would
catch.

The bare-`x` hint tuples (`parser.py:155`, `parser.ts:424`) stay `GT`/`LT` only — they are
about cross-operator spelling, not the row-op set, and adding `EQ` there would be wrong.

## Evaluation

`_cmp_vals` (`evaluate.py:89-98`) gains an `==` branch.

**The existing bare fallthrough must be closed at the same time.** The function
currently reads:

    if op == ">":  return l > r
    if op == "<":  return l < r
    if op == ">=": return l >= r
    return l <= r          # <-- catches everything else

Adding `EQ` to the lexer and parser without touching this makes `a == b` silently
evaluate as `a <= b`: wrong results on every bar, no error raised, and parser-level
tests still pass. The `<=` case becomes explicit and an unknown op raises
`ValueError`, so the next operator added cannot repeat this.

**Undefined and NaN operands need no new handling.** `_cmp_vals` already returns
`False` when either side is undefined (`_defined` guard, `evaluate.py:90-91`), which is
correct for equality — an undefined operand equals nothing, and IEEE NaN is unequal
to itself anyway. This is deliberate; it is recorded here so it is not later
"fixed" into `None`-equals-`None`.

`_cmp_vals` is the only place `evaluate.py` branches on op strings; the two call
sites (`evaluate.py:171` in `_cond_matches`, `evaluate.py:404` in `_cmp`) both route
through it.

## Proximity heatmap

`closeness.signed_gap` (`closeness.py:22-30`) raises `ValueError` on any op it does not
know, so without a change here an `==` rule returns a 500 from the closeness route
(`api/routers/expr.py`). This is a ship blocker, not polish.

The convention is documented as "gap >= 0 means the comparison holds". For equality:

    signed_gap("==", l, r) = -abs(l - r)

This is ≥ 0 exactly when `l == r`, and warms toward `1` through `ramp()` as the
operands converge — the same non-positive symmetric form `Cross` already uses for
distance-to-touching (`closeness.py:105-112`). No new convention is invented.

This is what makes unrestricted `==` useful rather than merely permitted:
`EMA(9) == EMA(21)` as a heatmap query reads "how close are these two lines," which
is a real chart.

## Validation

No change. `validate.py` handles `Compare` structurally (recursing into `.left` /
`.right` at lines 64, 111, 221) and has no per-op logic. Same for `warmup.py`,
`literals.py`, and the `Compare` visitors in `nodes.py`.

Strategy rules are stored and transmitted as raw expression text; the AST is built
per request, used, and discarded. However, `Compare.op` specifically IS serialized
to the client: it flows through `RuleTerm.op` and `TermDTO.op` to the popover renderer
`opSymbol()` (frontend/src/lib/signalGlyphs.ts), which passes unknown ops through
unchanged. A future operator author must check that the new op symbol renders
correctly via the fallthrough path.

## Frontend

The TypeScript mirror in `frontend/src/lib/expr/` must stay byte-compatible with the
Python lexer/parser. Three independent operator lists need updating; the third is
easy to miss because no parser test covers it:

1. `parser.ts` lexer — an `=` branch emitting `EQ` on `==` and the `bad_eq_op` error on
   a lone `=` (`parser.ts:236-252`), plus the operator-set constants above.
2. `grammar.lezer:68` — `Operator { ">=" | "<=" | "==" | ">" | "<" }`. Today `=` matches no
   token rule at all, so `==` in the editor currently produces a parse error node.
3. `highlight.ts:29-31` — `EQ` added to `OPERATOR_TYPES`, or `==` parses correctly and
   renders unhighlighted in the editor.

No palette or autocomplete change. `RulePalette` has no operators group — comparisons
are typed, not picked — and `complete.ts` only completes the cross operators. Adding
an operators group is a separate question from adding an operator.

The `expected_operator` message is updated in both stacks to
`"Expected a comparison operator (> < >= <= == x> x<)."`

Out of scope, though adjacent: the dead structured-operator-dropdown CSS at
`App.css:1574-1598`, its orphaned comment at `BacktestSettingsModal.tsx:3739`, and the
stale "7 Rule ops" line at `schemas.py:337`.

## Error codes and copy

| Code | Trigger | Message |
|---|---|---|
| `bad_eq_op` | a `=` not followed by `=` | `Use == for equality.` |
| `expected_operator` | existing; copy updated | `Expected a comparison operator (> < >= <= == x> x<).` |

`bad_eq_op` spans the single `=` character. The message constant lives in `errors.py`
alongside `BAD_CROSS_MSG`, because `lexer.py` cannot import from `parser.py`.

## Testing

**Parity corpus first.** `frontend/src/lib/expr/corpus.json` ↔
`backend/tests/test_expr_parser_corpus.py` is the only thing keeping the two lexers
from diverging, so `==` cases there are mandatory, not additive: a count comparison,
equality inside `count`, an equality chain, a bare `=`, and `x == 3`.

Backend:
- `test_expr_lexer.py` — `EQ` token type, value and span; `=` → `bad_eq_op` with a
  one-character span; `>=` and `<=` still lex as `GE`/`LE` (the `=` branch must not
  intercept them).
- `test_expr_parser.py` — `op == "=="` at top level and inside `count`;
  `expected_operator` copy.
- `test_expr_parser_chain.py` — a chain including `==`.
- `test_expr_evaluate.py` — `count(...) == n` fires on exactly-n bars and not on
  n±1; equality with an undefined operand is `False`; `_cmp_vals` raises on an
  unknown op.
- `test_expr_closeness.py` — the `signed_gap` orientation table gains an `==` row:
  zero gap when equal, negative and symmetric otherwise.

Frontend:
- `parser.test.ts` — `EQ` emission and span, `bad_eq_op` message, `=` rejection.
- `highlight.test.ts` — `["==", "operator"]` classification.

## Documentation

There is no user-facing document describing the expression language — the operator
set is currently learned from the editor, the palette, and the `expected_operator`
message. Writing one is out of scope here.

What this change does carry is a maintainer comment at the `==` branch in
`_cmp_vals` recording why equality is unrestricted: it is exact and so practically
useful on `count(...)` and `barsSinceEntry`, while on float series its value is as a
proximity-heatmap query rather than as a firing condition. Without that note the
branch looks like an oversight and invites a "fix" that adds a tolerance.
