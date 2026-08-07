# Equality Operator (`==`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `==` as a fourth comparison operator to the expression rule engine, so `count(cond, window) == n` ("exactly n of the last window bars") becomes expressible.

**Architecture:** The engine is a hand-written lexer + recursive-descent parser in Python (`backend/auto_trader/strategy/expr/`) with a byte-compatible TypeScript mirror (`frontend/src/lib/expr/`) used by the CodeMirror editor for lint and highlight. `==` becomes a new `EQ` token flowing into the existing `Compare` node; no new node kind, no new precedence level. Evaluation, the proximity heatmap, and the editor's three separate operator lists each need the new op added.

**Tech Stack:** Python 3 + pytest (backend), TypeScript + Vitest + CodeMirror/Lezer (frontend).

**Spec:** `docs/superpowers/specs/2026-08-07-equality-operator-design.md`

## Global Constraints

- **Token name:** `EQ`. **Symbol string stored on `Compare.op`:** `"=="`.
- **Bare `=` is an error, never a synonym for `==`.** Error code `bad_eq_op`, message exactly `Use == for equality.`, span the single `=` character.
- **`expected_operator` copy** becomes exactly `Expected a comparison operator (> < >= <= == x> x<).` in BOTH stacks. The string must match byte-for-byte across Python and TypeScript.
- **`!=` is out of scope.** Do not add it.
- **`x==` is NOT a cross near-miss.** Do not add `=` to the lexer's `x`-fusion branch, and do not add `EQ` to the bare-`x` hint tuples (`parser.py:155`, `parser.ts:424`) — those are about cross-operator spelling only.
- **The Python and TypeScript lexers/parsers must stay behaviourally identical.** `frontend/src/lib/expr/corpus.json` is the shared fixture that enforces this; Task 7 is not optional.
- Run backend tests from `backend/`: `python -m pytest`. Run frontend tests from `frontend/`: `npm run test:unit`.

## Task Ordering — read this before resequencing

The evaluation and closeness changes (Tasks 2 and 3) land BEFORE the parser learns
`==` (Task 4). This is deliberate and must not be reordered for narrative tidiness.

`_cmp_vals` currently ends in a bare `return l <= r` that catches every op it does
not name, and `signed_gap` raises on unknown ops. If the parser starts emitting
`Compare("==")` first, the intermediate commit is a build that looks healthy, passes
its own tests, and silently evaluates `count(c, 5) == 3` as `count(c, 5) <= 3` while
500ing the closeness route. Landing the pure-function changes first means every
commit in the sequence is behaviourally correct on its own.

The consequence: Tasks 2 and 3 test `_cmp_vals` and `signed_gap` directly, because
`parse()` cannot yet produce an `==` node. The end-to-end tests that need `parse()`
live in Task 4.

---

### Task 1: Backend lexer — `EQ` token and the bare-`=` error

**Files:**
- Modify: `backend/auto_trader/strategy/expr/errors.py` (append a message constant)
- Modify: `backend/auto_trader/strategy/expr/lexer.py:113-127`
- Test: `backend/tests/test_expr_lexer.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: token type `EQ` with value `"=="`; `ExprError` code `bad_eq_op`; module constant `BAD_EQ_MSG` in `errors.py`. Tasks 4, 5 and 7 depend on the `EQ` token type and the exact message string.

Background: `=` is currently absent from the lexer's `_SINGLE` punctuation map, so it falls through to `bad_char`. Note that `>=` and `<=` are consumed by the earlier `if c in "<>"` branch, so a `=` reaching the new branch is either the start of `==` or a lone `=`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_expr_lexer.py`:

```python
def test_tokenizes_equality_with_spans():
    assert _types("count(candle.close > candle.open, 5) == 3")[-4:] == [
        ("RPAREN", ")", 35, 36),
        ("EQ", "==", 37, 39),
        ("NUMBER", "3", 40, 41),
        ("EOF", "", 41, 41),
    ]


def test_bare_equals_is_a_targeted_error_not_bad_char():
    with pytest.raises(ExprError) as exc:
        tokenize("EMA(9) = 1")
    assert exc.value.code == "bad_eq_op"
    assert exc.value.message == "Use == for equality."
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_trailing_bare_equals_reports_at_the_equals():
    with pytest.raises(ExprError) as exc:
        tokenize("EMA(9) =")
    assert exc.value.code == "bad_eq_op"
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_ge_and_le_still_lex_as_before():
    # The new "=" branch must not intercept the second character of >= or <=.
    assert [t.type for t in tokenize("1 >= 2")] == ["NUMBER", "GE", "NUMBER", "EOF"]
    assert [t.type for t in tokenize("1 <= 2")] == ["NUMBER", "LE", "NUMBER", "EOF"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_expr_lexer.py -v`
