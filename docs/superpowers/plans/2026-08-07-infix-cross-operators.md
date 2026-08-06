# Infix Cross Operators (`x>` / `x<`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add infix cross operators `a x> b` (crosses above) and `a x< b` (crosses below) to the rule DSL, equivalent to `crossAbove(a, b)` / `crossBelow(a, b)`, allowed once per comparison chain.

**Architecture:** Both surface forms produce the identical `Cross` AST node, so lone-cross evaluation/warmup/closeness are untouched. The only semantic addition is a `Cross` appearing inside `Chain.parts` (at most one per row). The backend Python pipeline (`backend/auto_trader/strategy/expr/`) is the source of truth; the frontend TypeScript port (`frontend/src/lib/expr/parser.ts`) mirrors it token-for-token and both are pinned by the shared parity corpus `frontend/src/lib/expr/corpus.json`.

**Tech Stack:** Python 3.12 dataclass AST + pytest (repo venv: `.venv/bin/pytest`, run from `backend/`); TypeScript + vitest (`cd frontend && npm run test:unit`); CodeMirror 6 editor surfaces.

**Spec:** `docs/superpowers/specs/2026-08-07-infix-cross-operators-design.md`

## Global Constraints

- **Stay on `main`. Other Claude sessions are working in this same checkout.** Never run `git add -A`, `git add .`, `git stash`, `git rebase`, or `git checkout -- <file>` on files you did not edit. `git add` ONLY the exact paths your task names. If `git status` shows unrelated dirty files (e.g. `backend/tests/test_indicator_ref_parse.py`), leave them alone.
- New error codes and messages, verbatim: `multiple_crosses` → "Only one cross per row."; `bad_cross_op` → "Write the cross operator as x> or x< — lowercase, no space." Existing `cross_not_toplevel` message "A comparison or cross can only be the whole row." is reused unchanged.
- `expected_operator` message becomes "Expected a comparison operator (> < >= <= x> x<)." in BOTH parsers.
- Token types are `XGT` (`x>`) and `XLT` (`x<`). Lowercase `x` only, no space, immediately followed by `>` or `<`.
- `crossAbove` / `crossBelow` function forms keep working everywhere; do not remove or deprecate them.
- Backend tests: `cd backend && ../.venv/bin/pytest tests/<file> -q`. Frontend: `cd frontend && npm run test:unit -- --run <file>`.

---

### Task 1: Backend lexer — `XGT`/`XLT` tokens

**Files:**
- Modify: `backend/auto_trader/strategy/expr/lexer.py:47-53` (the identifier branch)
- Test: `backend/tests/test_expr_lexer_cross.py` (create)

**Interfaces:**
- Produces: `tokenize` emits `Token("XGT", "x>", i, i+2)` / `Token("XLT", "x<", i, i+2)` when an identifier scan yields exactly `"x"` immediately followed by `>` or `<`. Task 2's parser consumes these token types.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_lexer_cross.py`:

```python
from auto_trader.strategy.expr.lexer import tokenize


def _types(src):
    return [t.type for t in tokenize(src)]


def test_x_gt_lexes_as_single_token():
    toks = tokenize("EMA(9) x> EMA(50)")
    assert _types("EMA(9) x> EMA(50)") == [
        "NAME", "LPAREN", "NUMBER", "RPAREN", "XGT",
        "NAME", "LPAREN", "NUMBER", "RPAREN", "EOF",
    ]
    xgt = toks[4]
    assert (xgt.value, xgt.start, xgt.end) == ("x>", 7, 9)


def test_x_lt_lexes_as_single_token():
    toks = tokenize("candle.close x< EMA(9)")
    assert toks[3].type == "XLT"
    assert (toks[3].value, toks[3].start, toks[3].end) == ("x<", 13, 15)


def test_spaced_x_stays_a_name():
    # "x >" is NOT the operator: NAME then GT.
    assert _types("EMA(9) x > EMA(50)")[4:6] == ["NAME", "GT"]


def test_uppercase_x_stays_a_name():
    assert _types("X> EMA(9)")[:2] == ["NAME", "GT"]


def test_longer_identifier_ending_in_x_stays_a_name():
    # only a bare "x" fuses with the bracket
    assert _types("max> 3")[:2] == ["NAME", "GT"]


def test_number_absorbs_trailing_x():
    # digit branch absorbs alnum (as it must for 4H): "50x" is one NAME.
    toks = tokenize("50x> 60")
    assert [t.type for t in toks] == ["NAME", "GT", "NUMBER", "EOF"]
    assert toks[0].value == "50x"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_lexer_cross.py -q`
Expected: FAIL — `test_x_gt_lexes_as_single_token` gets `NAME`/`GT` where `XGT` is expected.

- [ ] **Step 3: Implement**

In `backend/auto_trader/strategy/expr/lexer.py`, replace the identifier branch:

