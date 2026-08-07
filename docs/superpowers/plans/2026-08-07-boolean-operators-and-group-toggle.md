# Boolean operators (and/or/not) + group AND/OR toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `and`/`or`/`not` operators to the strategy expression language (both parser stacks) with Kleene three-valued NaN semantics, and restore the per-group AND/OR toggle that controls how rule rows combine.

**Architecture:** The expression grammar gains a boolean layer above the existing
condition level (`not` > `and` > `or`, parens group conditions), implemented
identically in the authoritative Python pipeline
(`backend/auto_trader/strategy/expr/`) and the advisory TS mirror
(`frontend/src/lib/expr/parser.ts`), pinned together by the shared
`corpus.json`. Evaluation goes three-valued internally (`bool | None`, None =
unknown) so undefined data can never fire through `not`. The group toggle is
pure restoration: the `combine` field already exists end-to-end; the engine
(`_passes`) starts honoring it, the DTOs grow per-group combine fields, and
`RuleGroupSection` gets a segmented AND/OR control.

**Tech Stack:** Python 3 (dataclasses, pytest), TypeScript + React + CodeMirror 6 (vitest).

**Spec:** `docs/superpowers/specs/2026-08-07-boolean-operators-and-group-toggle-design.md`

## Global Constraints

- Keywords are lowercase only: `and`, `or`, `not`. Precedence `not` > `and` > `or`; comparison binds tighter than `not`.
- Crosses become unrestricted: the `multiple_crosses` error is deleted everywhere.
- Three-valued (Kleene) NaN logic: `unknown and false = false`, `unknown or true = true`, `not unknown = unknown`; unknown at row top level is false.
- The Python backend is authoritative; `frontend/src/lib/expr/parser.ts` must mirror it byte-for-byte in behavior (same error codes, same spans). Every grammar change lands in BOTH stacks and gets corpus coverage.
- The `cross_not_toplevel` error CODE survives but its message changes to "A comparison or cross can't be used as a value." (crosses are now legal as conditions anywhere, not just the whole row). Same string in both stacks.
- New error codes: `expected_condition` (an `and`/`or`/`not` operand is not a condition) and `bool_as_value` (postfix operator on a parenthesized condition). Exact messages defined in Task 2.
- New DTO fields default `"AND"` so existing clients/presets are unaffected.
- Run backend tests with `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest <file> -q`; frontend tests with `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run <file>`.
- Commit after every task. This repo's checkout is shared by concurrent sessions: `git add` ONLY the files you touched, never `git add -A`.

---

### Task 1: Backend keywords + BoolOp/Not nodes

**Files:**
- Modify: `backend/auto_trader/strategy/expr/lexer.py` (word branch, ~line 100)
- Modify: `backend/auto_trader/strategy/expr/nodes.py`
- Test: `backend/tests/test_expr_bool_nodes.py` (create)

**Interfaces:**
- Consumes: existing `Token`, node dataclasses.
- Produces: lexer emits token types `"AND" | "OR" | "NOT"` for the bare words `and`/`or`/`not`. `nodes.BoolOp(op: str, parts: list["Node"], start: int, end: int)` where `op` is `"and" | "or"`, `nodes.Not(operand: "Node", start: int, end: int)`, and `nodes.CONDITION_KINDS: tuple[type, ...] = (Compare, Cross, Chain, Predicate, BoolOp, Not)`. `Row = Compare | Cross | Chain | Predicate | BoolOp | Not`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_bool_nodes.py
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.lexer import tokenize


def test_keywords_lex_as_dedicated_tokens():
    toks = tokenize("a and b or not c")
    types = [t.type for t in toks]
    assert types == ["NAME", "AND", "NAME", "OR", "NOT", "NAME", "EOF"]
    assert toks[1].value == "and" and toks[1].start == 2 and toks[1].end == 5


def test_keyword_prefixed_names_stay_names():
    # "android"/"origin"/"notch" must NOT split into keyword + rest.
    toks = tokenize("android origin notch")
    assert [t.type for t in toks] == ["NAME", "NAME", "NAME", "EOF"]


def test_uppercase_forms_are_plain_names():
    toks = tokenize("AND OR NOT And")
    assert [t.type for t in toks] == ["NAME", "NAME", "NAME", "NAME", "EOF"]


def test_boolop_and_not_nodes_exist():
    cmp1 = N.Compare(">", N.Num(1, 0, 1), N.Num(2, 4, 5), 0, 5)
    cmp2 = N.Compare("<", N.Num(3, 10, 11), N.Num(4, 14, 15), 10, 15)
    b = N.BoolOp("or", [cmp1, cmp2], 0, 15)
    n = N.Not(cmp1, 0, 5)
    assert b.op == "or" and len(b.parts) == 2
    assert isinstance(n.operand, N.Compare)
    for kind in (N.Compare, N.Cross, N.Chain, N.Predicate, N.BoolOp, N.Not):
        assert kind in N.CONDITION_KINDS


def test_node_walks_recurse_through_bool_nodes():
    tf_cmp = N.Compare(">", N.Tf(N.Candle("close", 0, 1), "4H", 0, 2), N.Num(1, 5, 6), 0, 6)
    plain = N.Compare("<", N.Num(1, 8, 9), N.Num(2, 10, 11), 8, 11)
    assert N.contains_tf(N.BoolOp("and", [plain, tf_cmp], 0, 11))
    assert N.contains_tf(N.Not(tf_cmp, 0, 6))
    assert not N.contains_tf(N.Not(plain, 8, 11))
    assert N.first_tf(N.BoolOp("or", [plain, tf_cmp], 0, 11)) == "4H"
    assert N.first_tf(N.Not(plain, 8, 11)) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_bool_nodes.py -q`
Expected: FAIL (`AttributeError: ... has no attribute 'BoolOp'`, keyword tokens come out as NAME).

- [ ] **Step 3: Implement**

In `lexer.py`, add a keyword map above `tokenize` and use it in the word branch. The check goes AFTER the `word == "x"` cross-operator check (no collision, but keep the cross block first so its structure is untouched), replacing the plain `out.append(Token("NAME", word, i, j))`:

```python
# Reserved boolean keywords. Lowercase only, matching the language's
# case-sensitive style; "AND"/"Not" stay plain names (-> unknown_name).
_KEYWORDS = {"and": "AND", "or": "OR", "not": "NOT"}
```

```python
            out.append(Token(_KEYWORDS.get(word, "NAME"), word, i, j))
            i = j
            continue
```

In `nodes.py`, add after `IndicatorRef`:

```python
@dataclass(frozen=True, slots=True)
class BoolOp:
    op: str  # "and" | "or"
    parts: list["Node"]  # each a condition (CONDITION_KINDS)
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Not:
    operand: "Node"  # a condition (CONDITION_KINDS)
    start: int
    end: int
```

Extend the unions and add the kinds tuple:

```python
Node = (
    Num | Candle | Entry | Call | Field | Offset | Tf | Unary | Binary | Compare | Cross | Chain
    | Predicate | Count | BarsSinceEntry | IndicatorRef | BoolOp | Not
)

# A parsed row: what parse() returns and validate()/compile_row() accept.
Row = Compare | Cross | Chain | Predicate | BoolOp | Not

# The node kinds that ARE conditions (usable as a row, an and/or/not operand,
# or count's first argument) as opposed to numeric values.
CONDITION_KINDS = (Compare, Cross, Chain, Predicate, BoolOp, Not)
```

Add `BoolOp`/`Not` cases to every recursive helper in `nodes.py` — `contains_tf`, `first_tf`, `contains_series`, `contains_bars_since_entry` — following each function's existing style. For `contains_tf` (same pattern for `contains_series`, `contains_bars_since_entry`):

```python
    if isinstance(node, BoolOp):
        return any(contains_tf(p) for p in node.parts)
    if isinstance(node, Not):
        return contains_tf(node.operand)
```

For `first_tf`:

```python
    if isinstance(node, BoolOp):
        for p in node.parts:
            tf = first_tf(p)
            if tf is not None:
                return tf
        return None
    if isinstance(node, Not):
        return first_tf(node.operand)
```

Also update `Count.cond`'s type comment to `"Node"  # a condition (CONDITION_KINDS)` since Task 2 promotes it to any condition.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_bool_nodes.py tests/test_expr_lexer.py tests/test_expr_nodes.py -q`
Expected: PASS (existing lexer/nodes tests must stay green).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/lexer.py backend/auto_trader/strategy/expr/nodes.py backend/tests/test_expr_bool_nodes.py
git commit -m "feat(expr): and/or/not keyword tokens and BoolOp/Not nodes"
```

---

### Task 2: Backend parser — boolean grammar

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py`
- Test: `backend/tests/test_expr_parser_bool.py` (create)