Expected: the three new `==`/`=` tests FAIL (`bad_char` raised instead of `bad_eq_op`, and no `EQ` token). `test_ge_and_le_still_lex_as_before` should already PASS — it is a regression guard for Step 3.

- [ ] **Step 3: Add the message constant**

Append to `backend/auto_trader/strategy/expr/errors.py`, below `BAD_CROSS_MSG`:

```python
# A "=" has no other role in this grammar, so every "=" that is not part of "=="
# is a mistyped equality. Kept here rather than in parser.py for the same reason
# as BAD_CROSS_MSG: lexer.py cannot import from parser.py.
BAD_EQ_MSG = "Use == for equality."
```

- [ ] **Step 4: Add the lexer branch**

In `backend/auto_trader/strategy/expr/lexer.py`, extend the import at the top:

```python
from auto_trader.strategy.expr.errors import BAD_CROSS_MSG, BAD_EQ_MSG, ExprError
```

Then insert this block immediately AFTER the existing `if c in "<>":` block (which ends with its `continue`) and BEFORE `if c in _SINGLE:`:

```python
        if c == "=":
            # ">=" and "<=" are consumed by the "<>" branch above, so a "=" here
            # is either "==" or a lone "=" — and a lone "=" is always a mistyped
            # equality, never anything else in this grammar.
            if i + 1 < n and src[i + 1] == "=":
                out.append(Token("EQ", "==", i, i + 2))
                i += 2
                continue
            raise ExprError("bad_eq_op", BAD_EQ_MSG, i, i + 1)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_lexer.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full expr test suite for regressions**

Run: `cd backend && python -m pytest tests/ -k expr -q`
Expected: PASS. (The parser does not yet know `EQ`, so `EMA(9) == 3` will now raise `expected_operator` instead of `bad_char` — that is expected and is fixed in Task 4. If an existing test asserts `bad_char` on a `=`, update it to `bad_eq_op`.)

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/strategy/expr/errors.py backend/auto_trader/strategy/expr/lexer.py backend/tests/test_expr_lexer.py
git commit -m "feat(expr): lex == as EQ, reject a bare = with targeted copy"
```

---

### Task 2: Backend evaluation — `==` semantics and closing the silent fallthrough

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py:89-98`
- Test: `backend/tests/test_expr_evaluate.py`

**Interfaces:**
- Consumes: nothing. `_cmp_vals` takes an op string; this task does not need the parser to produce one.
- Produces: `_cmp_vals(op, l, r)` handling `"=="` and raising `ValueError` on an unrecognised op. Task 4 relies on both.

**This is the highest-risk task in the plan.** `_cmp_vals` currently ends in a bare `return l <= r` that catches every op it does not explicitly name. Ship the parser change without this one and `a == b` silently evaluates as `a <= b`: wrong booleans on every bar, no exception, and every parser test still green. The fallthrough gets closed here so the next operator added cannot repeat it.

Both call sites (`evaluate.py:171` in `_cond_matches`, `evaluate.py:408` and `:413` in the compiled-row path) route through `_cmp_vals`, so this one function is the whole change.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_expr_evaluate.py`. These test `_cmp_vals` directly rather than through `parse()` — the parser does not know `==` yet, and these are the semantics the function itself owns:

```python
from auto_trader.strategy.expr.evaluate import _cmp_vals


def test_equality_holds_when_both_sides_are_defined_and_equal():
    assert _cmp_vals("==", 2.5, 2.5) is True
    assert _cmp_vals("==", 2.5, 2.6) is False


def test_equality_is_false_when_an_operand_is_undefined():
    assert _cmp_vals("==", None, 1.0) is False
    assert _cmp_vals("==", 1.0, None) is False
    # NaN is filtered by _defined, so this is False rather than IEEE's answer.
    # Deliberate: an undefined operand equals nothing. Do not "fix" this.
    assert _cmp_vals("==", float("nan"), float("nan")) is False


def test_cmp_vals_rejects_an_unknown_operator():
    # Guards the fallthrough: an op the function does not know must raise, not
    # quietly behave like "<=".
    with pytest.raises(ValueError):
        _cmp_vals("!=", 1.0, 2.0)


def test_cmp_vals_le_still_works():
    assert _cmp_vals("<=", 1.0, 2.0) is True
    assert _cmp_vals("<=", 3.0, 2.0) is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_expr_evaluate.py -v -k "equality or cmp_vals"`
Expected: FAIL. Note the shape of the failures — `_cmp_vals("==", 2.5, 2.6)` returns `True` (because `2.5 <= 2.6`) and `_cmp_vals("!=", 1.0, 2.0)` returns `True` instead of raising. That is the silent-`<=` bug this task exists to prevent, visible in miniature.

- [ ] **Step 3: Rewrite `_cmp_vals`**

Replace `backend/auto_trader/strategy/expr/evaluate.py:89-98` in full:

```python
def _cmp_vals(op: str, l: float | None, r: float | None) -> bool:
    if not (_defined(l) and _defined(r)):
        return False
    if op == ">":
        return l > r
    if op == "<":
        return l < r
    if op == ">=":
        return l >= r
    if op == "<=":
        return l <= r
    if op == "==":
        # Exact, deliberately: count(...) and barsSinceEntry are integral, and
        # "exactly n of the last m bars" is the whole point of the operator. On
        # float series == is almost never true bar to bar, and that is fine —
        # there its value is as a proximity-heatmap query (closeness.signed_gap
        # gives it -abs(l - r)), not as a firing condition. Do not add a
        # tolerance here; that would silently change what count() == n means.
        return l == r
    # No bare fallthrough: an unknown op used to be silently treated as "<=",
    # which returns plausible booleans and passes every parser-level test.
    raise ValueError(f"unsupported comparison op: {op}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_evaluate.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS. A failure with `unsupported comparison op:` means some caller passes an op spelling not in the list above — investigate rather than restoring the fallthrough.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_evaluate.py
git commit -m "feat(expr): evaluate ==, and raise instead of falling through to <="
```

---