```python
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            word = src[i:j]
            # A bare "x" fused to a comparison bracket is the infix cross
            # operator: x> (crosses above) / x< (crosses below).
            if word == "x" and j < n and src[j] in "<>":
                out.append(Token("XGT" if src[j] == ">" else "XLT", src[i:j + 1], i, j + 1))
                i = j + 1
                continue
            out.append(Token("NAME", word, i, j))
            i = j
            continue
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_lexer_cross.py tests/test_expr_parser.py -q`
Expected: new file PASS; `test_expr_parser.py` still PASS (no existing expression contains `x>`).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/lexer.py backend/tests/test_expr_lexer_cross.py
git commit -m "feat(expr): lex x> and x< as infix cross tokens"
```

---

### Task 2: Backend parser + nodes — infix crosses in rows and count conditions

**Files:**
- Modify: `backend/auto_trader/strategy/expr/nodes.py:94-98` (`Chain`), append accessor at end
- Modify: `backend/auto_trader/strategy/expr/parser.py` (`expect`, `parse_row`, `parse_condition`, `parse_primary`)
- Test: `backend/tests/test_expr_parser_infix_cross.py` (create)

**Interfaces:**
- Consumes: `XGT`/`XLT` tokens from Task 1.
- Produces:
  - `N.Chain.parts` typed `list["Compare | Cross"]`; a chain may hold at most one `Cross` part (parser-enforced).
  - `nodes.part_operands(part: Compare | Cross) -> tuple[Node, Node]` — a chain part's `(left, right)` operands regardless of shape. Tasks 3 uses this.
  - `parse("a x> b")` returns a bare `N.Cross("crossAbove", a, b, a.start, b.end)`; `parse("a x< b")` → `fn="crossBelow"`. Mixed rows return `N.Chain` whose parts include one `Cross`.
  - Error codes `multiple_crosses`, `bad_cross_op`; `XGT`/`XLT` hitting any `expect()` raises `cross_not_toplevel`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_expr_parser_infix_cross.py`:

```python
import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse


def test_lone_infix_cross_above_is_bare_cross_node():
    row = parse("EMA(9) x> EMA(50)")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossAbove"
    assert isinstance(row.a, N.Call) and row.a.name == "EMA"
    assert isinstance(row.b, N.Call) and row.b.name == "EMA"
    # spans: operand-start .. operand-end (unlike the fn form's fn.start..close.end)
    assert (row.start, row.end) == (0, 17)


def test_lone_infix_cross_below():
    row = parse("candle.close x< EMA(9)")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossBelow"


def test_function_form_unchanged():
    row = parse("crossAbove(EMA(9), EMA(50))")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossAbove"
    assert (row.start, row.end) == (0, 27)


def test_mixed_chain_cross_first():
    row = parse("EMA(9) x> EMA(50) > EMA(200)")
    assert isinstance(row, N.Chain)
    assert [type(p) for p in row.parts] == [N.Cross, N.Compare]
    # middle operand is shared: cross.b is compare.left
    assert row.parts[0].b is row.parts[1].left


def test_mixed_chain_cross_last():
    row = parse("EMA(9) > EMA(50) x> EMA(200)")
    assert isinstance(row, N.Chain)
    assert [type(p) for p in row.parts] == [N.Compare, N.Cross]
    assert row.parts[0].right is row.parts[1].a


def test_multiple_crosses_rejected():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x> EMA(50) x> EMA(200)")
    assert exc.value.code == "multiple_crosses"
    # span of the second cross part: its left operand start .. right operand end
    assert (exc.value.start, exc.value.end) == (10, 29)


def test_infix_cross_inside_count():
    row = parse("count(EMA(9) x> EMA(50), 10) >= 2")
    assert isinstance(row, N.Compare)
    cnt = row.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Cross)
    assert cnt.cond.fn == "crossAbove"


def test_nested_infix_cross_is_cross_not_toplevel():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) > (EMA(9) x> EMA(50))")
    assert exc.value.code == "cross_not_toplevel"
    # span of the offending x> token
    assert (exc.value.start, exc.value.end) == (17, 19)


def test_spaced_x_is_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x > EMA(50)")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_uppercase_x_is_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("X> EMA(9)")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (0, 1)


def test_part_operands_accessor():
    row = parse("EMA(9) x> EMA(50) > EMA(200)")
    l0, r0 = N.part_operands(row.parts[0])
    l1, r1 = N.part_operands(row.parts[1])
    assert (l0, r0) == (row.parts[0].a, row.parts[0].b)
    assert (l1, r1) == (row.parts[1].left, row.parts[1].right)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_parser_infix_cross.py -q`
Expected: FAIL — `expected_operator` raised where crosses should parse; `part_operands` missing.

- [ ] **Step 3: Implement nodes.py**

In `backend/auto_trader/strategy/expr/nodes.py`, change `Chain`:

