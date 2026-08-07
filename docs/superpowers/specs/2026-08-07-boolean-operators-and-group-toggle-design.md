# Boolean operators (and/or/not) + group AND/OR toggle — Design

**Date:** 2026-08-07
**Status:** Approved for planning

## Goal

Two related additions to the backtest rule maker, shipped together:

1. Restore the group-level **AND/OR toggle** that was lost when the structured
   rule editor was deleted (f3e54ea): each rule group chooses whether its rows
   combine with AND or OR.
2. Add **`and` / `or` / `not` operators inside the expression language**, so a
   single row can express boolean combinations:
   `EMA(9) x> EMA(50) or RSI(14) x< 30`, `not bullish(candle) and candle.close > EMA(21)`.

The original expression-rules design (2026-07-20) explicitly deferred both;
this picks that work up.

## Decisions (from brainstorming)

- Both features in one design; they are orthogonal (the toggle combines rows,
  the operators combine conditions within a row) and must not drift apart
  semantically.
- **Crosses become unrestricted.** The one-cross-per-row rule and its
  `multiple_crosses` error are deleted; crosses compose freely in boolean
  expressions and chains.
- **`not` is included**, precedence `not` > `and` > `or`.
- **Three-valued (Kleene) NaN logic.** NaN/undefined inputs make a condition
  *unknown*, not false. `unknown and false = false`, `unknown or true = true`,
  `not unknown = unknown`; unknown at the row top level is false. Undefined
  data can never fire a signal through `not`; a defined-true or-branch fires
  even if a sibling branch is undefined.

## Language

### Grammar (both parsers: Python authoritative, TS mirror + Lezer)

```
row       := orExpr
orExpr    := andExpr ("or" andExpr)*
andExpr   := notExpr ("and" notExpr)*
notExpr   := "not" notExpr | condition
condition := chain-comparison | cross (fn or infix) | predicate | "(" orExpr ")"
```

- Keywords `and`, `or`, `not`: lowercase only, reserved (bare-name uses lex as
  keywords).
- Comparison binds tighter than `not`: `not a > b` ≡ `not (a > b)`.
- Parentheses group conditions as well as arithmetic. The parser resolves the
  `(`-ambiguity by parsing paren contents as `orExpr`; a pure arithmetic group
  falls out as the degenerate case. This is the one delicate parser change and
  must be mirrored byte-for-byte in behavior between the Python and TS parsers.
- `count(cond, n)`'s first argument is promoted from single condition to full
  `orExpr`.

### Semantics

- Kleene three-valued evaluation as above. Internally `CompiledRow` evaluation
  uses `bool | None` (None = unknown); the public row result remains `bool`
  (unknown → False). Evaluation stays per-bar scalar — no vectorization change.
- Warm-up for a boolean node = max over its operands' warm-ups (same policy as
  arithmetic; three-valued logic makes early bars safe regardless).

## Group toggle

The per-group `combine: "AND" | "OR"` field still exists end to end
(`frontend/src/lib/backtestConfig.ts:8`, DTOs, and the closeness endpoint
already accepts `req.combine`). Restoration:

- **Engine:** `strategy/expr/strategy.py::_passes` honors the group's combine —
  `all(...)` vs `any(...)` over enabled rows. Empty group stays no-signal.
  Applies identically in backtest, sweep, WFO, and live (all flow through the
  same strategy).
- **UI:** an AND/OR segmented control in each `RuleGroupSection` header
  (entry/exit × long/short each have their own toggle). Visible only when the
  group has ≥ 2 rules; default AND. Fix the stale tooltip at
  `BacktestSettingsModal.tsx:3622` ("Multiple rules combine with the AND/OR
  switch") to match the restored control.

## Backend changes

- `lexer.py`: recognize `and`/`or`/`not` (emitted as keyword tokens).
- `nodes.py`: new `BoolOp` (op `"and" | "or"`, operands) and `Not` nodes;
  delete cross-count enforcement constants as needed.
- `parser.py`: boolean layer per grammar above; paren handling; `count`
  condition promotion; remove `multiple_crosses`; keep `cross_not_toplevel`
  behavior updated (crosses are now valid wherever a condition is).
- `validate.py`: recurse through the new nodes.
- `evaluate.py`: three-valued `evaluate`; `terms_at` walks boolean nodes and
  lists each branch's terms, labeling unknown branches, so the per-bar rule
  inspector keeps working.
- `warmup.py`: max over boolean operands.
- `closeness.py`: recursive fold inside a row — AND node = min of branch
  closeness, OR node = max, `not` = closeness of the flipped comparison
  (negated gap). The group-level fold reads the group's actual combine instead
  of assuming AND.
- `strategy.py`: `_passes` honors combine (above); docstring updated.

## Frontend changes

- `lib/expr/parser.ts`, `grammar.lezer`, `highlight.ts`: the three keywords,
  highlighted as keywords (distinct from names).
- `complete.ts` / `catalog.ts`: suggest `and`/`or`/`not` where an operator is
  expected; palette gains a small "logic" group.
- Shared corpus fixtures: boolean expressions, precedence cases, paren
  grouping, new/removed error codes — both parsers stay in lockstep.
- `RuleGroupSection`: the AND/OR segmented control (above).

## Testing

- **Backend:** parser tests (precedence, parens, keyword errors,
  cross-anywhere, count promotion); evaluator goldens for the Kleene truth
  tables including NaN branches; strategy tests for OR groups incl. the live
  path; closeness fold tests; warmup tests.
- **Frontend:** corpus parity; autocomplete context tests; toggle component
  test; sweep-literal detection unaffected by keywords.
- **E2E:** build an OR group, run a backtest, inspect a bar with an unknown
  branch.

## Migration

None. Existing expressions parse unchanged; existing configs already carry
`combine: "AND"`. No indicator or field is named `and`/`or`/`not`, so
reserving the keywords breaks nothing.

## Out of scope

- `xor`, bitwise operators, multi-line expressions.
- Any change to sweep literal semantics (keywords contain no literals).