**Interfaces:**
- Consumes: Task 1's `AND`/`OR`/`NOT` tokens, `N.BoolOp`, `N.Not`, `N.CONDITION_KINDS`.
- Produces: `parse(src) -> N.Row` where the row grammar is
  `row := orExpr EOF; orExpr := andExpr ("or" andExpr)*; andExpr := notExpr ("and" notExpr)*; notExpr := "not" notExpr | conditionUnit`.
  `count(cond, n)`'s first argument is a full `orExpr`. `multiple_crosses` is gone. New error codes with exact messages:
  - `expected_condition`: `"and, or and not need a condition, like candle.close > EMA(9)."`
  - `bool_as_value`: `"A condition can't be used as a value here."`
  - `cross_not_toplevel` message becomes `"A comparison or cross can't be used as a value."` (code unchanged).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_parser_bool.py
import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse


def test_or_of_two_comparisons():
    row = parse("RSI(14) > 70 or RSI(14) < 30")
    assert isinstance(row, N.BoolOp) and row.op == "or"
    assert [type(p) for p in row.parts] == [N.Compare, N.Compare]
    assert row.start == 0 and row.end == len("RSI(14) > 70 or RSI(14) < 30")


def test_precedence_and_binds_tighter_than_or():
    row = parse("candle.close > 1 or candle.close > 2 and candle.close > 3")
    assert isinstance(row, N.BoolOp) and row.op == "or"
    assert isinstance(row.parts[0], N.Compare)
    assert isinstance(row.parts[1], N.BoolOp) and row.parts[1].op == "and"


def test_chained_same_op_flattens():
    row = parse("candle.close > 1 or candle.close > 2 or candle.close > 3")
    assert isinstance(row, N.BoolOp) and row.op == "or" and len(row.parts) == 3


def test_not_wraps_the_whole_comparison():
    row = parse("not candle.close > EMA(9)")
    assert isinstance(row, N.Not)
    assert isinstance(row.operand, N.Compare)
    assert row.start == 0


def test_double_not():
    row = parse("not not bullish(candle)")
    assert isinstance(row, N.Not) and isinstance(row.operand, N.Not)
    assert isinstance(row.operand.operand, N.Predicate)


def test_parens_group_conditions():
    row = parse("(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70")
    assert isinstance(row, N.BoolOp) and row.op == "and"
    assert isinstance(row.parts[0], N.BoolOp) and row.parts[0].op == "or"


def test_parenthesized_arith_still_works():
    row = parse("(candle.high + candle.low) / 2 > EMA(9)")
    assert isinstance(row, N.Compare)
    assert isinstance(row.left, N.Binary) and row.left.op == "/"


def test_crosses_compose_with_or():
    row = parse("EMA(9) x> EMA(50) or RSI(14) x< 30")
    assert isinstance(row, N.BoolOp)
    assert all(isinstance(p, N.Cross) for p in row.parts)


def test_two_crosses_in_one_chain_now_parse():
    # multiple_crosses is deleted: unrestricted crosses.
    row = parse("EMA(9) x> EMA(50) x< EMA(20)")
    assert isinstance(row, N.Chain)
    assert sum(isinstance(p, N.Cross) for p in row.parts) == 2


def test_count_takes_boolean_condition():
    row = parse("count(bullish(candle) and candle.close > EMA(9), 5) > 2")
    assert isinstance(row, N.Compare)
    assert isinstance(row.left, N.Count)
    assert isinstance(row.left.cond, N.BoolOp) and row.left.cond.op == "and"


def test_and_needs_conditions():
    with pytest.raises(ExprError) as e:
        parse("candle.close and EMA(9)")
    assert e.value.code == "expected_condition"
    assert (e.value.start, e.value.end) == (0, len("candle.close"))


def test_not_needs_a_condition():
    with pytest.raises(ExprError) as e:
        parse("not candle.close")
    assert e.value.code == "expected_condition"
    assert (e.value.start, e.value.end) == (4, len("not candle.close"))


def test_postfix_on_paren_condition_rejected():
    with pytest.raises(ExprError) as e:
        parse("(candle.close > EMA(9))[-1]")
    assert e.value.code == "bool_as_value"


def test_bare_arith_row_still_expected_operator():
    with pytest.raises(ExprError) as e:
        parse("EMA(9) EMA(21)")
    assert e.value.code == "expected_operator"
    assert (e.value.start, e.value.end) == (7, 10)


def test_trailing_and_reports_missing_value():
    with pytest.raises(ExprError) as e:
        parse("candle.close > EMA(9) and")
    assert e.value.code == "unexpected_token"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_parser_bool.py -q`
Expected: FAIL (`expected_operator` where `or` appears, no BoolOp).

- [ ] **Step 3: Implement**

Restructure `parser.py`. Replace `parse_row` and `parse_condition` with the layered grammar; `parse_arith`/`parse_term`/`parse_factor`/`parse_postfix`/`parse_primary` stay as they are except for the `LPAREN` branch. Full new/changed methods:

```python
    # row := orExpr EOF
    def parse_row(self) -> N.Row:
        node = self.parse_or()
        if not isinstance(node, N.CONDITION_KINDS):
            self._raise_expected_operator()
        self.expect("EOF")
        return node

    # orExpr := andExpr ("or" andExpr)*
    def parse_or(self) -> N.Node:
        left = self.parse_and()
        if self.peek().type != "OR":
            return left
        parts = [left]
        while self.peek().type == "OR":
            self.next()
            parts.append(self.parse_and())
        for p in parts:
            self._require_condition(p)
        return N.BoolOp("or", parts, parts[0].start, parts[-1].end)

    # andExpr := notExpr ("and" notExpr)*
    def parse_and(self) -> N.Node:
        left = self.parse_not()
        if self.peek().type != "AND":
            return left
        parts = [left]
        while self.peek().type == "AND":
            self.next()
            parts.append(self.parse_not())
        for p in parts:
            self._require_condition(p)
        return N.BoolOp("and", parts, parts[0].start, parts[-1].end)

    # notExpr := "not" notExpr | conditionUnit
    def parse_not(self) -> N.Node:
        t = self.peek()
        if t.type == "NOT":
            self.next()
            operand = self.parse_not()
            if not isinstance(operand, N.CONDITION_KINDS):
                raise ExprError(
                    "expected_condition",
                    "and, or and not need a condition, like candle.close > EMA(9).",
                    t.start, operand.end,
                )
            return N.Not(operand, t.start, operand.end)
        return self.parse_condition_unit()

    # conditionUnit := crossfn "(" arith "," arith ")" | arith (cmpop arith)*
    # Returns a bare arith Node when no comparison follows — the caller decides
    # whether that is legal (a paren group) or an error (a row, an and/or/not
    # operand, count's condition).
    def parse_condition_unit(self) -> N.Node:
        t = self.peek()
        if t.type == "NAME" and t.value in N.CROSS_FNS and self.toks[self.i + 1].type == "LPAREN":
            fn = self.next()
            self.expect("LPAREN")
            a = self.parse_arith()
            self.expect("COMMA")
            b = self.parse_arith()
            close = self.expect("RPAREN")
            return N.Cross(fn.value, a, b, fn.start, close.end)
        left = self.parse_arith()
        if self.peek().type not in _ROW_OPS:
            return left
        parts: list[N.Compare | N.Cross] = []
        operand = left
        while self.peek().type in _ROW_OPS:
            optok = self.next()
            right = self.parse_arith()
            if optok.type in _CROSS_SYM:
                parts.append(N.Cross(_CROSS_SYM[optok.type], operand, right, operand.start, right.end))
            else:
                parts.append(N.Compare(_CMP_SYM[optok.type], operand, right, operand.start, right.end))
            operand = right
        if len(parts) == 1:
            return parts[0]
        return N.Chain(parts, parts[0].start, parts[-1].end)

    def _require_condition(self, node: N.Node) -> None:
        if not isinstance(node, N.CONDITION_KINDS):
            raise ExprError(
                "expected_condition",
                "and, or and not need a condition, like candle.close > EMA(9).",
                node.start, node.end,
            )

    def _raise_expected_operator(self) -> None:
        op = self.peek()
        if op.type == "NAME" and op.value in ("x", "X"):
            raise ExprError("bad_cross_op", _BAD_CROSS_MSG, op.start, op.end)
        raise ExprError("expected_operator", "Expected a comparison operator (> < >= <= x> x<).", op.start, op.end)
```

Notes for the implementer:
- The `multiple_crosses` check and the old `Predicate`-with-EOF special case are both gone: a bare `Predicate` returned by `parse_arith` is condition-kind and flows through.
- In `parse_primary`, the `count` branch changes from `self.parse_condition()` to:

```python
            if name.value == "count" and self.peek().type == "LPAREN":
                self.next()
                cond = self.parse_or()
                if not isinstance(cond, N.CONDITION_KINDS):
                    raise ExprError(
                        "count_needs_condition",
                        "count's first argument must be a condition, like candle.open > candle.close.",
                        cond.start, cond.end,
                    )
                self.expect("COMMA")
                window = self.parse_arith()
                close = self.expect("RPAREN")
                return N.Count(cond, window, name.start, close.end)