```python
@dataclass(frozen=True, slots=True)
class Chain:
    parts: list["Compare | Cross"]
    start: int
    end: int
```

Append at the end of the file (after `contains_bars_since_entry`):

```python
def part_operands(part: "Compare | Cross") -> "tuple[Node, Node]":
    """A chain part's (left, right) operands regardless of its shape."""
    if isinstance(part, Cross):
        return part.a, part.b
    return part.left, part.right
```

(`contains_tf` / `contains_bars_since_entry` need no change — their `Chain` branches recurse per part and both already handle `Cross`.)

- [ ] **Step 4: Implement parser.py**

Add near the top of `backend/auto_trader/strategy/expr/parser.py` (module level, after imports):

```python
_CMP_SYM = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<="}
_CROSS_SYM = {"XGT": "crossAbove", "XLT": "crossBelow"}
_ROW_OPS = ("GT", "LT", "GE", "LE", "XGT", "XLT")
_BAD_CROSS_MSG = "Write the cross operator as x> or x< — lowercase, no space."
```

Replace `expect`:

```python
    def expect(self, type_: str) -> Token:
        t = self.peek()
        if t.type != type_:
            if t.type in _CROSS_SYM:
                raise ExprError("cross_not_toplevel", "A comparison or cross can only be the whole row.", t.start, t.end)
            raise ExprError("unexpected_token", f"Expected {type_.lower()} here.", t.start, t.end)
        return self.next()
```

Replace `parse_row` from `left = self.parse_arith()` down (the cross-fn head stays as is):

```python
        left = self.parse_arith()
        op = self.peek()
        if isinstance(left, N.Predicate) and op.type == "EOF":
            self.next()
            return left
        if op.type not in _ROW_OPS:
            if op.type == "NAME" and op.value in ("x", "X"):
                raise ExprError("bad_cross_op", _BAD_CROSS_MSG, op.start, op.end)
            raise ExprError("expected_operator", "Expected a comparison operator (> < >= <= x> x<).", op.start, op.end)
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
        self.expect("EOF")
        crosses = [p for p in parts if isinstance(p, N.Cross)]
        if len(crosses) > 1:
            raise ExprError("multiple_crosses", "Only one cross per row.", crosses[1].start, crosses[1].end)
        if len(parts) == 1:
            return parts[0]
        return N.Chain(parts, parts[0].start, parts[-1].end)
```

(Delete the old local `sym_of` dict — `_CMP_SYM` replaces it here and in `parse_condition`.)

In `parse_condition`, after `left = self.parse_arith()` / `op = self.peek()`, insert the infix branch before the existing not-an-op check, and use the module dicts:

```python
        left = self.parse_arith()
        op = self.peek()
        if op.type in _CROSS_SYM:
            self.next()
            right = self.parse_arith()
            return N.Cross(_CROSS_SYM[op.type], left, right, left.start, right.end)
        if op.type not in ("GT", "LT", "GE", "LE"):
            if isinstance(left, N.Predicate):
                return left
            raise ExprError(
                "count_needs_condition",
                "count's first argument must be a condition, like candle.open > candle.close.",
                left.start, left.end,
            )
        optok = self.next()
        right = self.parse_arith()
        return N.Compare(_CMP_SYM[optok.type], left, right, left.start, right.end)
```

In `parse_primary`, immediately before the bare-name fallthrough `return N.Call(name.value, [], name.start, name.end)`:

```python
            if name.value in ("x", "X"):
                raise ExprError("bad_cross_op", _BAD_CROSS_MSG, name.start, name.end)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_parser_infix_cross.py tests/test_expr_parser.py tests/test_expr_parser_chain.py tests/test_expr_parser_corpus.py -q`
Expected: all PASS (existing corpus has no `x` expressions; `expected_operator` cases assert code+span, not message).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/expr/nodes.py backend/auto_trader/strategy/expr/parser.py backend/tests/test_expr_parser_infix_cross.py
git commit -m "feat(expr): parse infix cross operators x> / x< (one per row)"
```

---

### Task 3: Backend consumers — Cross parts inside Chain (validate, literals, evaluate)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/validate.py:10-14` (Chain branch)
- Modify: `backend/auto_trader/strategy/expr/literals.py` (Chain branch of `literals`, new `_collect_part_side`)
- Modify: `backend/auto_trader/strategy/expr/evaluate.py:389-390` (Chain evaluate) and `:448-457` (`compile_row` Chain dedup)
- Test: `backend/tests/test_expr_infix_cross_semantics.py` (create)

**Interfaces:**
- Consumes: `N.part_operands` from Task 2; `_match_at` (evaluate.py:338) which already dispatches `Compare | Cross | Predicate` at a bar index.
- Produces: chains containing one `Cross` part validate, evaluate, report literals, warm up, and produce closeness. No signature changes.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_expr_infix_cross_semantics.py`:

```python
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import Norm, row_closeness
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _candles(closes, resolution_s=3600):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=base + timedelta(seconds=resolution_s * k),
               open=c, high=c, low=c, close=c, volume=100.0)
        for k, c in enumerate(closes)
    ]