### Task 3: Backend closeness — a signed gap for `==`

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py:22-30`
- Test: `backend/tests/test_expr_closeness.py:20-29`

**Interfaces:**
- Consumes: nothing. `signed_gap` takes an op string directly.
- Produces: `signed_gap("==", l, r) == -abs(l - r)`. Task 4 exercises it through a parsed row.

Background: `signed_gap` raises `ValueError` on any op it does not know, and `row_gap_series` calls it for every `Compare`. Without this task an `==` rule returns a 500 from the closeness route (`backend/auto_trader/api/routers/expr.py`) — a ship blocker, not polish. The convention is "gap >= 0 means the comparison holds", and `-abs(l - r)` satisfies it exactly (zero when equal, negative otherwise). This is the same non-positive symmetric form `row_gap_series` already uses for `Cross` at lines 105-112; do not invent a different one.

- [ ] **Step 1: Write the failing test**

Extend `test_signed_gap_orientation` in `backend/tests/test_expr_closeness.py`:

```python
def test_signed_gap_orientation():
    # ">": fires when left > right, so gap = left - right
    assert signed_gap(">", 101, 100) == 1
    assert signed_gap(">=", 100, 100) == 0
    # "<": fires when left < right, so gap = right - left
    assert signed_gap("<", 99, 100) == 1
    assert signed_gap("<=", 100, 100) == 0
    # "==": symmetric, zero exactly when equal and negative either side of it,
    # so ramp() warms toward 1 as the operands converge (same shape as Cross).
    assert signed_gap("==", 100, 100) == 0
    assert signed_gap("==", 101, 100) == -1
    assert signed_gap("==", 99, 100) == -1
    # any None -> None
    assert signed_gap(">", None, 100) is None
    assert signed_gap(">", 100, None) is None
    assert signed_gap("==", None, 100) is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_closeness.py::test_signed_gap_orientation -v`
Expected: FAIL with `ValueError: unsupported comparison op: ==`.

- [ ] **Step 3: Add the `==` branch**

In `backend/auto_trader/strategy/expr/closeness.py`, replace `signed_gap`'s op dispatch:

```python
def signed_gap(op: str, left: float | None, right: float | None) -> float | None:
    """Gap oriented so >= 0 means the comparison holds."""
    if not (_defined(left) and _defined(right)):
        return None
    if op in (">", ">="):
        return left - right
    if op in ("<", "<="):
        return right - left
    if op == "==":
        # Symmetric and non-positive: 0 exactly when the operands are equal,
        # falling away on both sides, so ramp() warms toward 1 as they converge.
        # Same form row_gap_series uses for Cross (distance to touching).
        return -abs(left - right)
    raise ValueError(f"unsupported comparison op: {op}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_closeness.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(expr): give == a signed gap so the proximity heatmap accepts it"
```

---

### Task 4: Backend parser — accept `EQ` everywhere a comparison is accepted

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py:8-10, 62-63, 177`
- Test: `backend/tests/test_expr_parser.py`, `backend/tests/test_expr_parser_chain.py`, `backend/tests/test_expr_evaluate.py`, `backend/tests/test_expr_closeness.py`

**Interfaces:**
- Consumes: token type `EQ` from Task 1; `_cmp_vals` and `signed_gap` handling `"=="` from Tasks 2 and 3.
- Produces: `N.Compare` nodes with `op == "=="`, reachable both as a top-level row operator and as `count`'s condition operator. This task completes the backend feature.

Background: the operator set is currently spelled out in two independent places that both need `EQ` — `_ROW_OPS` (top-level rows) and a hard-coded tuple inside `parse_condition` (`count`'s first argument). Introducing a shared `_CMP_OPS` prevents the two from drifting. Do NOT touch the bare-`x` hint at line 155; its `("GT", "LT")` tuple is about cross-operator spelling.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_expr_parser.py`:

```python
def test_equality_at_top_level():
    top = parse("count(candle.close > candle.open, 5) == 3")
    assert isinstance(top, N.Compare) and top.op == "=="
    assert isinstance(top.left, N.Count)
    assert isinstance(top.right, N.Number) and top.right.value == 3


def test_equality_inside_count_condition():
    # The other reading of "count needs equality": equality as the counted condition.
    top = parse("count(EMA(9) == EMA(21), 20) > 0")
    assert isinstance(top.left, N.Count)
    assert isinstance(top.left.cond, N.Compare) and top.left.cond.op == "=="


def test_expected_operator_copy_lists_equality():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) EMA(21)")
    assert exc.value.code == "expected_operator"
    assert exc.value.message == "Expected a comparison operator (> < >= <= == x> x<)."
```

Add to `backend/tests/test_expr_parser_chain.py`:

```python
def test_chain_mixing_equality_and_inequality():
    node = parse("count(candle.close > candle.open, 5) == 3 > 1")
    assert isinstance(node, N.Chain)
    assert [p.op for p in node.parts] == ["==", ">"]
```

Note on `N.Number`: confirm the numeric literal node's class name and value attribute in `backend/auto_trader/strategy/expr/nodes.py` before running; if it differs, use the actual name in the assertion.

Now the end-to-end tests that Tasks 2 and 3 could not write, because `parse()` could not yet produce an `==` node. Add to `backend/tests/test_expr_evaluate.py`:

```python
def test_count_equality_fires_only_on_the_exact_count():
    # _bars takes (open, close) pairs; a bar is bullish when close > open.
    # bullish:  T       T       F       F       T
    c = _bars([(1, 2), (2, 3), (3, 2), (2, 1), (1, 2)])
    # count over the last 3 bars is undefined until the window fits (bars 0-1),
    # then: bar2 -> 2, bar3 -> 1, bar4 -> 1. So "== 2" fires on bar 2 alone.
    assert _row_bools("count(candle.close > candle.open, 3) == 2", c) == [
        False, False, True, False, False,
    ]
```

Add to `backend/tests/test_expr_closeness.py`:

```python
def test_row_gap_series_handles_an_equality_row():
    # Regression guard for the closeness route: an == rule must not raise.
    c = _candles([1, 2, 3])
    gaps = row_gap_series(parse("candle.close == 2"), c, "HOUR", {})
    assert gaps == [-1.0, 0.0, -1.0]
```

`test_expr_closeness.py` may not define a `_candles` helper; if it does not, copy the one from `backend/tests/test_expr_evaluate.py` (it builds `Candle`s with `open == high == low == close`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_expr_parser.py tests/test_expr_parser_chain.py tests/test_expr_evaluate.py tests/test_expr_closeness.py -v`
Expected: FAIL — `expected_operator` raised for the top-level, chain, evaluate and closeness cases, `count_needs_condition` for the inner-equality case, and a copy mismatch on the message assertion. Every failure should be a parse error; if any is a wrong-boolean or a `ValueError: unsupported comparison op`, Task 2 or 3 did not land.

- [ ] **Step 3: Add the shared operator constant**

In `backend/auto_trader/strategy/expr/parser.py`, replace lines 8-10:

```python
_CMP_SYM = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<=", "EQ": "=="}
_CROSS_SYM = {"XGT": "crossAbove", "XLT": "crossBelow"}
# One source of truth for the comparison set. parse_row accepts these plus the
# cross operators; parse_condition (count's first argument) accepts these alone.
# Keeping them derived means a new operator cannot land in one and miss the
# other, which would make `a == b` legal at top level but not inside count().
_CMP_OPS = ("GT", "LT", "GE", "LE", "EQ")
_ROW_OPS = _CMP_OPS + ("XGT", "XLT")
```

- [ ] **Step 4: Update the `expected_operator` copy**

In `parse_row`, replace the message at line 63:

```python
            raise ExprError("expected_operator", "Expected a comparison operator (> < >= <= == x> x<).", op.start, op.end)
```

- [ ] **Step 5: Point `parse_condition` at the shared constant**

In `parse_condition`, replace the hard-coded tuple at line 177:

```python
        if op.type not in _CMP_OPS:
```

Leave line 155 (`if name.value in ("x", "X") and self.peek().type in ("GT", "LT")`) untouched.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_parser.py tests/test_expr_parser_chain.py tests/test_expr_evaluate.py tests/test_expr_closeness.py -v`
Expected: PASS.

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS, except any test asserting the old `expected_operator` copy — update those to the new string. Note `tests/test_api_expr.py` asserts the CODE only, so it should be unaffected. The backend is now feature-complete for `==`.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/strategy/expr/parser.py backend/tests/test_expr_parser.py backend/tests/test_expr_parser_chain.py backend/tests/test_expr_evaluate.py backend/tests/test_expr_closeness.py
git commit -m "feat(expr): parse == as a comparison, in rows and in count conditions"
```

---

### Task 5: Frontend parser mirror — `EQ` in the TypeScript lexer and parser

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts:237-252` (lexer), `:262-264`, `:311-317`, `:452-463`
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: the token name `EQ`, the symbol `"=="`, the `bad_eq_op` code and the two message strings established in Tasks 1 and 4. These MUST match the Python side byte-for-byte.
- Produces: `CompareNode` with `op: "=="` from the TypeScript parser. Task 6 consumes the `EQ` token type for highlighting; Task 7 exercises both stacks together.

This file is an explicit mirror of `lexer.py` and `parser.py`. Keep the structure and comments parallel to the Python you wrote in Tasks 1 and 4. Note the TypeScript lexer RETURNS errors (`{ tokens, error }`) where Python raises, and the parser THROWS `ExprErr`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/expr/parser.test.ts`:

```ts
it("lexes == as EQ", () => {
  const { tokens, error } = tokenizeForTest("count(candle.close > candle.open, 5) == 3");
  expect(error).toBeNull();
  expect(tokens.map((t) => [t.type, t.value])).toContainEqual(["EQ", "=="]);
});

it("rejects a bare = with the equality message", () => {
  const res = analyze("EMA(9) = 1", false);
  expect(res.error?.code).toBe("bad_eq_op");
  expect(res.error?.message).toBe("Use == for equality.");
  expect([res.error?.from, res.error?.to]).toEqual([7, 8]);
});

it("parses == at top level and inside count", () => {
  expect(analyze("count(candle.close > candle.open, 5) == 3", false).error).toBeNull();
  expect(analyze("count(EMA(9) == EMA(21), 20) > 0", false).error).toBeNull();
});

it("lists == in the expected-operator message", () => {
  const res = analyze("EMA(9) EMA(21)", false);
  expect(res.error?.code).toBe("expected_operator");
  expect(res.error?.message).toBe("Expected a comparison operator (> < >= <= == x> x<).");
});
```

Match the existing file's conventions: use whatever entry point the surrounding tests already use for tokenizing and for analysis (the token-span tests near `parser.test.ts:527-541` show the tokenize helper; the error tests near `:295` and `:482` show the analyze helper). Replace `tokenizeForTest` / `analyze` with those actual names and signatures rather than introducing new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit -- parser.test.ts`
Expected: FAIL — `bad_char` on `=`, `expected_operator` on `==`, and a copy mismatch.

- [ ] **Step 3: Add the lexer branch**

In `frontend/src/lib/expr/parser.ts`, insert immediately AFTER the `if (c === "<" || c === ">") { ... }` block and BEFORE `if (c in SINGLE)`:

```ts
    if (c === "=") {
      // ">=" and "<=" are consumed by the "<>" branch above, so a "=" here is
      // either "==" or a lone "=" — and a lone "=" is always a mistyped
      // equality, never anything else in this grammar. Mirrors lexer.py.
      if (i + 1 < n && src[i + 1] === "=") {
        out.push({ type: "EQ", value: "==", start: i, end: i + 2 });
        i += 2;
        continue;
      }
      return { tokens: out, error: new ExprErr("bad_eq_op", BAD_EQ_MSG, i, i + 1) };
    }
```

- [ ] **Step 4: Add the shared constants**

Replace `parser.ts:262-264`:

```ts
const CROSS_OF: Record<string, string> = { XGT: "crossAbove", XLT: "crossBelow" };
// One source of truth for the comparison set, mirroring parser.py's _CMP_OPS /
// _ROW_OPS: parseRow accepts these plus the crosses, parseCondition (count's
// first argument) accepts these alone. Derived so a new operator cannot land in
// one and miss the other.
const CMP_OP_TYPES = ["GT", "LT", "GE", "LE", "EQ"] as const;
const CMP_OP_TYPE_SET: ReadonlySet<string> = new Set<string>(CMP_OP_TYPES);
const ROW_OP_TYPES: ReadonlySet<string> = new Set<string>([...CMP_OP_TYPES, "XGT", "XLT"]);
const SYM_OF: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=", EQ: "==" };
const BAD_CROSS_MSG = "Write the cross operator as x> or x< — lowercase, no space.";
const BAD_EQ_MSG = "Use == for equality.";
```

- [ ] **Step 5: Use the shared constants in `parseRow`**

At `parser.ts:315`, update the copy, and delete the local `symOf` at line 317, using the module-level `SYM_OF` at line 326 instead:

```ts
      throw new ExprErr("expected_operator", "Expected a comparison operator (> < >= <= == x> x<).", op.start, op.end);
    }
    const parts: Array<CompareNode | CrossNode> = [];
```

and in the loop body:

```ts
        parts.push({ kind: "Compare", op: SYM_OF[optok.type], left: operand, right, start: operand.start, end: right.end });
```

- [ ] **Step 6: Use the shared constants in `parseCondition`**

Replace `parser.ts:452` and the local `symOf` at `:460`:

```ts
    if (!CMP_OP_TYPE_SET.has(op.type)) {
      if (left.kind === "Predicate") return left;
      throw new ExprErr(
        "count_needs_condition",
        "count's first argument must be a condition, like candle.open > candle.close.",
        left.start, left.end,
      );
    }
    const optok = this.next();
    const right = this.parseArith();
    return { kind: "Compare", op: SYM_OF[optok.type], left, right, start: left.start, end: right.end };
```

Leave `parser.ts:424` (the bare-`x` hint, `op.type === "GT" || op.type === "LT"`) untouched.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit -- parser.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and run the full frontend suite**

Run: `cd frontend && npx tsc --noEmit && npm run test:unit`
Expected: PASS. Update any existing test asserting the old `expected_operator` copy.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): mirror the == operator in the TypeScript parser"
```

---

### Task 6: Editor surfaces — Lezer grammar and syntax highlighting

**Files:**
- Modify: `frontend/src/lib/expr/grammar.lezer:68`
- Modify: `frontend/src/lib/expr/highlight.ts:30-32`
- Test: `frontend/src/lib/expr/highlight.test.ts`

**Interfaces:**
- Consumes: the `EQ` token type from Task 5.
- Produces: `==` classified as `"operator"` by `classify`, and matched by the Lezer `Operator` token rule.

These are the two operator lists no parser test covers. Miss them and `==` lints clean but renders unhighlighted in the editor — invisible to every test written so far.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/expr/highlight.test.ts`, following the classification-pair style already used there (`[">", "operator"]` at lines 14, 26, 35, 50):

```ts
it("highlights == as an operator", () => {
  expect(classifyForTest("count(candle.close > candle.open, 5) == 3"))
    .toContainEqual(["==", "operator"]);
});
```

Use the file's existing helper name and shape rather than `classifyForTest` — read the top of `highlight.test.ts` for how the other cases invoke `classify`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test:unit -- highlight.test.ts`
Expected: FAIL — `==` is either absent from the classification list or classified as something other than `"operator"`.

- [ ] **Step 3: Add `EQ` to the highlighter's operator set**

In `frontend/src/lib/expr/highlight.ts`, replace lines 30-32:

```ts
const OPERATOR_TYPES = new Set([
  "GT", "LT", "GE", "LE", "EQ", "PLUS", "MINUS", "STAR", "SLASH",
]);
```

- [ ] **Step 4: Add `==` to the Lezer token rule**

In `frontend/src/lib/expr/grammar.lezer`, replace line 68:

```
  // Comparison operators.
  Operator { ">=" | "<=" | "==" | ">" | "<" }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npm run test:unit -- highlight.test.ts`
Expected: PASS.

- [ ] **Step 6: Check whether the Lezer grammar needs regenerating**

Run: `cd frontend && grep -rn "grammar.lezer" package.json vite.config.* src/lib/expr/*.ts`
If the grammar is compiled by a build step or a `@lezer/generator` plugin, run that build and confirm it succeeds. If `grammar.lezer` is consumed directly by a Vite plugin at dev time, no extra step is needed.

Then: `cd frontend && npm run test:unit && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/expr/grammar.lezer frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/highlight.test.ts
git commit -m "feat(expr): highlight == in the rule editor"
```

---

### Task 7: Cross-stack parity corpus

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json`
- Test (no change needed, consumes the corpus): `backend/tests/test_expr_parser_corpus.py`, `frontend/src/lib/expr/corpus.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: shared fixture rows proving both lexers agree on `==` and on the bare-`=` error.

`corpus.json` is the only thing keeping the two hand-written lexers from diverging: the same rows are replayed by `test_expr_parser_corpus.py` (Python) and `corpus.test.ts` (TypeScript), and each asserts the same error code and the same character span. These rows are mandatory, not additive.

Row shape (from the existing file): `{ "expr": ..., "isExit": bool, "error": null | {"code":..., "from":..., "to":...}, "literals": [...] }`. For a passing row, `literals` must list every numeric literal the engine extracts, with `ordinal`, `value`, `from`, `to`, `label` — get these right by running the backend test and reading the diff rather than by hand-counting.

- [ ] **Step 1: Add the rows**

Append to `frontend/src/lib/expr/corpus.json` (keeping the file's existing formatting):

```json
  { "expr": "count(candle.close > candle.open, 5) == 3", "isExit": false, "error": null, "literals": [] },
  { "expr": "count(EMA(9) == EMA(21), 20) > 0", "isExit": false, "error": null, "literals": [] },
  { "expr": "EMA(9) = 1", "isExit": false, "error": {"code":"bad_eq_op","from":7,"to":8}, "literals": [] },
  { "expr": "x == 3", "isExit": false, "error": {"code":"unknown_name","from":0,"to":1}, "literals": [] },
```

The `literals` arrays and the `x == 3` error code are provisional — Steps 2-3 replace them with what the engine actually produces.

- [ ] **Step 2: Run the backend corpus test to learn the real expectations**

Run: `cd backend && python -m pytest tests/test_expr_parser_corpus.py -v`
Expected: the new rows FAIL on `literals` mismatches (the assertion prints the actual tuples) and possibly on the `x == 3` error code. Read the failures.

- [ ] **Step 3: Correct the rows from the actual output**

Rewrite the four rows using the `(ordinal, value, start, end, label)` tuples the test printed, mapped to `{"ordinal":…,"value":…,"from":…,"to":…,"label":…}`, and the actual error code and span for `x == 3`.

For `x == 3` specifically: `x` is an unknown variable here, NOT a cross-operator near-miss — that is the behaviour this row pins down. If the code that comes back is `bad_cross_op`, something in Task 4 or 5 wrongly added `EQ` to a bare-`x` hint tuple; fix the parser rather than the fixture.

- [ ] **Step 4: Run both corpus tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_parser_corpus.py -v`
Run: `cd frontend && npm run test:unit -- corpus.test.ts`
Expected: PASS on both. A code or span that agrees on one stack and not the other is a real mirror bug — fix the code, never the fixture, to make them agree.

- [ ] **Step 5: Run both full suites**

Run: `cd backend && python -m pytest -q`
Run: `cd frontend && npm run test:unit && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Manual verification in the editor**

Start the app and open the backtest settings rule editor. Type `count(candle.close > candle.open, 5) == 3` and confirm: no lint underline, and `==` is coloured as an operator. Then type `count(...) = 3` and confirm the underline reads "Use == for equality." positioned on the `=`.

Then confirm the proximity heatmap: set a rule of `EMA(9) == EMA(21)` and open the closeness view. It must render a gradient warming as the two lines converge, not a 500.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/expr/corpus.json
git commit -m "test(expr): pin == and bare-= behaviour across both parser stacks"
```

---

## Self-Review Notes

Spec coverage check, section by section:

| Spec section | Task |
|---|---|
| `==` general, not restricted to integral operands | Tasks 2, 4 (no restriction implemented; rationale in the `_cmp_vals` comment) |
| Bare `=` → `bad_eq_op`, "Use == for equality." | Tasks 1, 5, 7 |
| `!=` out of scope | Not implemented anywhere; asserted by `test_cmp_vals_rejects_an_unknown_operator` |
| `x==` not a cross near-miss | Tasks 4, 5 (hint tuples left untouched); pinned by the `x == 3` corpus row |
| `EQ` token, `"=="` symbol, chain participation | Tasks 1, 4 |
| Operator-list consolidation (`_CMP_OPS`, `CMP_OP_TYPES`) | Tasks 4, 5 |
| `_cmp_vals` `==` branch + closing the fallthrough | Task 2 |
| Undefined/NaN unchanged (`False`) | Task 2 (`test_equality_is_false_when_an_operand_is_undefined`, including the NaN case) |
| `signed_gap("==") = -abs(l - r)` | Task 3 |
| No validation change, nothing serializes the op | No task needed — confirmed structural |
| `grammar.lezer`, `highlight.ts` | Task 6 |
| No palette/autocomplete change | No task, deliberately |
| `expected_operator` copy in both stacks | Tasks 4, 5 |
| Parity corpus mandatory | Task 7 |
| Maintainer comment on why `==` is unrestricted | Task 2, Step 3 |

Naming consistency: `EQ` (token), `"=="` (symbol), `bad_eq_op` (code), `BAD_EQ_MSG` (Python constant), `BAD_EQ_MSG` (TypeScript constant), `_CMP_OPS` (Python), `CMP_OP_TYPES` / `CMP_OP_TYPE_SET` (TypeScript), `SYM_OF` (TypeScript, replacing two local `symOf` records) — used identically wherever they appear above.

Commit-sequence safety: after every task's commit, the tree is behaviourally
correct on its own. The one sequence that would break this — parser before
evaluation — is called out under "Task Ordering" above and is the reason Tasks 2
and 3 test their functions directly instead of through `parse()`.

Two places where the plan deliberately tells the implementer to derive values rather than trust the plan: the `literals` arrays in Task 7 and the bar-pattern arithmetic in Task 4's count test. Both are mechanical outputs that are easier to read off a test failure than to hand-compute, and both have an explicit step for doing so.