```

  Delete the now-unused `parse_condition` method.
- In `parse_primary`'s `LPAREN` branch, parse the full boolean level and forbid postfix on a condition:

```python
        if t.type == "LPAREN":
            self.next()
            inner = self.parse_or()
            close = self.expect("RPAREN")
            if isinstance(inner, N.CONDITION_KINDS) and self.peek().type in ("DOT", "LBRACKET", "AT"):
                bad = self.peek()
                raise ExprError("bool_as_value", "A condition can't be used as a value here.", bad.start, bad.end)
            # A parenthesized group is a transparent wrapper: keep the inner node
            # but widen its span so postfix/offset spans read naturally.
            return _respan(inner, t.start, close.end)
```

- In `expect()`, update the `cross_not_toplevel` message string to `"A comparison or cross can't be used as a value."` (code unchanged).
- `parse_row`'s old inline bad-cross/expected-operator handling is replaced by `_raise_expected_operator` (same spans: nothing was consumed past the arith, so `self.peek()` is the same token the old code inspected).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_parser_bool.py tests/test_expr_parser.py tests/test_expr_parser_chain.py tests/test_expr_parser_infix_cross.py -q`
Expected: `test_expr_parser_bool.py` PASSES. Pre-existing parser tests that assert `multiple_crosses` or the old `cross_not_toplevel` message will fail — update those assertions in place (delete `multiple_crosses` cases outright; they now parse). `tests/test_expr_parser_corpus.py` will fail until Task 9 updates `corpus.json` — that is expected; leave it red for now and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/parser.py backend/tests/test_expr_parser_bool.py backend/tests/test_expr_parser.py backend/tests/test_expr_parser_chain.py backend/tests/test_expr_parser_infix_cross.py
git commit -m "feat(expr): boolean grammar — and/or/not, boolean parens, unrestricted crosses (corpus parity lands with the TS mirror)"
```

---

### Task 3: Backend validate + warmup

**Files:**
- Modify: `backend/auto_trader/strategy/expr/validate.py`
- Modify: `backend/auto_trader/strategy/expr/warmup.py`
- Test: `backend/tests/test_expr_validate_bool.py` (create)

**Interfaces:**
- Consumes: `N.BoolOp`, `N.Not`, Task 2's parser.
- Produces: `validate(node, *, is_exit, instances)` recurses through BoolOp/Not (and Count's now-arbitrary condition) unchanged in signature. `warmup_bars` returns max over BoolOp parts / passes through Not.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_validate_bool.py
import pytest

from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def test_valid_boolean_rows_validate():
    for src in (
        "RSI(14) > 70 or RSI(14) < 30",
        "not bullish(candle)",
        "(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70",
        "count(bullish(candle) and candle.close > EMA(9), 5) > 2",
        "EMA(9) x> EMA(50) or crossBelow(RSI(14), 30)",
    ):
        validate(parse(src), is_exit=False)


def test_entry_still_rejected_in_entry_rules_inside_bool():
    with pytest.raises(ExprError) as e:
        validate(parse("candle.close > entry or bullish(candle)"), is_exit=False)
    assert e.value.code == "entry_in_entry_rule"


def test_unknown_name_reported_inside_not():
    with pytest.raises(ExprError) as e:
        validate(parse("not FOO(9) > 0"), is_exit=False)
    assert e.value.code == "unknown_name"


def test_condition_in_value_position_rejected_by_validate():
    # (a > b) + 1 parses (Binary over a Compare); validation rejects it.
    with pytest.raises(ExprError) as e:
        validate(parse("(candle.close > EMA(9)) + 1 > 2"), is_exit=False)
    assert e.value.code == "cross_not_toplevel"


def test_warmup_is_max_over_bool_branches():
    assert warmup_bars(parse("EMA(50) > 0 or EMA(9) > 0")) == 50
    assert warmup_bars(parse("not EMA(21) > 0")) == 21
    assert warmup_bars(parse("EMA(9) > 0 and EMA(200) > 0 or EMA(50) > 0")) == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_validate_bool.py -q`
Expected: FAIL (validate falls through to `unknown_name`/crashes on BoolOp).

- [ ] **Step 3: Implement**

`validate.py` — extend the top-level `validate()` (before the Chain branch):

```python
    if isinstance(node, N.BoolOp):
        for p in node.parts:
            validate(p, is_exit=is_exit, instances=instances)
        return
    if isinstance(node, N.Not):
        validate(node.operand, is_exit=is_exit, instances=instances)
        return
```

In `_walk`'s `Count` branch, the cond is now any condition — replace the three inline cases with a recursive call:

```python
    if isinstance(node, N.Count):
        validate(node.cond, is_exit=is_exit, instances=instances)
        _walk(node.window, is_exit=is_exit, instances=instances)
        return
```

Update the `cross_not_toplevel` message in `_walk`'s `(N.Compare, N.Cross, N.Chain)` branch and the `CROSSES` call branch to the new string `"A comparison or cross can't be used as a value."` / `f"{node.name} can't be used as a value."`, and extend that isinstance tuple to also cover `N.BoolOp` and `N.Not` (a boolean node in value position is the same mistake).

Add BoolOp/Not cases to `_contains_entry_kind` and `_pinned_instance` (mirroring their existing per-kind style):

```python
    if isinstance(node, N.BoolOp):
        return any(_contains_entry_kind(p) for p in node.parts)
    if isinstance(node, N.Not):
        return _contains_entry_kind(node.operand)
```

```python
    if isinstance(node, N.BoolOp):
        return _first(_pinned_instance(p, instances) for p in node.parts)
    if isinstance(node, N.Not):
        return _pinned_instance(node.operand, instances)
```

`warmup.py` — add at the top of `warmup_bars`, next to the Chain case:

```python
    if isinstance(node, N.BoolOp):
        return max(warmup_bars(p, resolution, instances) for p in node.parts)
    if isinstance(node, N.Not):
        return warmup_bars(node.operand, resolution, instances)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_validate_bool.py tests/test_expr_validate.py tests/test_expr_warmup.py -q`
Expected: PASS (fix any pre-existing assertions on the old `cross_not_toplevel` message in place).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/validate.py backend/auto_trader/strategy/expr/warmup.py backend/tests/test_expr_validate_bool.py backend/tests/test_expr_validate.py
git commit -m "feat(expr): validate and warm up boolean nodes"
```

---

### Task 4: Backend evaluate — Kleene three-valued logic

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`
- Test: `backend/tests/test_expr_evaluate_bool.py` (create)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `_cmp3(op: str, l, r) -> bool | None` (None when either side undefined).
  - `CompiledRow._match3(cond, j, entry, entry_i) -> bool | None` — the per-bar Kleene evaluator for every condition kind; replaces `_match_at`.
  - `_cond_matches3(cond, candles, resolution, htf, instances) -> list[bool | None]` — vectorized three-valued; `_cond_matches` becomes `[v is True for v in _cond_matches3(...)]`.
  - `CompiledRow.evaluate(...) -> bool` = `self._match3(self.node, i, ...) is True`. The `_matches` cache dict is DELETED from the dataclass (the `_pattern_cache` covers patterns); `compile_row`'s constructor call drops that argument.
  - `terms_at` recurses through BoolOp/Not and emits every leaf's RuleTerm.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_evaluate_bool.py
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _row(src, candles):
    return compile_row(parse(src), candles, "HOUR", {}, source=src)


def test_or_true_when_one_branch_true():
    candles = _candles([10] * 10)
    row = _row("candle.close > 100 or candle.close > 5", candles)
    assert row.evaluate(9, None) is True


def test_and_false_when_one_branch_false():
    candles = _candles([10] * 10)
    row = _row("candle.close > 5 and candle.close > 100", candles)
    assert row.evaluate(9, None) is False


def test_not_flips_a_defined_comparison():
    candles = _candles([10] * 10)
    assert _row("not candle.close > 100", candles).evaluate(9, None) is True
    assert _row("not candle.close > 5", candles).evaluate(9, None) is False


def test_not_never_fires_on_undefined_data():
    # Bar 3 is inside EMA(50) warm-up: RSI/EMA undefined -> unknown -> not
    # unknown = unknown -> row False. The Kleene trap from the spec.
    candles = _candles([10] * 10)
    row = _row("not EMA(50) > 0", candles)
    assert row.evaluate(3, None) is False


def test_unknown_or_true_is_true():
    # EMA(50) undefined at bar 3 (unknown branch); the defined branch is true.
    candles = _candles([10] * 10)
    row = _row("EMA(50) > 0 or candle.close > 5", candles)
    assert row.evaluate(3, None) is True


def test_unknown_and_false_is_false_unknown_and_true_is_false():
    candles = _candles([10] * 10)
    assert _row("EMA(50) > 0 and candle.close > 100", candles).evaluate(3, None) is False
    # unknown AND true -> unknown -> row False
    assert _row("EMA(50) > 0 and candle.close > 5", candles).evaluate(3, None) is False