def _row_bools(src, candles, resolution="HOUR"):
    row = compile_row(parse(src), candles, resolution, {})
    return [row.evaluate(i, None) for i in range(len(candles))]


def test_lone_infix_cross_matches_function_form():
    c = _candles([1, 2, 3, 2, 1])
    infix = _row_bools("candle.close x> 2", c)
    fn = _row_bools("crossAbove(candle.close, 2)", c)
    assert infix == fn == [False, False, True, False, False]


def test_infix_cross_below_matches_function_form():
    c = _candles([3, 2, 1, 2, 3])
    infix = _row_bools("candle.close x< 2", c)
    fn = _row_bools("crossBelow(candle.close, 2)", c)
    assert infix == fn == [False, False, True, False, False]


def test_mixed_chain_is_conjunction():
    # close x> 2  AND  2 > candle.open - 10 (always true) -> same as lone cross
    c = _candles([1, 2, 3, 2, 1])
    assert _row_bools("candle.close x> 2 > candle.open - 10", c) == [False, False, True, False, False]
    # AND with an always-false tail kills every bar
    assert _row_bools("candle.close x> 2 > candle.open + 10", c) == [False] * 5


def test_chain_cross_shares_middle_operand():
    # cross fires at bar 2 (1->3 through 2); right comparison 2 > close is
    # False exactly at bar 2 (close=3), so the row never fires.
    c = _candles([1, 2, 3, 2, 1])
    assert _row_bools("candle.close x> 2 > candle.close - 1", c) == [False, False, False, False, False]


def test_infix_count_matches_function_form():
    c = _candles([1, 3, 1, 3, 1, 3])
    infix = _row_bools("count(candle.close x> 2, 4) >= 2", c)
    fn = _row_bools("count(crossAbove(candle.close, 2), 4) >= 2", c)
    assert infix == fn


def test_validate_accepts_cross_in_chain():
    validate(parse("EMA(9) x> EMA(50) > EMA(200)"), is_exit=False)  # no raise


def test_warmup_covers_cross_part():
    assert warmup_bars(parse("EMA(9) x> EMA(50) > EMA(200)")) == 200
    assert warmup_bars(parse("EMA(9) x> EMA(50)")) == 50


def test_literals_mixed_chain():
    lits = literals(parse("EMA(9) x> EMA(50) > EMA(200)"))
    assert [(l.ordinal, l.value, l.label) for l in lits] == [
        (0, 9.0, "EMA length"), (1, 50.0, "EMA length"), (2, 200.0, "EMA length"),
    ]


def test_literals_cross_part_bare_number_is_constant():
    # cross part numerics label "constant" (top-level Cross rule);
    # compare part numerics label "threshold".
    lits = literals(parse("candle.close x> 5 > candle.open - 3"))
    assert [(l.value, l.label) for l in lits] == [(5.0, "constant"), (3.0, "threshold")]


def test_closeness_chain_with_cross_part_defined():
    c = _candles([1, 2, 3, 2, 1, 2, 3, 2, 1, 2])
    norm = Norm(basis="volatility", width=1.0, window=5, atr_length=14)
    out = row_closeness(parse("candle.close x> 2 > candle.open - 10"), c, "HOUR", {}, norm)
    assert len(out) == len(c)
    assert any(v is not None for v in out)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_infix_cross_semantics.py -q`
Expected: chain tests FAIL — `evaluate`'s `_cmp` hits `AttributeError` on a `Cross` part (`.op`), `literals`/`validate` hit `.left` on `Cross`. Lone-cross tests PASS already.

- [ ] **Step 3: Implement validate.py**

Replace the `Chain` branch at the top of `validate` (validate.py:10-14):

```python
    if isinstance(node, N.Chain):
        for p in node.parts:
            left, right = N.part_operands(p)
            _walk(left, is_exit=is_exit)
            _walk(right, is_exit=is_exit)
        return
```

- [ ] **Step 4: Implement literals.py**

Add below `_collect_side`:

```python
def _collect_part_side(part: "N.Compare | N.Cross", side: N.Node, out: list[tuple[N.Num, str]]) -> None:
    # A cross part's numerics follow the top-level Cross rule ("constant");
    # a compare part's follow the threshold rule.
    if isinstance(part, N.Cross):
        _collect(side, "constant", out)
    else:
        _collect_side(side, out)
```

Replace the `Chain` branch inside `literals`:

```python
    if isinstance(node, N.Chain):
        first = node.parts[0]
        _collect_part_side(first, N.part_operands(first)[0], out)
        for p in node.parts:
            _collect_part_side(p, N.part_operands(p)[1], out)