def test_count_with_boolean_condition():
    candles = _candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    row = _row("count(candle.close > 8 or candle.close < 2, 10) > 1", candles)
    # bars with close>8: 9,10 (two); close<2: 1 (one) -> count=3 at the last bar
    assert row.evaluate(9, None) is True


def test_terms_at_lists_every_branch():
    candles = _candles([10] * 10)
    src = "candle.close > 5 or candle.close > 100"
    row = _row(src, candles)
    assert row.evaluate(9, None) is True
    terms = row.terms_at(9, None)
    assert len(terms) == 2
    assert terms[0].left_label == "candle.close" and terms[0].op == ">"


def test_two_crosses_in_or_both_evaluate():
    ups = _candles([1, 2, 3, 10, 3, 2, 1, 1, 1, 1])
    row = _row("candle.close x> 5 or candle.close x< 5", ups)
    assert row.evaluate(3, None) is True   # crossed above 5
    assert row.evaluate(4, None) is True   # crossed back below 5
    assert row.evaluate(6, None) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_evaluate_bool.py -q`
Expected: FAIL (evaluate crashes / falls through on BoolOp nodes).

- [ ] **Step 3: Implement**

In `evaluate.py`:

1. Add the three-valued comparator next to `_cmp_vals` (keep `_cmp_vals` for callers that want plain bool):

```python
def _cmp3(op: str, l: float | None, r: float | None) -> bool | None:
    """Three-valued comparison: None (unknown) when either side is undefined."""
    if not (_defined(l) and _defined(r)):
        return None
    return _cmp_vals(op, l, r)
```

2. Add Kleene folds as module helpers:

```python
def _kleene_and(vals: "list[bool | None]") -> bool | None:
    if any(v is False for v in vals):
        return False
    if any(v is None for v in vals):
        return None
    return True


def _kleene_or(vals: "list[bool | None]") -> bool | None:
    if any(v is True for v in vals):
        return True
    if any(v is None for v in vals):
        return None
    return False
```

3. Rename `_match_at` to `_match3` on `CompiledRow`, returning `bool | None`, and extend it to every condition kind (this makes it the single per-bar evaluator; `evaluate` and `Count` route through it):

```python
    def _match3(self, cond: N.Node, j: int, entry: float | None, entry_i: int | None) -> "bool | None":
        """Three-valued truth of a condition at bar j: None = unknown (some
        input undefined). Kleene: unknown and False = False, unknown or True =
        True, not unknown = unknown."""
        if isinstance(cond, N.BoolOp):
            vals = [self._match3(p, j, entry, entry_i) for p in cond.parts]
            return _kleene_and(vals) if cond.op == "and" else _kleene_or(vals)
        if isinstance(cond, N.Not):
            v = self._match3(cond.operand, j, entry, entry_i)
            return None if v is None else not v
        if isinstance(cond, N.Chain):
            return _kleene_and([self._match3(p, j, entry, entry_i) for p in cond.parts])
        if isinstance(cond, N.Predicate):
            if cond.fn in PATTERN_FNS:
                pkey = id(cond)
                if pkey not in self._pattern_cache:
                    self._pattern_cache[pkey] = _pattern_series3(
                        cond, self.candles, self.resolution, self.htf, self.instances
                    )
                arr = self._pattern_cache[pkey]
                return arr[j] if 0 <= j < len(arr) else None
            bullish = cond.fn == "bullish"  # the rest is binary (see _cond_matches3)
            key = id(cond)
            if key not in self._pred_nodes:
                self._pred_nodes[key] = (
                    _apply_field_to_candle(cond.base, "open"),
                    _apply_field_to_candle(cond.base, "close"),
                )
            o_node, c_node = self._pred_nodes[key]
            o = self._val(o_node, j, entry, entry_i)
            c = self._val(c_node, j, entry, entry_i)
            if not (_defined(o) and _defined(c)):
                return None
            return c > o if bullish else c < o
        if isinstance(cond, N.Cross):
            if j == 0:
                return None  # no prev bar: the straddle is unknowable
            a1, a0 = self._val(cond.a, j, entry, entry_i), self._val(cond.a, j - 1, entry, entry_i)
            b1, b0 = self._val(cond.b, j, entry, entry_i), self._val(cond.b, j - 1, entry, entry_i)
            if not all(_defined(v) for v in (a1, a0, b1, b0)):
                return None
            if cond.fn == "crossAbove":
                return a0 <= b0 and a1 > b1
            return a0 >= b0 and a1 < b1
        # Compare
        return _cmp3(cond.op, self._val(cond.left, j, entry, entry_i), self._val(cond.right, j, entry, entry_i))
```

   `_pattern_cache`'s value type changes to `list[bool | None]`; add the helper that builds it three-valued (replacing `_pattern_bool_series`'s role for the per-bar path, keeping the old bool version for closeness via `_cond_matches`):

```python
def _pattern_series3(node: N.Predicate, candles: Sequence[Candle],
                     resolution: str, htf: dict[str, list[Candle]],
                     instances: "dict[str, ResolvedInstance] | None" = None) -> "list[bool | None]":
    """Per-bar three-valued truth of a PATTERN predicate: None while undefined
    (warm-up / before the first aligned HTF close)."""
    vals = series_of(_hoist_predicate(node), candles, resolution, htf, instances)
    return [None if not _defined(v) else v >= 0.5 for v in vals]
```

4. `evaluate` becomes:

```python
    def evaluate(self, i: int, entry_price: float | None, entry_i: int | None = None) -> bool:
        return self._match3(self.node, i, entry_price, entry_i) is True
```

   Delete the `_matches` field from the dataclass, its use in the old `evaluate`, and drop the corresponding `{}` argument in `compile_row`'s `CompiledRow(...)` call. Delete the now-unused `_cmp` method. `Count` in `_val` changes its inner call from `self._match_at(...)` to `self._match3(...) is True` (an unknown bar is a non-match inside a window — matching today's warm-up-bar behavior).

5. Vectorized path: rename `_cond_matches` to `_cond_matches3` returning `list[bool | None]`, extending with BoolOp/Not/Chain:

```python
def _cond_matches3(cond: N.Node, candles, resolution, htf, instances=None) -> "list[bool | None]":
    n = len(candles)
    if isinstance(cond, N.BoolOp):
        per = [_cond_matches3(p, candles, resolution, htf, instances) for p in cond.parts]
        fold = _kleene_and if cond.op == "and" else _kleene_or
        return [fold([p[i] for p in per]) for i in range(n)]
    if isinstance(cond, N.Not):
        inner = _cond_matches3(cond.operand, candles, resolution, htf, instances)
        return [None if v is None else not v for v in inner]
    if isinstance(cond, N.Chain):
        per = [_cond_matches3(p, candles, resolution, htf, instances) for p in cond.parts]
        return [_kleene_and([p[i] for p in per]) for i in range(n)]
    if isinstance(cond, N.Predicate):
        if cond.fn in PATTERN_FNS:
            return _pattern_series3(cond, candles, resolution, htf, instances)
        bullish = cond.fn == "bullish"  # PREDICATE_FNS minus patterns is binary
        opens = series_of(_apply_field_to_candle(cond.base, "open"), candles, resolution, htf, instances)
        closes = series_of(_apply_field_to_candle(cond.base, "close"), candles, resolution, htf, instances)
        out: list[bool | None] = []
        for i in range(n):
            if not (_defined(opens[i]) and _defined(closes[i])):
                out.append(None)
            else:
                out.append(closes[i] > opens[i] if bullish else closes[i] < opens[i])
        return out
    if isinstance(cond, N.Cross):
        a = series_of(cond.a, candles, resolution, htf, instances)
        b = series_of(cond.b, candles, resolution, htf, instances)
        out = [None] * n  # i == 0: no prev bar, the straddle is unknowable
        for i in range(1, n):
            if not all(_defined(v) for v in (a[i], a[i - 1], b[i], b[i - 1])):
                out[i] = None
                continue
            if cond.fn == "crossAbove":
                out[i] = a[i - 1] <= b[i - 1] and a[i] > b[i]
            else:
                out[i] = a[i - 1] >= b[i - 1] and a[i] < b[i]
        return out
    # Compare
    left = series_of(cond.left, candles, resolution, htf, instances)
    right = series_of(cond.right, candles, resolution, htf, instances)
    return [_cmp3(cond.op, left[i], right[i]) for i in range(n)]
```

`_pattern_bool_series` loses its last caller with this rewrite — delete it (its docstring's "undefined is a non-match" convention now lives in the `is True` projection below).

   Then keep the old name as the boolean projection every existing caller uses:

```python
def _cond_matches(cond, candles, resolution, htf, instances=None) -> list[bool]:
    """Per-bar truth of an embedded condition; unknown -> non-match."""
    return [v is True for v in _cond_matches3(cond, candles, resolution, htf, instances)]