```

Both edits need `part_operands` — it is already reachable as `N.part_operands` (the module imports `nodes as N`).

- [ ] **Step 5: Implement evaluate.py**

At evaluate.py:389-390, route chain parts through the existing per-bar condition dispatcher (it already handles `Cross`):

```python
        if isinstance(node, N.Chain):
            return all(self._match_at(p, i, entry_price, entry_i) for p in node.parts)
```

In `compile_row`'s Chain branch (evaluate.py:448-457), swap the tuple source:

```python
        for p in node.parts:
            for operand in N.part_operands(p):
                if id(operand) not in seen:
                    seen.add(id(operand))
                    subs.append(operand)
```

(`warmup.py` and `closeness.py` need no edits: their Chain branches recurse per part and already handle `Cross`.)

- [ ] **Step 6: Run the backend expr suite**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_infix_cross_semantics.py tests/test_expr_evaluate.py tests/test_expr_validate.py tests/test_expr_warmup.py tests/test_expr_closeness.py tests/test_expr_parser_chain.py tests/test_api_expr.py -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/strategy/expr/validate.py backend/auto_trader/strategy/expr/literals.py backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_infix_cross_semantics.py
git commit -m "feat(expr): evaluate, validate, and label Cross parts inside chains"
```

---

### Task 4: Frontend parser mirror (`parser.ts`)

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts` — lexer branch (~line 156), `ChainNode` (line 89), `expect` (~199), `parseRow` (~207), `parseCondition` (~326), `parsePrimary` fallthrough (~320), `validate` Chain branch (~408), `literalsOf` Chain branch (~756)
- Test: `frontend/src/lib/expr/parser.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new — mirrors Tasks 1–3 in TypeScript.
- Produces: `analyze(src)` handles infix crosses with the same AST shapes, error codes, spans, and literal labels as the backend; tokens of type `XGT`/`XLT` appear in `AnalyzeResult.tokens` (Task 5's highlighter consumes them). `warmupOf` needs no edit (its `Chain` case maps `warmupNode` per part and has a `Cross` case).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/expr/parser.test.ts` (match the file's existing `describe`/`it` style; `analyze` and `warmupOf` are already imported there):

```typescript
describe("infix cross operators", () => {
  it("parses a lone x> row with backend-identical literals", () => {
    const { error, literals } = analyze("EMA(9) x> EMA(50)");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.ordinal, l.value, l.from, l.to, l.label])).toEqual([
      [0, 9, 4, 5, "EMA length"],
      [1, 50, 14, 16, "EMA length"],
    ]);
  });

  it("emits XGT/XLT tokens for the highlighter", () => {
    const { tokens } = analyze("EMA(9) x> EMA(50)");
    expect(tokens.some((t) => t.type === "XGT" && t.from === 7 && t.to === 9)).toBe(true);
    expect(analyze("a x< b").tokens.some((t) => t.type === "XLT")).toBe(true);
  });

  it("accepts one cross inside a chain", () => {
    expect(analyze("EMA(9) x> EMA(50) > EMA(200)").error).toBeNull();
    expect(analyze("EMA(9) > EMA(50) x> EMA(200)").error).toBeNull();
  });

  it("rejects two crosses in a row", () => {
    const { error } = analyze("EMA(9) x> EMA(50) x> EMA(200)");
    expect(error?.code).toBe("multiple_crosses");
    expect([error?.from, error?.to]).toEqual([10, 29]);
  });

  it("rejects a nested infix cross as cross_not_toplevel", () => {
    const { error } = analyze("EMA(9) > (EMA(9) x> EMA(50))");
    expect(error?.code).toBe("cross_not_toplevel");
    expect([error?.from, error?.to]).toEqual([17, 19]);
  });

  it("flags spaced and uppercase x as bad_cross_op", () => {
    const spaced = analyze("EMA(9) x > EMA(50)");
    expect(spaced.error?.code).toBe("bad_cross_op");
    expect([spaced.error?.from, spaced.error?.to]).toEqual([7, 8]);
    const upper = analyze("X> EMA(9)");
    expect(upper.error?.code).toBe("bad_cross_op");
    expect([upper.error?.from, upper.error?.to]).toEqual([0, 1]);
  });

  it("accepts x> inside count()", () => {
    expect(analyze("count(EMA(9) x> EMA(50), 10) >= 2").error).toBeNull();
  });

  it("warms up across a cross part in a chain", () => {
    expect(warmupOf("EMA(9) x> EMA(50) > EMA(200)")).toBe(200);
    expect(warmupOf("EMA(9) x> EMA(50)")).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test:unit -- --run src/lib/expr/parser.test.ts`
Expected: FAIL — `expected_operator` where crosses should parse.

- [ ] **Step 3: Implement — mirror each backend edit**

All in `frontend/src/lib/expr/parser.ts`:

**(a) Lexer** — replace the identifier branch:

```typescript
    if (isAlpha(c) || c === "_") {
      let j = i;
      while (j < n && (isAlnum(src[j]) || src[j] === "_")) j += 1;
      const word = src.slice(i, j);
      // A bare "x" fused to a comparison bracket is the infix cross
      // operator: x> (crosses above) / x< (crosses below).
      if (word === "x" && j < n && (src[j] === ">" || src[j] === "<")) {
        out.push({ type: src[j] === ">" ? "XGT" : "XLT", value: src.slice(i, j + 1), start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
      out.push({ type: "NAME", value: word, start: i, end: j });
      i = j;
      continue;
    }
```

**(b) Node type** (line 89):

```typescript
interface ChainNode { kind: "Chain"; parts: Array<CompareNode | CrossNode>; start: number; end: number; }
```

**(c) Module constants** — next to the existing `CMP_TYPES`:

```typescript
const CROSS_OF: Record<string, string> = { XGT: "crossAbove", XLT: "crossBelow" };
const ROW_OP_TYPES = new Set(["GT", "LT", "GE", "LE", "XGT", "XLT"]);
const BAD_CROSS_MSG = "Write the cross operator as x> or x< — lowercase, no space.";
```

**(d) Part accessor** — near `containsTf`:

```typescript
function partOperands(p: CompareNode | CrossNode): [Node, Node] {
  return p.kind === "Cross" ? [p.a, p.b] : [p.left, p.right];
}
```

**(e) `expect`**:

```typescript
  private expect(type: string): LexToken {
    const t = this.peek();
    if (t.type !== type) {
      if (t.type === "XGT" || t.type === "XLT") {
        throw new ExprErr("cross_not_toplevel", "A comparison or cross can only be the whole row.", t.start, t.end);
      }
      throw new ExprErr("unexpected_token", `Expected ${type.toLowerCase()} here.`, t.start, t.end);
    }
    return this.next();
  }
```

**(f) `parseRow`** — from `const left = this.parseArith();` down (the cross-fn head stays):

```typescript
    const left = this.parseArith();
    const op = this.peek();
    if (left.kind === "Predicate" && op.type === "EOF") {
      this.next();
      return left;
    }
    if (!ROW_OP_TYPES.has(op.type)) {
      if (op.type === "NAME" && (op.value === "x" || op.value === "X")) {
        throw new ExprErr("bad_cross_op", BAD_CROSS_MSG, op.start, op.end);
      }
      throw new ExprErr("expected_operator", "Expected a comparison operator (> < >= <= x> x<).", op.start, op.end);
    }
    const symOf: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=" };
    const parts: Array<CompareNode | CrossNode> = [];
    let operand: Node = left;
    while (ROW_OP_TYPES.has(this.peek().type)) {
      const optok = this.next();
      const right = this.parseArith();
      if (optok.type in CROSS_OF) {
        parts.push({ kind: "Cross", fn: CROSS_OF[optok.type], a: operand, b: right, start: operand.start, end: right.end });
      } else {
        parts.push({ kind: "Compare", op: symOf[optok.type], left: operand, right, start: operand.start, end: right.end });
      }
      operand = right;
    }
    this.expect("EOF");
    const crosses = parts.filter((p) => p.kind === "Cross");
    if (crosses.length > 1) {
      throw new ExprErr("multiple_crosses", "Only one cross per row.", crosses[1].start, crosses[1].end);
    }
    if (parts.length === 1) return parts[0];
    return { kind: "Chain", parts, start: parts[0].start, end: parts[parts.length - 1].end };
```

**(g) `parseCondition`** — insert the infix branch after `const op = this.peek();`:

```typescript
    if (op.type === "XGT" || op.type === "XLT") {
      this.next();
      const right = this.parseArith();
      return { kind: "Cross", fn: CROSS_OF[op.type], a: left, b: right, start: left.start, end: right.end };
    }
```

**(h) `parsePrimary`** — immediately before the zero-arg-Call fallthrough (`return { kind: "Call", name: name.value, args: [], ... }`):

```typescript
      if (name.value === "x" || name.value === "X") {
        throw new ExprErr("bad_cross_op", BAD_CROSS_MSG, name.start, name.end);
      }
```

**(i) `validate` Chain branch** (~line 408):

```typescript
  if (node.kind === "Chain") {
    for (const p of node.parts) {
      const [left, right] = partOperands(p);
      walk(left, isExit);
      walk(right, isExit);
    }
    return;
  }
```

**(j) `literalsOf` Chain branch** (~line 756), plus a sibling helper next to `collectSide`:

```typescript
function collectPartSide(part: CompareNode | CrossNode, side: Node, out: Collected[]): void {
  // A cross part's numerics follow the top-level Cross rule ("constant");
  // a compare part's follow the threshold rule.
  if (part.kind === "Cross") collect(side, "constant", out);
  else collectSide(side, out);
}
```