```

   (`series_of`'s `Count` branch and `closeness.py` keep calling `_cond_matches` unchanged.)

6. `compile_row`'s `subs` collection becomes a recursive walk:

```python
def _condition_operands(node: N.Node, subs: list[N.Node], seen: set[int]) -> None:
    """Collect the arithmetic operands of every comparison/cross in a condition
    tree, deduped by identity, for precomputation. Predicates precompute lazily
    via their own caches."""
    def add(operand: N.Node) -> None:
        if id(operand) not in seen:
            seen.add(id(operand))
            subs.append(operand)
    if isinstance(node, N.BoolOp):
        for p in node.parts:
            _condition_operands(p, subs, seen)
    elif isinstance(node, N.Not):
        _condition_operands(node.operand, subs, seen)
    elif isinstance(node, N.Chain):
        for p in node.parts:
            for operand in N.part_operands(p):
                add(operand)
    elif isinstance(node, N.Compare):
        add(node.left); add(node.right)
    elif isinstance(node, N.Cross):
        add(node.a); add(node.b)
    # Predicate: match series is built lazily on first evaluate
```

   and `compile_row` body:

```python
def compile_row(node, candles, resolution, htf, instances=None, *, source=""):
    cache: dict[int, list[float | None]] = {}
    subs: list[N.Node] = []
    _condition_operands(node, subs, set())
    for sub in subs:
        _precompute(sub, candles, resolution, htf, cache, instances)
    return CompiledRow(node, candles, resolution, htf, instances,
                       warmup_bars(node, resolution, instances), cache, {}, {},
                       source=source)
```

7. `terms_at`: replace the top-level dispatch with a recursive collector so boolean trees list every leaf:

```python
    def _leaf_terms(self, node: N.Node, i: int, entry, entry_i) -> "list[RuleTerm]":
        if isinstance(node, N.BoolOp):
            return [t for p in node.parts for t in self._leaf_terms(p, i, entry, entry_i)]
        if isinstance(node, N.Not):
            return self._leaf_terms(node.operand, i, entry, entry_i)
        if isinstance(node, N.Chain):
            return [t for p in node.parts for t in self._leaf_terms(p, i, entry, entry_i)]
        if isinstance(node, N.Compare):
            return [self._term(node.left, node.op, node.right, i, entry, entry_i)]
        if isinstance(node, N.Cross):
            return [self._term(node.a, self._CROSS_OP[node.fn], node.b, i, entry, entry_i)]
        # Predicate: single-operand term (op "") the popover renders label-only.
        return [RuleTerm(
            left_label=self._label(node), left_val=None, op="",
            right_label="", right_val=None,
            left_tf=self._operand_tf(node), right_tf=None,
        )]

    def terms_at(self, i, entry, entry_i=None) -> tuple[RuleTerm, ...]:
        if not self.source:
            return ()
        return tuple(self._leaf_terms(self.node, i, entry, entry_i))
```

8. `_entry_free`: add BoolOp/Not/Chain cases (`Chain` was previously unreachable there; boolean trees can now nest it):

```python
    if isinstance(node, (N.BoolOp,)):
        return all(_entry_free(p) for p in node.parts)
    if isinstance(node, N.Not):
        return _entry_free(node.operand)
    if isinstance(node, N.Chain):
        return all(_entry_free(p) for p in node.parts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_evaluate_bool.py tests/test_expr_evaluate.py tests/test_expr_evaluate_chain.py tests/test_expr_infix_cross_semantics.py tests/test_expr_boundary.py -q`
Expected: PASS. If a pre-existing test pinned `_match_at`/`_cond_matches` internals or `_matches`, update it to the new names/behavior in place — the public `evaluate()` contract (bool out, NaN never fires) is unchanged.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_evaluate_bool.py backend/tests/test_expr_evaluate.py backend/tests/test_expr_evaluate_chain.py
git commit -m "feat(expr): three-valued evaluation of and/or/not, terms across branches"
```

---

### Task 5: Backend closeness for boolean rows

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py`
- Test: `backend/tests/test_expr_closeness_bool.py` (create)

**Interfaces:**
- Consumes: `row_closeness`, `_fold`, `_cond_matches`, Tasks 1–4.
- Produces: `row_closeness` handles BoolOp (AND→min fold, OR→max fold), and `Not` via a `_NEG_OP` comparison flip / De Morgan recursion / binary complement. `group_closeness` signature unchanged.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_closeness_bool.py
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import Norm, row_closeness
from auto_trader.strategy.expr.parser import parse

NORM = Norm(basis="volatility", width=2.0, window=3, atr_length=14)


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _closeness(src, closes):
    candles = _candles(closes)
    return row_closeness(parse(src), candles, "HOUR", {}, NORM)


def test_or_takes_the_best_branch():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    both = _closeness("candle.close > 100 or candle.close > 11", closes)
    hard = _closeness("candle.close > 100", closes)
    easy = _closeness("candle.close > 11", closes)
    i = len(closes) - 1
    assert both[i] == max(hard[i], easy[i])


def test_and_takes_the_worst_branch():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    both = _closeness("candle.close > 100 and candle.close > 11", closes)
    hard = _closeness("candle.close > 100", closes)
    easy = _closeness("candle.close > 11", closes)
    i = len(closes) - 1
    assert both[i] == min(hard[i], easy[i])


def test_not_compare_is_the_flipped_comparison():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    a = _closeness("not candle.close > 11", closes)
    b = _closeness("candle.close <= 11", closes)
    assert a == b


def test_not_predicate_is_binary_complement():
    # all-bullish bars: bullish -> 1.0, not bullish -> 0.0
    closes = [10.0, 11.0, 12.0, 13.0]
    candles = _candles(closes)
    for i, c in enumerate(candles):
        candles[i] = Candle(time=c.time, open=c.close - 0.5, high=c.high, low=c.low, close=c.close, volume=100)
    vals = row_closeness(parse("not bullish(candle)"), candles, "HOUR", {}, NORM)
    assert all(v == 0.0 for v in vals)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_closeness_bool.py -q`
Expected: FAIL (row_closeness reaches `row_gap_series` with a BoolOp and crashes).

- [ ] **Step 3: Implement**

In `closeness.py`, add the op-flip map and extend `row_closeness` (before the Predicate branch):

```python
# Negation of a comparison flips its operator: not (a > b) == a <= b.
_NEG_OP = {">": "<=", ">=": "<", "<": ">=", "<=": ">"}
```

```python
    if isinstance(node, N.BoolOp):
        per = [row_closeness(p, candles, resolution, htf, norm, instances) for p in node.parts]
        return _fold(per, "AND" if node.op == "and" else "OR", len(candles))
    if isinstance(node, N.Not):
        return _not_closeness(node.operand, candles, resolution, htf, norm, instances)
```

and the helper:

```python
def _not_closeness(inner, candles, resolution, htf, norm, instances):
    """Closeness of a negated condition. Compare: the flipped-operator gap ramp.
    Boolean nodes: De Morgan recursion. Cross/Predicate are binary events with
    no gradient toward NOT happening: 1 when the inner condition does not hold,
    else 0. Chain: not(a and b) = not a or not b."""
    n = len(candles)
    if isinstance(inner, N.Not):
        return row_closeness(inner.operand, candles, resolution, htf, norm, instances)
    if isinstance(inner, N.BoolOp):
        flipped = "OR" if inner.op == "and" else "AND"
        per = [_not_closeness(p, candles, resolution, htf, norm, instances) for p in inner.parts]
        return _fold(per, flipped, n)
    if isinstance(inner, N.Chain):
        per = [_not_closeness(p, candles, resolution, htf, norm, instances) for p in inner.parts]
        return _fold(per, "OR", n)
    if isinstance(inner, N.Compare):
        import dataclasses
        flipped_cmp = dataclasses.replace(inner, op=_NEG_OP[inner.op])
        return row_closeness(flipped_cmp, candles, resolution, htf, norm, instances)
    # Cross | Predicate: binary complement (unknown stays a 0, like the
    # Predicate branch of row_closeness treats non-matches).
    m = _cond_matches(inner, candles, resolution, htf, instances)
    return [0.0 if v else 1.0 for v in m]
```

Also `group_closeness`/`row_closeness` docstrings: no signature change, but note boolean nodes in the `row_closeness` docstring if it has one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_closeness_bool.py tests/test_expr_closeness.py tests/test_expr_closeness_router.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness_bool.py
git commit -m "feat(expr): heatmap closeness folds through and/or/not"
```

---

### Task 6: Backend sweep-literal extraction through boolean nodes

**Files:**
- Modify: `backend/auto_trader/strategy/expr/literals.py`
- Test: `backend/tests/test_expr_literals_bool.py` (create)

**Interfaces:**
- Consumes: Tasks 1–2. Read `literals.py` fully first — the public entry is `compute_literals(node) -> list[Literal]` with top-level dispatch on the Row kind (Predicate / Chain / Compare / Cross), each side collected with "threshold"/"constant" labels, then one global sort-by-start pass assigning ordinals.
- Produces: `compute_literals` handles BoolOp/Not by recursing per condition part into the existing per-shape collection, keeping ONE global sort+ordinal pass at the end (ordinals stay position-ordered across the whole row).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_expr_literals_bool.py
from auto_trader.strategy.expr.literals import compute_literals
from auto_trader.strategy.expr.parser import parse


def test_literals_collected_across_or_branches_in_position_order():
    lits = compute_literals(parse("RSI(14) > 70 or RSI(21) < 30"))
    assert [l.value for l in lits] == [14, 70, 21, 30]
    assert [l.ordinal for l in lits] == [0, 1, 2, 3]
    assert lits[0].label == "RSI length"
    assert lits[1].label == "threshold"


def test_literals_inside_not():
    lits = compute_literals(parse("not EMA(9) > 100"))
    assert [l.value for l in lits] == [9, 100]
    assert lits[1].label == "threshold"


def test_cross_branch_literals_stay_constants():
    lits = compute_literals(parse("EMA(9) x> EMA(50) or RSI(14) > 70"))
    assert [l.value for l in lits] == [9, 50, 14, 70]
    # cross operands follow the cross rule ("EMA length" for args, no threshold)
    assert lits[3].label == "threshold"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_literals_bool.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

Refactor `compute_literals`: extract the existing per-Row-kind collection (the Predicate/Chain/Compare/Cross dispatch that fills the collected list) into a helper `_collect_row(node, out)` that does NOT sort, add BoolOp/Not recursion there:

```python
def _collect_row(node: N.Node, out: list) -> None:
    if isinstance(node, N.BoolOp):
        for p in node.parts:
            _collect_row(p, out)
        return
    if isinstance(node, N.Not):
        _collect_row(node.operand, out)
        return
    # ... existing Predicate / Chain / Compare / Cross collection, verbatim ...
```

then `compute_literals` calls `_collect_row(node, out)` once and keeps its existing single sort-by-start + ordinal assignment ending.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_literals_bool.py tests/test_expr_literals.py tests/test_expr_chain_literals.py tests/test_expr_sweep.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/literals.py backend/tests/test_expr_literals_bool.py
git commit -m "feat(expr): sweep literals collected through boolean nodes"
```

---

### Task 7: Backend group combine — engine, DTOs, routers

**Files:**
- Modify: `backend/auto_trader/strategy/expr/strategy.py`
- Modify: `backend/auto_trader/api/schemas.py` (`ExprBacktestRequest`, `EvaluateRequest`, and the coded `BacktestRequest` if it carries `exprLongExit`)
- Modify: `backend/auto_trader/api/routers/expr.py` (`expr_backtest`, ~line 240)
- Modify: `backend/auto_trader/api/routers/strategy.py` (~lines 162, 252)
- Modify: `backend/auto_trader/api/sweep_apply.py` (~lines 217, 299)
- Test: `backend/tests/test_expr_group_combine.py` (create)

**Interfaces:**
- Consumes: `ExprRuleStrategy`, existing DTOs.
- Produces:
  - `ExprRuleStrategy.__init__` gains keyword-only args `long_entry_combine: str = "AND"`, `long_exit_combine: str = "AND"`, `short_entry_combine: str = "AND"`, `short_exit_combine: str = "AND"`.
  - `_passes(rows, i, entry, entry_i=None, combine="AND")`: `any` fold for `"OR"`, `all` otherwise; empty group still never fires.
  - `_provenance(rows, i, entry, entry_i, combine)`: only PASSING rows contribute (in AND mode that is all of them); reason joins with `f" {combine} "`.
  - `ExprBacktestRequest` gains `longEntryCombine: str = "AND"`, `longExitCombine: str = "AND"`, `shortEntryCombine: str = "AND"`, `shortExitCombine: str = "AND"`.
  - `EvaluateRequest` gains `exprLongEntryCombine: str = "AND"`, `exprLongExitCombine: str = "AND"`, `exprShortEntryCombine: str = "AND"`, `exprShortExitCombine: str = "AND"`. If the coded `BacktestRequest` schema carries `exprLongExit`/`exprShortExit` (it does — sweep_apply reads them), it gains `exprLongExitCombine: str = "AND"` / `exprShortExitCombine: str = "AND"` too.
  - The Signal's existing `combine` DTO field (`schemas.py:76`) is stamped with the firing group's combine.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_group_combine.py
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.base import Context
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _rows(candles, *srcs):
    return [compile_row(parse(s), candles, "HOUR", {}, source=s) for s in srcs]


def _ctx(candles):
    # Build the minimal Context the strategy reads; mirror how the existing
    # strategy tests construct it (see tests that exercise ExprRuleStrategy /
    # the engine for the exact constructor shape in this repo).
    ctx = Context(history=candles, bar=candles[-1])
    ctx.position_long = 0
    ctx.position_short = 0
    return ctx


def test_or_group_fires_when_one_row_passes():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    signals = strat.on_bar(_ctx(candles))
    assert len(signals) == 1
    # Only the passing row's source appears in the reason.
    assert signals[0].reason == "candle.close > 5"


def test_and_group_needs_every_row():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0)  # default AND
    assert strat.on_bar(_ctx(candles)) == []


def test_or_reason_joins_multiple_passing_rows():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 5", "candle.close > 6")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    signals = strat.on_bar(_ctx(candles))
    assert signals[0].reason == "candle.close > 5 OR candle.close > 6"


def test_empty_group_never_fires_even_in_or():
    candles = _candles([10] * 5)
    strat = ExprRuleStrategy([], [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    assert strat.on_bar(_ctx(candles)) == []
```

(Adjust `_ctx` to this repo's actual `Context` constructor — copy from an existing `ExprRuleStrategy`/engine test rather than inventing fields. The four behavioral assertions are the contract.)

Also add an API-level test to the existing `backend/tests/test_api_expr.py` pattern: POST `/api/expr/backtest` with two long-entry rows where only one passes and `"longEntryCombine": "OR"`, assert at least one trade; with the default combine, assert zero trades. Copy the request scaffolding from an existing passing test in that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_group_combine.py -q`
Expected: FAIL (`unexpected keyword argument 'long_entry_combine'`).

- [ ] **Step 3: Implement**

`strategy.py`:

```python
    def __init__(
        self,
        long_entry, long_exit, short_entry, short_exit, quantity,
        trade_from_time=None,
        *,
        long_enabled: bool = True,
        short_enabled: bool = True,
        long_entry_combine: str = "AND",
        long_exit_combine: str = "AND",
        short_entry_combine: str = "AND",
        short_exit_combine: str = "AND",
    ) -> None:
        ...
        self.long_entry_combine = long_entry_combine
        self.long_exit_combine = long_exit_combine
        self.short_entry_combine = short_entry_combine
        self.short_exit_combine = short_exit_combine
```

```python
    @staticmethod
    def _passes(rows, i, entry, entry_i=None, combine="AND"):
        # An empty group never fires, matching RuleStrategy — also in OR mode
        # (any([]) is False, but keep the explicit guard for the reader).
        if not rows:
            return False
        fold = any if combine == "OR" else all
        return fold(r.evaluate(i, entry, entry_i) for r in rows)

    @staticmethod
    def _provenance(rows, i, entry, entry_i, combine="AND"):
        """(reason, terms) for a group that just passed at bar `i`. Only rows
        that PASSED contribute — in AND mode that is every row; in OR mode the
        failing rows' terms would misattribute the signal."""
        passing = [r for r in rows if r.evaluate(i, entry, entry_i)]
        reason = f" {combine} ".join(r.source for r in passing if r.source)
        terms = tuple(t for r in passing for t in r.terms_at(i, entry, entry_i))
        return reason, terms
```

`on_bar`: thread the right combine into each `_passes`/`_provenance` pair, e.g. the long-entry block becomes:

```python
            if not gated and self._passes(self.long_entry, i, None, combine=self.long_entry_combine):
                reason, terms = self._provenance(self.long_entry, i, None, None, self.long_entry_combine)
                out.append(Signal(Side.BUY, self.quantity, reason, leg="long", terms=terms))
```

(same shape for the other three blocks). If the Signal→Fill plumbing exposes the `combine` DTO field (`schemas.py:72-76` says it names the firing group's AND/OR), find where that field is populated (grep `combine=` in the fill/signal serialization path) and stamp the group's combine there so the signal popover renders the right conjunction. Update the module docstring ("rows in a group combine with AND" → "rows in a group combine with the group's AND/OR setting").

`schemas.py`: add the DTO fields listed in Interfaces, each with a one-line comment `# how this group's rows combine: "AND" (default) | "OR"`.

Routers: pass them through at every construction site —
- `routers/expr.py:240`: `long_entry_combine=req.longEntryCombine, long_exit_combine=req.longExitCombine, short_entry_combine=req.shortEntryCombine, short_exit_combine=req.shortExitCombine`.
- `routers/strategy.py:162`: same from the `exprLongEntryCombine` etc. fields.
- `routers/strategy.py:252` (`CodedWithExprExits`): exits only — `long_exit_combine=req.exprLongExitCombine, short_exit_combine=req.exprShortExitCombine`.
- `sweep_apply.py:299` and `:217`: same pattern; these build from the sweep's stored request body, which is `ExprBacktestRequest`-shaped (299) / coded-with-exits-shaped (217) — use the matching field names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_group_combine.py tests/test_api_expr.py tests/test_expr_sweep_run.py tests/test_expr_wfo.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/expr/strategy.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/expr.py backend/auto_trader/api/routers/strategy.py backend/auto_trader/api/sweep_apply.py backend/tests/test_expr_group_combine.py backend/tests/test_api_expr.py
git commit -m "feat(expr): honor the per-group AND/OR combine end to end"
```

---

### Task 8: Frontend parser mirror

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts`
- Test: extend `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 as the behavioral reference — mirror them case for case.
- Produces: `analyze()` accepts the boolean grammar with identical error codes/spans; AST kinds `{ kind: "BoolOp"; op: "and" | "or"; parts: Node[] }` and `{ kind: "Not"; operand: Node }`; `warmupOf` and `literalsOf` handle them. `CONDITION_KINDS` as a `ReadonlySet<string>` of kind strings.

- [ ] **Step 1: Write the failing tests** (append to `parser.test.ts`, following its existing describe/it style — read the file's helpers first and reuse them)

Cover, minimum:
- `analyze("RSI(14) > 70 or RSI(14) < 30")` → no error; literals `[14, 70, 14, 30]` with ordinals 0–3.
- `analyze("not bullish(candle)")` → no error.
- `analyze("(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70")` → no error.
- `analyze("candle.close and EMA(9)")` → error code `expected_condition`, from 0, to 12.
- `analyze("not candle.close")` → error `expected_condition`, from 4, to 16.
- `analyze("(candle.close > EMA(9))[-1]")` → error `bool_as_value`.
- `analyze("EMA(9) x> EMA(50) x< EMA(20)")` → no error (multiple_crosses deleted).
- `analyze("EMA(9) EMA(21)")` → still `expected_operator` at 7–10.
- `analyze("AND > 1")` → `unknown_name` (uppercase not a keyword).
- `warmupOf("EMA(50) > 0 or EMA(9) > 0")` → 50; `warmupOf("not EMA(21) > 0")` → 21.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement** — mirror every backend change:

- Lexer: `const KEYWORDS: Record<string, string> = { and: "AND", or: "OR", not: "NOT" };` and in the word branch `out.push({ type: KEYWORDS[word] ?? "NAME", value: word, start: i, end: j });`.
- AST: add `BoolOpNode`/`NotNode` interfaces, extend the `Node` and `Row` unions, `CountNode.cond: Node`, and:

```ts
const CONDITION_KINDS: ReadonlySet<string> = new Set([
  "Compare", "Cross", "Chain", "Predicate", "BoolOp", "Not",
]);
const isCondition = (n: Node): boolean => CONDITION_KINDS.has(n.kind);
```

- Parser: `parseRow` → `parseOr`/`parseAnd`/`parseNot`/`parseConditionUnit` + `requireCondition`/`raiseExpectedOperator`, transliterating Task 2's Python exactly (same error codes, same message strings — `"and, or and not need a condition, like candle.close > EMA(9)."`, `"A condition can't be used as a value here."`, updated `cross_not_toplevel` message `"A comparison or cross can't be used as a value."`). LPAREN branch of `parsePrimary` parses `parseOr()` and applies the `bool_as_value` postfix guard. `count` uses `parseOr()` + condition check; delete `parseCondition`. Delete the `multiple_crosses` block.
- `containsTf`, `pinnedInstance`, `containsEntryKind`: add BoolOp (`parts.some(...)` / `first(parts.map(...))`) and Not (recurse operand) cases, keeping each function's mirror-comment discipline.
- `warmupNode`: `case "BoolOp": return Math.max(...node.parts.map((p) => warmupNode(p, baseSeconds, refs)));` and `case "Not": return warmupNode(node.operand, baseSeconds, refs);`.
- `literalsOf`: restructure like backend Task 6 — extract the Row-kind dispatch into `collectRow(node, out)`, add BoolOp/Not recursion, keep the single sort+ordinal pass. `render()` gains `case "BoolOp"` (join parts with ` ${node.op} `) and `case "Not"` (`not ${render(node.operand)}`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/parser.test.ts src/lib/expr/sweepLiterals.test.ts src/lib/expr/pruneLitAxes.test.ts`
Expected: PASS (corpus test still red until Task 9).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr-ui): mirror the boolean grammar in the TS parser"
```

---

### Task 9: Shared corpus fixtures

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json`
- Test: `backend/tests/test_expr_parser_corpus.py` + `frontend/src/lib/expr/corpus.test.ts` (existing suites; no new files)

**Interfaces:**
- Consumes: both parsers from Tasks 2 and 8. Corpus case shape: `{ "expr", "isExit", "error": null | {code, from, to}, "literals": [{ordinal, value, from, to, label}] }`.
- Produces: corpus covers the boolean grammar; BOTH parity suites green — this is the gate that certifies the two stacks agree.

- [ ] **Step 1: Add the new cases**

Append these expressions (fill exact `from`/`to`/`literals` values by running the BACKEND on each — e.g. a scratch `python -c "from auto_trader.strategy.expr.parser import parse; from auto_trader.strategy.expr.literals import compute_literals; ..."` — then sanity-check each span by counting characters; the backend is the authority the corpus pins):

1. `"RSI(14) > 70 or RSI(14) < 30"` — ok; 4 literals.
2. `"EMA(9) x> EMA(50) or RSI(14) x< 30"` — ok.
3. `"not bullish(candle)"` — ok; no literals.
4. `"not candle.close > EMA(9)"` — ok.
5. `"(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70"` — ok.
6. `"count(bullish(candle) and candle.close > EMA(9), 5) > 2"` — ok.
7. `"candle.close and EMA(9)"` — error `expected_condition`.
8. `"not candle.close"` — error `expected_condition`.
9. `"(candle.close > EMA(9))[-1]"` — error `bool_as_value`.
10. `"EMA(9) x> EMA(50) x< EMA(20)"` — ok (was `multiple_crosses`; if an old corpus case asserts `multiple_crosses`, change it to the new expectation).
11. `"AND > 1"` — error `unknown_name` (case-sensitivity pin).
12. `"candle.close > EMA(9) and"` — error `unexpected_token`.

Also sweep the existing corpus for cases whose expected error was `multiple_crosses` or whose message text is asserted anywhere — corpus stores codes/spans only, but check both corpus test files for message assertions and update them.

- [ ] **Step 2: Run both parity suites**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_expr_parser_corpus.py -q && cd ../frontend && npx vitest run src/lib/expr/corpus.test.ts`
Expected: BOTH PASS. Any disagreement is a Task 2 vs Task 8 divergence — fix the TS side to match the backend, never the corpus to match the TS.

- [ ] **Step 3: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/expr/corpus.json backend/tests/test_expr_parser_corpus.py frontend/src/lib/expr/corpus.test.ts
git commit -m "test(expr): corpus coverage for and/or/not — both parsers pinned"
```

---

### Task 10: Editor surfaces — highlight, autocomplete, palette

**Files:**
- Modify: `frontend/src/lib/expr/catalog.ts`
- Modify: `frontend/src/lib/expr/highlight.ts`
- Modify: `frontend/src/lib/expr/complete.ts`
- Modify: `frontend/src/lib/expr/grammar.lezer` (doc-only grammar; keep it honest)
- Modify: `frontend/src/components/RulePalette.tsx`
- Test: extend `frontend/src/lib/expr/highlight.test.ts` and `frontend/src/lib/expr/complete.test.ts`

**Interfaces:**
- Consumes: Task 8's tokens (`AND`/`OR`/`NOT` token types come out of `analyze().tokens`).
- Produces: `catalog.ts` exports `LOGIC: CatalogEntry[]` — used by complete + palette:

```ts
// Boolean operators between conditions: not > and > or, parens group.
export const LOGIC: CatalogEntry[] = [
  { name: "and", insert: "and ", signature: "cond and cond", detail: "Both conditions must hold" },
  { name: "or", insert: "or ", signature: "cond or cond", detail: "Either condition may hold" },
  { name: "not", insert: "not ", signature: "not cond", detail: "The condition must not hold" },
];
```

- [ ] **Step 1: Write the failing tests**

In `highlight.test.ts` (follow its existing assertion helper style): tokens of `"a > 1 and b > 2"` include a mark of class `cm-tok-logic` over `and` (positions 6–9). In `complete.test.ts`: `completionsFor` with text `"candle.close > EMA(9) "` (cursor at end) offers `and`/`or` among candidates; bare-prefix `"an"` ranks `and`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/highlight.test.ts src/lib/expr/complete.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

- `catalog.ts`: add the `LOGIC` export above (near `CROSS_OPS`).
- `highlight.ts`: add `logic: Decoration.mark({ class: "cm-tok-logic" })` to `marks`, and in `classify`, before the NAME handling, map token types `"AND" | "OR" | "NOT"` → `"logic"` (they are dedicated types now, not NAMEs). Add the CSS class wherever the existing `cm-tok-*` styles live (grep `cm-tok-cross` in `frontend/src` to find the stylesheet; give `cm-tok-logic` the same treatment pattern — a distinct color consistent with the theme's keyword styling).
- `complete.ts`: append `LOGIC` entries to `WORD_CANDIDATES` (same `fnCandidate`-style construction the file uses; type them `"logic"`). No context-narrowing needed in v1 — they rank by prefix like other words.
- `RulePalette.tsx`: import `LOGIC` and add a `{ title: "Logic", items: ... }` group after the Crosses group, following the existing GROUPS mapping shape.
- `grammar.lezer`: update the doc grammar to reflect the boolean layer (permissive, highlighting-only — mirror the shape of Task 2's grammar comment) and note that `and/or/not` are specialized keywords; this file is documentation for the classify-based highlighter, keep the header comment accurate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/`
Expected: ALL expr-lib suites PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/complete.ts frontend/src/lib/expr/grammar.lezer frontend/src/components/RulePalette.tsx frontend/src/lib/expr/highlight.test.ts frontend/src/lib/expr/complete.test.ts
git commit -m "feat(expr-ui): and/or/not in highlighting, autocomplete, and the palette"
```

(Include the stylesheet file you touched for `cm-tok-logic` in the `git add`.)

---

### Task 11: Group AND/OR toggle UI + request wiring

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`RuleGroupSection`, ~line 4204 `extra` block)
- Modify: `frontend/src/BacktestButton.tsx` (`exprReq`, ~line 445; coded `baseReq`, ~line 412)
- Modify: `frontend/src/api.ts` (`ExprBacktestRequest`, `BacktestRequest`)
- Modify: `frontend/src/lib/liveEngine.ts` (~line 133)
- Modify: `frontend/src/lib/liveTypes.ts` (if `EvaluateRequest` is typed there — grep `exprLongEntry` to confirm which file declares it)
- Test: `frontend/src/BacktestSettingsModal.combine.test.tsx` (create)

**Interfaces:**
- Consumes: `RuleGroup.combine` (already in `backtestConfig.ts`), Task 7's DTO field names.
- Produces: a segmented AND/OR control in each group header (visible when the group has ≥ 2 rules, default AND); `ExprBacktestRequest` carries `longEntryCombine`/`longExitCombine`/`shortEntryCombine`/`shortExitCombine`; `EvaluateRequest` carries `exprLongEntryCombine`/`exprLongExitCombine`/`exprShortEntryCombine`/`exprShortExitCombine`; coded `BacktestRequest` carries `exprLongExitCombine`/`exprShortExitCombine`.

- [ ] **Step 1: Write the failing component test**

```tsx
// frontend/src/BacktestSettingsModal.combine.test.tsx
// Follow the render/setup helpers of BacktestSettingsModal.test.tsx — reuse its
// mounting utilities rather than hand-rolling providers.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RuleGroupSection } from "./BacktestSettingsModal";

const twoRules = {
  combine: "AND" as const,
  rules: [{ expr: "candle.close > 1", enabled: true }, { expr: "candle.close > 2", enabled: true }],
};

describe("RuleGroupSection combine toggle", () => {
  it("renders AND/OR for a multi-rule group and emits the switch", () => {
    const onChange = vi.fn();
    render(<RuleGroupSection title="Buy to open" group={twoRules} onChange={onChange}
                             emptyHint="none" />);
    const or = screen.getByRole("radio", { name: "OR" });
    fireEvent.click(or);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ combine: "OR" }));
  });

  it("hides the toggle for a single-rule group", () => {
    const one = { combine: "AND" as const, rules: [{ expr: "candle.close > 1", enabled: true }] };
    render(<RuleGroupSection title="Buy to open" group={one} onChange={() => {}}
                             emptyHint="none" />);
    expect(screen.queryByRole("radiogroup", { name: /combine/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.combine.test.tsx`
Expected: FAIL (no radiogroup rendered).

- [ ] **Step 3: Implement**

`RuleGroupSection` — in the `extra` prop block, render the toggle BEFORE the copy/delete buttons, only when `group.rules.length >= 2`:

```tsx
            {group.rules.length >= 2 && (
              <Tooltip
                content={
                  (group.combine ?? "AND") === "AND"
                    ? "All rules must pass for this group to fire"
                    : "Any one rule passing fires this group"
                }
              >
                <div className="bt-combine-toggle" role="radiogroup" aria-label="Combine rules with">
                  {(["AND", "OR"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={(group.combine ?? "AND") === c}
                      className={`bt-combine-opt${(group.combine ?? "AND") === c ? " on" : ""}`}
                      onClick={() => onChange({ ...group, combine: c } as RuleGroup)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </Tooltip>
            )}
```

Note the surrounding `extra` block currently renders only when `group.rules.length > 0`; keep that outer condition and add this inside it. Styles: add `.bt-combine-toggle` / `.bt-combine-opt` next to the existing `.bt-rule-toggle` styles (grep `bt-copyall` to find the stylesheet) — a small two-segment pill, `on` state uses the same accent treatment as `.bt-palette-toggle.on`.

`api.ts` — extend the interfaces:

```ts
// ExprBacktestRequest
  longEntryCombine?: "AND" | "OR";
  longExitCombine?: "AND" | "OR";
  shortEntryCombine?: "AND" | "OR";
  shortExitCombine?: "AND" | "OR";
// BacktestRequest (coded runs post panel exits as expressions)
  exprLongExitCombine?: "AND" | "OR";
  exprShortExitCombine?: "AND" | "OR";
```

`BacktestButton.tsx` — in `exprReq` after the four group lines:

```ts
        longEntryCombine: effCfg.longEntry.combine,
        longExitCombine: effCfg.longExit.combine,
        shortEntryCombine: effCfg.shortEntry.combine,
        shortExitCombine: effCfg.shortExit.combine,
```

and in the coded `baseReq` next to `exprLongExit`/`exprShortExit`:

```ts
        exprLongExitCombine: effCfg.longExit.combine,
        exprShortExitCombine: effCfg.shortExit.combine,
```

`liveEngine.ts` — next to the `exprLongEntry` lines (coded mode mirrors its exit-group sources):

```ts
    exprLongEntryCombine: coded ? undefined : cfg.longEntry.combine,
    exprLongExitCombine: coded ? (codedCfg?.longExit ?? emptyGroup).combine : cfg.longExit.combine,
    exprShortEntryCombine: coded ? undefined : cfg.shortEntry.combine,
    exprShortExitCombine: coded ? (codedCfg?.shortExit ?? emptyGroup).combine : cfg.shortExit.combine,
```

Type the new `EvaluateRequest` fields wherever that interface is declared (grep `exprLongEntry` in `frontend/src` — `liveTypes.ts` or `api.ts`). The heatmap path (`heatmapController.ts`) already sends `group.combine` — no change; eyeball it to confirm.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.combine.test.tsx src/BacktestSettingsModal.test.tsx src/lib/liveEngine.test.ts 2>/dev/null || npx vitest run src/BacktestSettingsModal.combine.test.tsx src/BacktestSettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.combine.test.tsx frontend/src/BacktestButton.tsx frontend/src/api.ts frontend/src/lib/liveEngine.ts
git commit -m "feat(backtest): restore the group AND/OR toggle, wire combine through every request"
```

(Include the stylesheet and `liveTypes.ts` in the `git add` if touched.)

---

### Task 12: Full-suite verification

**Files:** none new.

- [ ] **Step 1: Run the full backend suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest -q`
Expected: PASS. Fix any straggler (most likely: a test pinning the old `cross_not_toplevel` message, the deleted `multiple_crosses` code, `_matches`/`_match_at` internals, or a `CompiledRow` constructor arity).

- [ ] **Step 2: Run the full frontend suite**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Manual smoke (if a dev environment is available)**

Backtest modal → two long-entry rules where only one can pass → flip the group to OR → run → trades appear; flip back to AND → zero trades. Type `RSI(14) > 70 or RSI(14) < 30` in a row → keywords highlight, no lint error, both thresholds show the sweep underline. Signal popover on an OR trade shows only the firing row's terms.

- [ ] **Step 4: Final commit if fixes were made**

```bash
cd /Users/mahmoudparham/auto_trader
git add <only files changed in this task>
git commit -m "test(expr): full-suite fixes for the boolean-operator landing"
```