```typescript
  if (node.kind === "Chain") {
    const first = node.parts[0];
    collectPartSide(first, partOperands(first)[0], out);
    for (const p of node.parts) collectPartSide(p, partOperands(p)[1], out);
  } else if (node.kind === "Compare") {
```

(`warmupNode`'s Chain case already recurses per part and has a Cross case — no edit.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test:unit -- --run src/lib/expr/parser.test.ts src/lib/expr/corpus.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): mirror infix cross operators in the frontend parser"
```

---

### Task 5: Editor surfaces — highlight, catalog, completion

**Files:**
- Modify: `frontend/src/lib/expr/catalog.ts` (add `CROSS_OPS` next to `CROSSES`)
- Modify: `frontend/src/lib/expr/highlight.ts` (`classify`)
- Modify: `frontend/src/lib/expr/complete.ts` (`WORD_CANDIDATES`)
- Test: `frontend/src/lib/expr/complete.test.ts` (extend)

**Interfaces:**
- Consumes: `XGT`/`XLT` tokens from Task 4's `analyze`.
- Produces: `CROSS_OPS: CatalogEntry[]` exported from catalog.ts; `x>`/`x<` completions that insert `x> EMA(50)` with `EMA(50)` selected for overtype; `cm-tok-cross` highlighting on the operators.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/expr/complete.test.ts` (it already imports `completionsFor`):

```typescript
describe("infix cross completions", () => {
  it("offers x> and x< on the x prefix, ranked first", () => {
    const opts = completionsFor("EMA(9) x", 8);
    const labels = opts.map((o) => o.label);
    // prefix rank 3 beats everything; localeCompare tie-break puts x< first
    expect(labels[0]).toBe("x<");
    expect(labels[1]).toBe("x>");
  });

  it("keeps the infix operators in the bare-word candidate set", () => {
    const labels = completionsFor("", 0).map((o) => o.label);
    expect(labels).toContain("x>");
    expect(labels).toContain("crossAbove");
  });
});
```

(`x<` sorts before `x>` at equal rank: the tie-break is `localeCompare`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test:unit -- --run src/lib/expr/complete.test.ts`
Expected: FAIL — no `x>` candidate exists.

- [ ] **Step 3: Implement**

**catalog.ts** — directly below the `CROSSES` array:

```typescript
// Infix spellings of the cross conditions — the preferred form; the function
// forms above keep working.
export const CROSS_OPS: CatalogEntry[] = [
  { name: "x>", insert: "x> EMA(50)", signature: "a x> b", detail: "a crosses above b" },
  { name: "x<", insert: "x< EMA(50)", signature: "a x< b", detail: "a crosses below b" },
];
```

**complete.ts** — add `CROSS_OPS` to the catalog import, then in `WORD_CANDIDATES` insert ABOVE the `...CROSSES.map(...)` line:

```typescript
  ...CROSS_OPS.map((e): WordCandidate => ({
    label: e.name,
    type: "cross",
    detail: e.detail,
    insert: e.insert,
    // Select the placeholder operand ("EMA(50)") for overtype, like fn args.
    argFrom: 3,
    argTo: e.insert.length,
  })),
```

(`fnCandidate` is paren-based and would find no `(` at top level to anchor on — these literal `argFrom`/`argTo` values replace it for infix inserts.)

**highlight.ts** — in `classify`, add before the `OPERATOR_TYPES` check:

```typescript
  if (tok.type === "XGT" || tok.type === "XLT") return "cross";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test:unit -- --run src/lib/expr/complete.test.ts src/lib/expr/parser.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/complete.ts frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/complete.test.ts
git commit -m "feat(expr): offer, complete, and highlight infix cross operators"
```

---

### Task 6: Default rules switch to the infix form

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts:196-206` (`defaultBacktestConfig`)
- Modify: `frontend/src/lib/backtestConfig.test.ts` (expectations on default rule strings)
- Modify: `frontend/src/BacktestSettingsModal.test.tsx` (expectations on default rule strings)

**Interfaces:**
- Consumes: infix parsing from Task 4 (defaults must lint clean in the editor).
- Produces: `defaultBacktestConfig()` seeds `"EMA(9) x> EMA(21)"` / `"EMA(9) x< EMA(21)"` rule strings.

- [ ] **Step 1: Update the default builder**

In `defaultBacktestConfig` (backtestConfig.ts:196), replace the `cross` helper and its uses:

```typescript
  const cross = (op: "x>" | "x<"): RuleGroup => ({
    combine: "AND",
    rules: [{ expr: `EMA(9) ${op} EMA(21)`, enabled: true }],
  });
  return {
    range: { mode: "bars", bars: 500, history: "minimal" },
    longEntry: cross("x>"),
    longExit: cross("x<"),
    shortEntry: cross("x<"),
    shortExit: cross("x>"),
```

The direction mapping preserves today's semantics exactly: longEntry/shortExit were `crossAbove`, longExit/shortEntry were `crossBelow`.

- [ ] **Step 2: Update the tests that pin the old strings**

Run: `cd frontend && grep -n "crossAbove\|crossBelow" src/lib/backtestConfig.test.ts src/BacktestSettingsModal.test.tsx`

In each hit that asserts a DEFAULT rule string (e.g. `expect(...).toBe("crossAbove(EMA(9), EMA(21))")`), change the expected value to the matching infix string (`"EMA(9) x> EMA(21)"` for crossAbove, `"EMA(9) x< EMA(21)"` for crossBelow). Leave hits alone that test PARSING of user-entered function-form strings — those must keep working.

- [ ] **Step 3: Run the affected suites**

Run: `cd frontend && npm run test:unit -- --run src/lib/backtestConfig.test.ts src/BacktestSettingsModal.test.tsx`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): seed default rules with infix cross operators"
```

---

### Task 7: Parity corpus + full-suite verification

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json` (append cases)

**Interfaces:**
- Consumes: everything above. `corpus.json` is read by BOTH `frontend/src/lib/expr/corpus.test.ts` and `backend/tests/test_expr_parser_corpus.py` — one edit pins both sides.

- [ ] **Step 1: Append the cases**

Append inside the top-level array of `frontend/src/lib/expr/corpus.json` (before the closing `]`; keep the file's one-case-per-entry formatting):

```json
  { "expr": "EMA(9) x> EMA(50)", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":9,"from":4,"to":5,"label":"EMA length"},
      {"ordinal":1,"value":50,"from":14,"to":16,"label":"EMA length"}
    ] },
  { "expr": "candle.close x< EMA(9)@1H", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":9,"from":20,"to":21,"label":"EMA length"}
    ] },
  { "expr": "count(EMA(9) x> EMA(50), 10) >= 2", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":9,"from":10,"to":11,"label":"EMA length"},
      {"ordinal":1,"value":50,"from":20,"to":22,"label":"EMA length"},
      {"ordinal":2,"value":10,"from":25,"to":27,"label":"count window"},
      {"ordinal":3,"value":2,"from":32,"to":33,"label":"threshold"}
    ] },
  { "expr": "EMA(9) x> EMA(50) > EMA(200)", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":9,"from":4,"to":5,"label":"EMA length"},
      {"ordinal":1,"value":50,"from":14,"to":16,"label":"EMA length"},
      {"ordinal":2,"value":200,"from":24,"to":27,"label":"EMA length"}
    ] },
  { "expr": "EMA(9) > EMA(50) x> EMA(200)", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":9,"from":4,"to":5,"label":"EMA length"},
      {"ordinal":1,"value":50,"from":13,"to":15,"label":"EMA length"},
      {"ordinal":2,"value":200,"from":24,"to":27,"label":"EMA length"}
    ] },
  { "expr": "candle.close x> 5 > candle.open - 3", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":5,"from":16,"to":17,"label":"constant"},
      {"ordinal":1,"value":3,"from":34,"to":35,"label":"threshold"}
    ] },
  { "expr": "EMA(9) x> EMA(50) x> EMA(200)", "isExit": false, "error": {"code":"multiple_crosses","from":10,"to":29}, "literals": [] },
  { "expr": "EMA(9) x > EMA(50)", "isExit": false, "error": {"code":"bad_cross_op","from":7,"to":8}, "literals": [] },
  { "expr": "X> EMA(9)", "isExit": false, "error": {"code":"bad_cross_op","from":0,"to":1}, "literals": [] },
  { "expr": "EMA(9) > (EMA(9) x> EMA(50))", "isExit": false, "error": {"code":"cross_not_toplevel","from":17,"to":19}, "literals": [] },
  { "expr": "50x> 60", "isExit": false, "error": {"code":"unknown_name","from":0,"to":3}, "literals": [] }
```

The spans were computed by hand; the two corpus tests are the check — if either side disagrees, trust the test output and fix the corpus numbers (or find the real off-by-one in the code).

- [ ] **Step 2: Run both corpus tests**

Run: `cd backend && ../.venv/bin/pytest tests/test_expr_parser_corpus.py -q`
Run: `cd frontend && npm run test:unit -- --run src/lib/expr/corpus.test.ts`
Expected: both PASS with the identical corpus.

- [ ] **Step 3: Full-suite verification**

Run: `cd backend && ../.venv/bin/pytest -q`
Run: `cd frontend && npm run test:unit -- --run`
Expected: all PASS. (If unrelated failures appear from other sessions' in-flight edits — e.g. `test_indicator_ref_parse.py` — report them but do not touch those files.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/expr/corpus.json
git commit -m "test(expr): pin infix cross operators in the parity corpus"
```
