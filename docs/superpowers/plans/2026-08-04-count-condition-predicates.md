# count(), bullish/bearish predicates, and barsSinceEntry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let strategy rules count bars matching a condition (`count(bearish(candle), barsSinceEntry) >= 3`), use `bullish`/`bearish` candle predicates as conditions or whole rows, and reference trade age via `barsSinceEntry` in exit rules.

**Architecture:** Three new AST nodes (`Predicate`, `Count`, `BarsSinceEntry`) added to the backend expression pipeline (`backend/auto_trader/strategy/expr/`) and its advisory TypeScript mirror (`frontend/src/lib/expr/parser.ts`). The parser special-cases `count`'s first argument as an embedded *condition* (one comparison, one cross, or one predicate); conditions stay illegal everywhere else. Entry-free `count` precomputes via prefix sums in `series_of`; `barsSinceEntry`-bearing rows go down the per-bar recursive path with the entry bar index plumbed from `Context.long_entry_time`/`short_entry_time`. Spec: `docs/superpowers/specs/2026-08-04-count-condition-predicates-design.md`.

**Tech Stack:** Python 3.12 dataclass AST + pytest (repo venv: `.venv/bin/pytest`, run from `backend/`); TypeScript + vitest (`cd frontend && npm run test:unit`); shared parity corpus `frontend/src/lib/expr/corpus.json` (both suites test against it).

## Global Constraints

- Error codes and message copy must match EXACTLY between `validate.py` and `parser.ts` (the corpus pins spans + codes; messages are user-facing).
- `count` window semantics: last *n* bars INCLUDING the current bar; undefined condition operands count as 0 (no poisoning); the count is `None` until `i + 1 >= n`; `n < 1` after truncation → 0.0 (defined).
- `barsSinceEntry` = bars since the entry bar (0 on the entry bar); `None` before entry / when flat; exit-only (reuses error code `entry_in_entry_rule`).
- Warm-up: `count` = literal window + `warmup(cond)`; `barsSinceEntry` window contributes 0; predicate = warm-up of its candle expression.
- New error codes (exact slugs): `count_needs_condition`, `bad_predicate_arg`, `predicate_as_value`.
- Work on a NEW branch `feat/expr-count-predicates` cut from `main` (the current branch `fix/backtest-warmup-across-session-gap` has unrelated work in flight). Never `git add -A` — the worktree has unrelated modified files; stage explicit paths only.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01SvsNSXrisXLwhcfB4pCkXo`

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the branch**

```bash
cd /Users/mahmoudparham/auto_trader
git fetch origin main 2>/dev/null || true
git checkout -b feat/expr-count-predicates main
```

Note: uncommitted changes from the other branch may ride along in the worktree — do not touch or stage them. If `git checkout` refuses due to conflicts with the dirty files, use the superpowers:using-git-worktrees skill to get an isolated worktree off `main` instead.

- [ ] **Step 2: Verify baseline tests pass**

```bash
cd backend && .venv/bin/pytest tests/test_expr_parser.py tests/test_expr_validate.py tests/test_expr_evaluate.py tests/test_expr_warmup.py tests/test_expr_parser_corpus.py -q
cd ../frontend && npm run test:unit -- src/lib/expr
```

Expected: all PASS. If the frontend run fails on unrelated suites, scope to `src/lib/expr` as shown.

---

### Task 1: Backend AST nodes + registry

**Files:**
- Modify: `backend/auto_trader/strategy/expr/nodes.py`
- Modify: `backend/auto_trader/strategy/expr/registry.py`
- Test: `backend/tests/test_expr_parser.py` (nodes are exercised via parser tests in Task 2; this task only needs an import-level smoke test)

**Interfaces:**
- Produces: `N.Predicate(fn: str, base: Node, start: int, end: int)`; `N.Count(cond: Compare | Cross | Predicate, window: Node, start: int, end: int)`; `N.BarsSinceEntry(start: int, end: int)`; `N.Row = Compare | Cross | Chain | Predicate` type alias; `N.PREDICATE_FNS = ("bullish", "bearish")`; `registry.PREDICATES`, `registry.COUNT`.

- [ ] **Step 1: Add the nodes**

In `nodes.py`, after the `Chain` dataclass add:

```python
@dataclass(frozen=True, slots=True)
class Predicate:
    fn: str  # "bullish" | "bearish"
    base: "Node"  # candle-rooted expression (candle, candle[-1], candle@1H, ...)
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Count:
    cond: "Compare | Cross | Predicate"
    window: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class BarsSinceEntry:
    start: int
    end: int
```

Extend the `Node` union and add a `Row` alias right below it:

```python
Node = (
    Num | Candle | Entry | Call | Field | Offset | Tf | Unary | Binary | Compare | Cross | Chain
    | Predicate | Count | BarsSinceEntry
)

# A parsed row: what parse() returns and validate()/compile_row() accept.
Row = Compare | Cross | Chain | Predicate
```

Add next to `CROSS_FNS`:

```python
PREDICATE_FNS = ("bullish", "bearish")
```

Extend `contains_tf` with (before the final `return False`):

```python
    if isinstance(node, Predicate):
        return contains_tf(node.base)
    if isinstance(node, Count):
        return contains_tf(node.cond) or contains_tf(node.window)
```

(`BarsSinceEntry` falls through to `return False`.)

- [ ] **Step 2: Add registry entries**

In `registry.py` append:

```python
PREDICATES = ("bullish", "bearish")
COUNT = "count"
```

- [ ] **Step 3: Smoke-check imports**

```bash
cd backend && .venv/bin/python -c "from auto_trader.strategy.expr import nodes as N; print(N.Predicate, N.Count, N.BarsSinceEntry, N.Row)"
```

Expected: prints the three classes and the alias without error.

- [ ] **Step 4: Commit**

```bash
git add backend/auto_trader/strategy/expr/nodes.py backend/auto_trader/strategy/expr/registry.py
git commit -m "feat(expr): add Predicate, Count, and BarsSinceEntry AST nodes"
```

---

### Task 2: Backend parser

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py`
- Test: `backend/tests/test_expr_parser.py`

**Interfaces:**
- Consumes: Task 1's nodes.
- Produces: `parse(src) -> N.Row`; `_Parser.parse_condition() -> N.Compare | N.Cross | N.Predicate`; error `count_needs_condition` with message `"count's first argument must be a condition, like candle.open > candle.close."`.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_parser.py` (match the file's existing import/assert style — it imports `parse`, `nodes as N`, and `ExprError`):

```python
def test_parse_count_with_comparison_condition():
    node = parse("count(candle.open > candle.close, 10) >= 3")
    assert isinstance(node, N.Compare) and node.op == ">="
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Compare) and cnt.cond.op == ">"
    assert isinstance(cnt.window, N.Num) and cnt.window.value == 10


def test_parse_count_with_cross_condition():
    node = parse("count(crossBelow(candle.close, EMA(9)), 20) >= 1")
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Cross) and cnt.cond.fn == "crossBelow"


def test_parse_count_with_predicate_condition_and_dynamic_window():
    node = parse("count(bearish(candle), barsSinceEntry) >= 3")
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Predicate) and cnt.cond.fn == "bearish"
    assert isinstance(cnt.window, N.BarsSinceEntry)


def test_parse_predicate_as_whole_row():
    node = parse("bearish(candle[-1])")
    assert isinstance(node, N.Predicate) and node.fn == "bearish"
    assert isinstance(node.base, N.Offset) and node.base.n == 1


def test_parse_bars_since_entry_standalone():
    node = parse("barsSinceEntry > 12")
    assert isinstance(node.left, N.BarsSinceEntry)


def test_count_without_condition_errors():
    with pytest.raises(ExprError) as ei:
        parse("count(candle.close, 10) > 3")
    assert ei.value.code == "count_needs_condition"


def test_count_spans():
    node = parse("count(bullish(candle), 5) > 2")
    cnt = node.left
    assert (cnt.start, cnt.end) == (0, 25)  # "count(bullish(candle), 5)"
    assert (cnt.cond.start, cnt.cond.end) == (6, 21)  # "bullish(candle)"
```

(If the file doesn't already `import pytest`, add it.)

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_parser.py -q -k "count or predicate or bars_since"
```

Expected: FAIL (`count_needs_condition` not raised / nodes are plain `Call`s).

- [ ] **Step 3: Implement**

In `parser.py`:

(a) In `parse_row`, after `left = self.parse_arith()` and before the operator check, allow a bare predicate row:

```python
        left = self.parse_arith()
        op = self.peek()
        if isinstance(left, N.Predicate) and op.type == "EOF":
            self.next()
            return left
        if op.type not in ("GT", "LT", "GE", "LE"):
```

(b) In `parse_primary`, inside the `t.type == "NAME"` branch, after the `entry` case and BEFORE the generic `if self.peek().type == "LPAREN":` call handling, add:

```python
            if name.value == "barsSinceEntry":
                return N.BarsSinceEntry(name.start, name.end)
            if name.value in N.PREDICATE_FNS and self.peek().type == "LPAREN":
                self.next()
                arg = self.parse_arith()
                close = self.expect("RPAREN")
                return N.Predicate(name.value, arg, name.start, close.end)
            if name.value == "count" and self.peek().type == "LPAREN":
                self.next()
                cond = self.parse_condition()
                self.expect("COMMA")
                window = self.parse_arith()
                close = self.expect("RPAREN")
                return N.Count(cond, window, name.start, close.end)
```

(c) Add `parse_condition` as a method on `_Parser` (mirrors `parse_row`'s cross special-case, then one comparison or a bare predicate):

```python
    # condition := cross "(" arith "," arith ")" | arith cmpop arith | predicate
    def parse_condition(self) -> N.Compare | N.Cross | N.Predicate:
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
        op = self.peek()
        if op.type not in ("GT", "LT", "GE", "LE"):
            if isinstance(left, N.Predicate):
                return left
            raise ExprError(
                "count_needs_condition",
                "count's first argument must be a condition, like candle.open > candle.close.",
                left.start, left.end,
            )
        sym_of = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<="}
        optok = self.next()
        right = self.parse_arith()
        return N.Compare(sym_of[optok.type], left, right, left.start, right.end)
```

(d) Update `parse`'s return annotation to `N.Row` and `parse_row`'s to `N.Row` (import nothing new; `N` is already imported).

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests/test_expr_parser.py tests/test_expr_parser_chain.py -q
```

Expected: PASS (including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/parser.py backend/tests/test_expr_parser.py
git commit -m "feat(expr): parse count(cond, n), bullish/bearish predicates, barsSinceEntry"
```

---

### Task 3: Backend validator

**Files:**
- Modify: `backend/auto_trader/strategy/expr/validate.py`
- Test: `backend/tests/test_expr_validate.py`

**Interfaces:**
- Consumes: Task 1 nodes, Task 2 parser.
- Produces: `validate(node: N.Row, *, is_exit: bool)` handling the new nodes; errors `bad_predicate_arg` (`"{fn} takes a candle, like {fn}(candle)."`), `predicate_as_value` (`"{fn}(...) is a condition — use it as a whole row or inside count(...)."`), and `entry_in_entry_rule` reused for `barsSinceEntry` (`"barsSinceEntry is only available in exit rules."`).

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_validate.py` (match its existing helper style — it parses then validates and asserts `ExprError.code`):

```python
def test_predicate_row_valid():
    validate(parse("bullish(candle)"), is_exit=False)
    validate(parse("bearish(candle[-2])"), is_exit=False)
    validate(parse("bearish(candle@1H)"), is_exit=False)


def test_predicate_arg_must_be_bare_candle():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle.close)"), is_exit=False)
    assert ei.value.code == "bad_predicate_arg"
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(EMA(9))"), is_exit=False)
    assert ei.value.code == "bad_predicate_arg"


def test_predicate_unknown_tf_still_reported():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle@BOGUS)"), is_exit=False)
    assert ei.value.code == "unknown_tf"


def test_predicate_as_value_rejected():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle) + 1 > 0"), is_exit=False)
    assert ei.value.code == "predicate_as_value"


def test_count_validates_condition_and_window():
    validate(parse("count(candle.open > candle.close, 10) >= 3"), is_exit=False)
    validate(parse("count(crossAbove(candle.close, EMA(9)), 20) >= 1"), is_exit=False)
    validate(parse("count(bearish(candle), barsSinceEntry) >= 3"), is_exit=True)


def test_bars_since_entry_exit_only():
    with pytest.raises(ExprError) as ei:
        validate(parse("barsSinceEntry > 5"), is_exit=False)
    assert ei.value.code == "entry_in_entry_rule"
    validate(parse("barsSinceEntry > 5"), is_exit=True)


def test_count_condition_operands_validated():
    with pytest.raises(ExprError) as ei:
        validate(parse("count(FOO(9) > 0, 10) > 1"), is_exit=False)
    assert ei.value.code == "unknown_name"
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_validate.py -q -k "predicate or count or bars_since"
```

Expected: FAIL (new node kinds fall through to `unknown_name` / no branch).

- [ ] **Step 3: Implement**

In `validate.py`:

(a) `validate()` — add a predicate-row branch before the final Compare handling:

```python
    if isinstance(node, N.Predicate):
        _check_predicate(node)
        return
```

Change the signature annotation to `node: N.Row`.

(b) New helper (module level):

```python
def _check_predicate(node: N.Predicate) -> None:
    """A predicate's argument must bottom out in a bare `candle` (no field),
    wrapped only by offsets and at most one timeframe pin."""
    base = node.base
    while isinstance(base, (N.Offset, N.Tf)):
        if isinstance(base, N.Tf) and tf_resolution(base.tf) is None:
            raise ExprError(
                "unknown_tf",
                f"Unknown timeframe {base.tf}. Try one of: {', '.join(TF_RESOLUTIONS)}.",
                base.start, base.end,
            )
        base = base.base
    if not (isinstance(base, N.Candle) and base.field is None):
        raise ExprError(
            "bad_predicate_arg",
            f"{node.fn} takes a candle, like {node.fn}(candle).",
            node.start, node.end,
        )
```

(c) `_walk()` — add branches BEFORE the `(N.Compare, N.Cross, N.Chain)` catch:

```python
    if isinstance(node, N.BarsSinceEntry):
        if not is_exit:
            raise ExprError("entry_in_entry_rule", "barsSinceEntry is only available in exit rules.", node.start, node.end)
        return
    if isinstance(node, N.Predicate):
        raise ExprError(
            "predicate_as_value",
            f"{node.fn}(...) is a condition — use it as a whole row or inside count(...).",
            node.start, node.end,
        )
    if isinstance(node, N.Count):
        cond = node.cond
        if isinstance(cond, N.Predicate):
            _check_predicate(cond)
        elif isinstance(cond, N.Cross):
            _walk(cond.a, is_exit=is_exit)
            _walk(cond.b, is_exit=is_exit)
        else:
            _walk(cond.left, is_exit=is_exit)
            _walk(cond.right, is_exit=is_exit)
        _walk(node.window, is_exit=is_exit)
        return
```

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests/test_expr_validate.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/validate.py backend/tests/test_expr_validate.py
git commit -m "feat(expr): validate predicates, count conditions, and exit-only barsSinceEntry"
```

---

### Task 4: Backend literals + substitute

**Files:**
- Modify: `backend/auto_trader/strategy/expr/literals.py`
- Test: `backend/tests/test_expr_validate.py` is NOT the home — use `backend/tests/test_expr_parser.py` if literals tests live there, otherwise the dedicated literals test file (`grep -l "literals(" backend/tests` first; add to whichever file already tests `literals()`/`substitute()`).

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `literals()`/`substitute()` accepting `N.Row`; count's literal window labeled `"count window"`; `barsSinceEntry` yields no literal; `_render` covers new nodes.

- [ ] **Step 1: Write failing tests**

In the file that already tests `literals()` (find with `grep -rln "def test.*literal" backend/tests`), add:

```python
def test_count_literals_labels():
    lits = literals(parse("count(candle.open > candle.close, 10) >= 3"))
    assert [(l.value, l.label) for l in lits] == [(10.0, "count window"), (3.0, "threshold")]


def test_count_predicate_offset_literal():
    lits = literals(parse("count(bearish(candle[-1]), 20) >= 2"))
    assert [(l.value, l.label) for l in lits] == [(1.0, "bar offset"), (20.0, "count window"), (2.0, "threshold")]


def test_predicate_row_no_spurious_literals():
    assert literals(parse("bullish(candle)")) == []


def test_substitute_count_window():
    node = parse("count(candle.open > candle.close, 10) >= 3")
    lits = literals(node)
    window_ord = next(l.ordinal for l in lits if l.label == "count window")
    new = substitute(node, {window_ord: 25})
    assert new.left.window.value == 25
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest backend/tests -q -k "count_literal or count_predicate_offset or predicate_row_no or substitute_count" 2>/dev/null || cd backend && .venv/bin/pytest tests -q -k "count_literals or count_predicate_offset or predicate_row_no or substitute_count"
```

Expected: FAIL (new nodes not collected / rewrite misses them).

- [ ] **Step 3: Implement**

In `literals.py`:

(a) `_render` — add before the final `return "?"`:

```python
    if isinstance(node, N.Predicate):
        return f"{node.fn}({_render(node.base)})"
    if isinstance(node, N.Count):
        return f"count({_render(node.cond)}, {_render(node.window)})"
    if isinstance(node, N.BarsSinceEntry):
        return "barsSinceEntry"
```

(also extend `_render`'s Compare handling: it already renders `N.Binary` with an op — add a Compare branch identical in shape, `f"{_render(node.left)} {node.op} {_render(node.right)}"`, and a Cross branch `f"{node.fn}({_render(node.a)}, {_render(node.b)})"`, since `Count.cond` now flows through `_render`.)

(b) `_has_indicator` — add:

```python
    if isinstance(node, N.Predicate):
        return _has_indicator(node.base)
    if isinstance(node, N.Count):
        return True  # a count term behaves like an indicator for multiplier labeling
```

(c) `_collect` — add before the final `return` (after the Call branch), plus a BarsSinceEntry no-op alongside `(N.Candle, N.Entry)`:

Change `if isinstance(node, (N.Candle, N.Entry)):` to `if isinstance(node, (N.Candle, N.Entry, N.BarsSinceEntry)):`, then add:

```python
    if isinstance(node, N.Predicate):
        _collect(node.base, label, out)
        return
    if isinstance(node, N.Count):
        cond = node.cond
        if isinstance(cond, N.Predicate):
            _collect(cond.base, "constant", out)
        elif isinstance(cond, N.Cross):
            _collect(cond.a, "constant", out)
            _collect(cond.b, "constant", out)
        else:
            _collect(cond.left, "constant", out)
            _collect(cond.right, "constant", out)
        if isinstance(node.window, N.Num):
            out.append((node.window, "count window"))
        else:
            _collect(node.window, "constant", out)
        return
```

(d) `literals()` / `substitute()` — widen the annotations to `N.Row`. In `substitute`'s `rewrite`, add:

```python
        if isinstance(n, N.Predicate):
            return dataclasses.replace(n, base=rewrite(n.base))
        if isinstance(n, N.Count):
            return dataclasses.replace(n, cond=rewrite(n.cond), window=rewrite(n.window))
        if isinstance(n, N.BarsSinceEntry):
            return n
```

(place before the generic Call branch; `rewrite` already handles Compare/Cross so `cond` recursion works).

Also update `_collect_side`? No change needed — a Predicate row reaches `literals()` as the whole node; add a guard at the top of `literals()`:

```python
    if isinstance(node, N.Predicate):
        _collect(node.base, "constant", out)
        out.sort(key=lambda pair: pair[0].start)
        return [Literal(k, num.value, num.start, num.end, label) for k, (num, label) in enumerate(out)]
```

(Refactor if cleaner: extract the sort+wrap tail into a local helper used by both paths.)

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests -q -k "literal or substitute"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/literals.py backend/tests/
git commit -m "feat(expr): literal extraction + substitution for count/predicates/barsSinceEntry"
```

---

### Task 5: Backend warm-up

**Files:**
- Modify: `backend/auto_trader/strategy/expr/warmup.py`
- Test: `backend/tests/test_expr_warmup.py`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `warmup_bars` handling the new nodes per Global Constraints.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_warmup.py`:

```python
def test_warmup_count_literal_window():
    # window 10 + cond warmup (EMA 9) = 19
    assert warmup_bars(parse("count(candle.close > EMA(9), 10) >= 3")) == 19


def test_warmup_count_dynamic_window():
    # barsSinceEntry window contributes 0; cond is candle-only -> 0
    assert warmup_bars(parse("count(bearish(candle), barsSinceEntry) >= 3")) == 0


def test_warmup_predicate_offset():
    assert warmup_bars(parse("bearish(candle[-2])")) == 2


def test_warmup_bars_since_entry_standalone():
    assert warmup_bars(parse("barsSinceEntry > 12")) == 0
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_warmup.py -q
```

Expected: new tests FAIL (fall through to 0 / wrong values or TypeError).

- [ ] **Step 3: Implement**

In `warmup.py`, add branches before the `N.Call` branch:

```python
    if isinstance(node, N.Predicate):
        return warmup_bars(node.base, resolution)
    if isinstance(node, N.BarsSinceEntry):
        return 0
    if isinstance(node, N.Count):
        n = int(node.window.value) if isinstance(node.window, N.Num) else 0
        return n + warmup_bars(node.cond, resolution)
```

(`warmup_bars` already handles `Compare`/`Cross` at the top, and the new `Predicate` branch covers predicate conditions.)

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests/test_expr_warmup.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/warmup.py backend/tests/test_expr_warmup.py
git commit -m "feat(expr): warm-up accounting for count, predicates, and barsSinceEntry"
```

---

### Task 6: Backend evaluation — entry-free path (series_of + predicate rows)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`
- Test: `backend/tests/test_expr_evaluate.py`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `_cond_matches(cond, candles, resolution, htf) -> list[bool]` (module-level; also consumed by Task 9 closeness).
  - `_cmp_vals(op: str, l: float | None, r: float | None) -> bool` (module-level; shared by `CompiledRow._cmp`).
  - `series_of` evaluating `N.Count` (prefix sums, semantics per Global Constraints) and raising `ValueError("barsSinceEntry is not a series")` for `N.BarsSinceEntry`.
  - `compile_row`/`CompiledRow.evaluate` handling `N.Predicate` rows via a `_matches: dict[int, list[bool]]` cache field.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_evaluate.py` (reuse its existing candle-building helper — `grep -n "def.*candle\|Candle(" backend/tests/test_expr_evaluate.py` and follow suit; the sketch below assumes a helper `mk(open_, high, low, close)` exists or is trivially added):

```python
def _bars(ohlc):
    """ohlc: list of (open, close); high/low derived."""
    from datetime import datetime, timedelta, timezone
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(minutes=5 * i), open=o, high=max(o, c) + 1, low=min(o, c) - 1, close=c, volume=100)
        for i, (o, c) in enumerate(ohlc)
    ]


def test_count_series_red_candles():
    # closes below opens on bars 1,2,4
    candles = _bars([(10, 11), (11, 10), (10, 9), (9, 10), (10, 8), (8, 9)])
    node = parse("count(candle.open > candle.close, 3) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # window of 3 incl current: None,None,2,2,2,1? -> bar2 window [0,1,2]=2, bar3 [1,2,3]=2, bar4 [2,3,4]=2, bar5 [3,4,5]=1
    assert vals == [None, None, 2.0, 2.0, 2.0, 1.0]


def test_count_window_below_one_is_zero():
    candles = _bars([(10, 9), (9, 8)])
    node = parse("count(candle.open > candle.close, 0.5) > 0")
    assert series_of(node.left, candles, "MINUTE_5", {}) == [0.0, 0.0]


def test_count_undefined_cond_counts_zero():
    # EMA(3) is undefined for the first 2 bars; those bars count 0, and the
    # count itself is defined once the window fits (window 2 -> from bar 1).
    candles = _bars([(10, 11), (11, 12), (12, 13), (13, 14)])
    node = parse("count(candle.close > EMA(3), 2) >= 1")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    assert vals[0] is None and vals[1] is not None


def test_predicate_row_evaluate():
    candles = _bars([(10, 11), (11, 10), (10, 10)])
    row = compile_row(parse("bearish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(3)] == [False, True, False]  # doji is neither


def test_bullish_predicate_row():
    candles = _bars([(10, 11), (11, 10)])
    row = compile_row(parse("bullish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(2)] == [True, False]


def test_count_cross_condition():
    # close crossing above a constant-ish SMA is fiddly; use crossAbove(close, open) shape
    candles = _bars([(10, 9), (10, 11), (10, 9), (10, 11)])
    node = parse("count(crossAbove(candle.close, candle.open), 4) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # matches at bars 1 and 3 (close moves from below open to above)
    assert vals[3] == 2.0


def test_bars_since_entry_not_a_series():
    candles = _bars([(10, 11)])
    with pytest.raises(ValueError):
        series_of(parse("barsSinceEntry > 1").left, candles, "MINUTE_5", {})
```

Adjust `_bars`/imports to the file's existing conventions rather than duplicating helpers if an equivalent exists.

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_evaluate.py -q -k "count or predicate or bars_since"
```

Expected: FAIL (`series_of` raises "cannot evaluate Count as a series", etc.).

- [ ] **Step 3: Implement**

In `evaluate.py`:

(a) Module-level comparison helper (and refactor `CompiledRow._cmp` to use it):

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
    return l <= r
```

(Note: `_defined` currently sits below `series_of` — move it above `series_of` so both can use it.)

(b) Match-series builder:

```python
def _cond_matches(cond: N.Compare | N.Cross | N.Predicate, candles: Sequence[Candle],
                  resolution: str, htf: dict[str, list[Candle]]) -> list[bool]:
    """Per-bar truth of an embedded condition. Undefined operands -> False
    (a warm-up bar is a non-match, it does not poison the window)."""
    n = len(candles)
    if isinstance(cond, N.Predicate):
        opens = series_of(_apply_field_to_candle(cond.base, "open"), candles, resolution, htf)
        closes = series_of(_apply_field_to_candle(cond.base, "close"), candles, resolution, htf)
        if cond.fn == "bullish":
            return [_defined(opens[i]) and _defined(closes[i]) and closes[i] > opens[i] for i in range(n)]
        return [_defined(opens[i]) and _defined(closes[i]) and closes[i] < opens[i] for i in range(n)]
    if isinstance(cond, N.Cross):
        a = series_of(cond.a, candles, resolution, htf)
        b = series_of(cond.b, candles, resolution, htf)
        out = [False] * n
        for i in range(1, n):
            if not all(_defined(v) for v in (a[i], a[i - 1], b[i], b[i - 1])):
                continue
            if cond.fn == "crossAbove":
                out[i] = a[i - 1] <= b[i - 1] and a[i] > b[i]
            else:
                out[i] = a[i - 1] >= b[i - 1] and a[i] < b[i]
        return out
    left = series_of(cond.left, candles, resolution, htf)
    right = series_of(cond.right, candles, resolution, htf)
    return [_cmp_vals(cond.op, left[i], right[i]) for i in range(n)]
```

(c) `series_of` — add a `Count` branch (before the `Call` branch) and a `BarsSinceEntry` guard next to the `Entry` one:

```python
    if isinstance(node, N.BarsSinceEntry):
        raise ValueError("barsSinceEntry is not a series")
    if isinstance(node, N.Count):
        matches = _cond_matches(node.cond, candles, resolution, htf)
        pre = [0] * (n + 1)  # prefix sums: pre[j+1] = matches in bars [0, j]
        for j in range(n):
            pre[j + 1] = pre[j] + (1 if matches[j] else 0)
        wseries = series_of(node.window, candles, resolution, htf)
        out: list[float | None] = [None] * n
        for i in range(n):
            wv = wseries[i]
            if not _defined(wv):
                continue
            k = int(wv)
            if k < 1:
                out[i] = 0.0
                continue
            if i + 1 < k:
                continue  # window does not fit yet
            out[i] = float(pre[i + 1] - pre[i + 1 - k])
        return out
```

(d) `CompiledRow` — add a cache field and predicate-row evaluation. Extend the dataclass:

```python
    _matches: dict[int, list[bool]]
```

In `compile_row`, handle the new row shape when collecting `subs` and construct the new field:

```python
    elif isinstance(node, N.Predicate):
        subs = []  # match series is built lazily on first evaluate
```

and change the constructor call to `CompiledRow(node, candles, resolution, htf, warmup_bars(node, resolution), cache, {})`.

In `CompiledRow.evaluate`, add before the Compare branch:

```python
        if isinstance(node, N.Predicate):
            key = id(node)
            if key not in self._matches:
                self._matches[key] = _cond_matches(node, self.candles, self.resolution, self.htf)
            m = self._matches[key]
            return m[i] if 0 <= i < len(m) else False
```

(e) `_entry_free` — add explicit branches (before the final `return True`):

```python
    if isinstance(node, N.BarsSinceEntry):
        return False
    if isinstance(node, N.Predicate):
        return _entry_free(node.base)
    if isinstance(node, N.Count):
        return _entry_free(node.cond) and _entry_free(node.window)
    if isinstance(node, N.Compare):
        return _entry_free(node.left) and _entry_free(node.right)
    if isinstance(node, N.Cross):
        return _entry_free(node.a) and _entry_free(node.b)
```

(f) Widen `compile_row`'s node annotation to `N.Row` and `CompiledRow.node` to `N.Row`.

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests/test_expr_evaluate.py -q
```

Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_evaluate.py
git commit -m "feat(expr): evaluate count and predicate rows on the precomputed series path"
```

---

### Task 7: Backend evaluation — per-bar path (barsSinceEntry) + strategy plumbing

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`
- Modify: `backend/auto_trader/strategy/expr/strategy.py`
- Test: `backend/tests/test_expr_evaluate.py`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `CompiledRow.evaluate(i: int, entry_price: float | None, entry_i: int | None = None) -> bool` (extra arg is backward-compatible — every existing caller passes two args).
  - `CompiledRow._val(sub, i, entry, entry_i)` handling `N.BarsSinceEntry` (value `float(j - entry_i)` at bar j; `None` when `entry_i is None` or `j < entry_i`) and dynamic-window `N.Count`.
  - `ExprRuleStrategy` deriving `entry_i` from `ctx.long_entry_time`/`short_entry_time` via `bisect_right` over history times and passing it to exit-row evaluation.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_evaluate.py`:

```python
def test_bars_since_entry_value():
    candles = _bars([(10, 11)] * 6)
    row = compile_row(parse("barsSinceEntry > 2"), candles, "MINUTE_5", {})
    # entry at bar 2 -> barsSinceEntry = i - 2
    assert [row.evaluate(i, 10.0, 2) for i in range(6)] == [False, False, False, False, False, True]
    # flat (no entry_i) -> never fires
    assert row.evaluate(5, None, None) is False


def test_count_dynamic_window_since_entry():
    # bars: green, entry@1, red, red, green, red -> reds since entry at bars 2,3,5
    candles = _bars([(10, 11), (11, 12), (12, 11), (11, 10), (10, 11), (11, 10)])
    row = compile_row(parse("count(bearish(candle), barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    entry_i = 1
    got = [row.evaluate(i, 12.0, entry_i) for i in range(6)]
    # bar5: window = 4 bars (2..5), reds = 3 -> fires; bar4: window 3 (2..4), reds 2 -> no
    assert got == [False, False, False, False, False, True]


def test_count_dynamic_window_entry_price_condition():
    # count closes below entry since entry
    candles = _bars([(10, 11), (11, 12), (12, 9), (9, 8), (8, 13), (13, 7)])
    row = compile_row(parse("count(candle.close < entry, barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    got = [row.evaluate(i, 12.0, 1) for i in range(6)]
    # closes below 12 since entry: bars 2(9),3(8),5(7) -> 3rd at bar 5
    assert got[5] is True and got[4] is False


def test_strategy_passes_entry_index():
    from auto_trader.strategy.base import Context
    from auto_trader.strategy.expr.strategy import ExprRuleStrategy
    candles = _bars([(10, 11), (11, 12), (12, 11), (11, 10), (10, 9)])
    exit_row = compile_row(parse("count(bearish(candle), barsSinceEntry) >= 3"), candles, "MINUTE_5", {})
    strat = ExprRuleStrategy([], [exit_row], [], [], quantity=1.0)
    ctx = Context()
    ctx.history = list(candles)
    ctx.position_long = 1.0
    ctx.long_entry_price = 12.0
    ctx.long_entry_time = candles[1].time
    signals = strat.on_bar(ctx)
    # bars 2 (12->11), 3 (11->10), 4 (10->9) are all red; entry bar 1, i=4 ->
    # window of barsSinceEntry=3 covers bars 2..4 with 3 reds -> the exit fires.
    assert len(signals) == 1 and signals[0].leg == "long"
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_evaluate.py -q -k "bars_since or dynamic or passes_entry"
```

Expected: FAIL (TypeError: evaluate takes 2 positional args / fallback crash).

- [ ] **Step 3: Implement**

In `evaluate.py`:

(a) Add a second cache field to `CompiledRow` for rewritten predicate field-nodes:

```python
    _pred_nodes: dict[int, tuple[N.Node, N.Node]]
```

(update the `compile_row` constructor call: `..., cache, {}, {})`).

(b) Thread `entry_i` through: `evaluate(self, i, entry_price, entry_i=None)`, `_val(self, sub, i, entry, entry_i)`, `_cmp(self, part, i, entry, entry_i)` — mechanical parameter addition to every internal call site (including the Cross arm's four `_val` calls and the Chain/Compare arms).

(c) In `_val`, add branches BEFORE the defensive `series_of` fallback:

```python
        if isinstance(sub, N.BarsSinceEntry):
            if entry_i is None or i < entry_i:
                return None
            return float(i - entry_i)
        if isinstance(sub, N.Count):
            wv = self._val(sub.window, i, entry, entry_i)
            if not _defined(wv):
                return None
            k = int(wv)
            if k < 1:
                return 0.0
            if i + 1 < k:
                return None
            return float(sum(
                1 for j in range(i - k + 1, i + 1)
                if self._match_at(sub.cond, j, entry, entry_i)
            ))
```

(Entry-free `Count` subtrees are precomputed into `_cache` by `_precompute`, so this branch only runs for dynamic/entry-bearing counts.)

(d) New method `_match_at`:

```python
    def _match_at(self, cond, j: int, entry: float | None, entry_i: int | None) -> bool:
        """Truth of an embedded condition at bar j (per-bar path)."""
        if isinstance(cond, N.Predicate):
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
                return False
            return c > o if cond.fn == "bullish" else c < o
        if isinstance(cond, N.Cross):
            if j == 0:
                return False
            a1, a0 = self._val(cond.a, j, entry, entry_i), self._val(cond.a, j - 1, entry, entry_i)
            b1, b0 = self._val(cond.b, j, entry, entry_i), self._val(cond.b, j - 1, entry, entry_i)
            if not all(_defined(v) for v in (a1, a0, b1, b0)):
                return False
            if cond.fn == "crossAbove":
                return a0 <= b0 and a1 > b1
            return a0 >= b0 and a1 < b1
        return _cmp_vals(cond.op, self._val(cond.left, j, entry, entry_i), self._val(cond.right, j, entry, entry_i))
```

Note: the rewritten predicate nodes are cached by `id(cond)` so the `_val` fallback's `series_of` cache (keyed by `id(node)`) stays warm for offset/@tf bases instead of recomputing per bar.

In `strategy.py`:

(e) Derive the entry bar index and pass it through:

```python
import bisect
```

```python
    @staticmethod
    def _passes(rows: list[CompiledRow], i: int, entry: float | None, entry_i: int | None = None) -> bool:
        # An empty group never fires (no entry rules -> no entries; no exit rules
        # -> the position only leaves via risk/range-end), matching RuleStrategy.
        return bool(rows) and all(r.evaluate(i, entry, entry_i) for r in rows)

    @staticmethod
    def _entry_index(ctx: Context, entry_time) -> int | None:
        """Index of the bar containing `entry_time` (last bar at or before it),
        feeding barsSinceEntry. None when flat or before all history."""
        if entry_time is None:
            return None
        idx = bisect.bisect_right(ctx.history, entry_time, key=lambda c: c.time) - 1
        return idx if idx >= 0 else None
```

(import `Context` from `auto_trader.strategy.base` — check the existing imports; `on_bar` already receives it.)

In `on_bar`, compute per side only when held and pass along:

```python
            if ctx.position_long > 0 and self._passes(
                self.long_exit, i, ctx.long_entry_price, self._entry_index(ctx, ctx.long_entry_time)
            ):
```

(and the mirrored short branch with `ctx.short_entry_time`).

- [ ] **Step 4: Run tests**

```bash
cd backend && .venv/bin/pytest tests/test_expr_evaluate.py tests/test_api_expr.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/auto_trader/strategy/expr/strategy.py backend/tests/test_expr_evaluate.py
git commit -m "feat(expr): per-bar count with barsSinceEntry window, entry-bar plumbing"
```

---

### Task 8: Backend routes — tf walkers + closeness

**Files:**
- Modify: `backend/auto_trader/api/routers/expr.py` (`_referenced_tfs`, `_tf_inner_warmup`)
- Modify: `backend/auto_trader/strategy/expr/closeness.py` (`row_closeness`, `group_closeness` annotations)
- Test: `backend/tests/test_expr_closeness.py`, `backend/tests/test_api_expr.py`

**Interfaces:**
- Consumes: Tasks 1–7 (`_cond_matches` from `evaluate.py`).
- Produces: `@tf` pins inside predicates/counts are fetched; closeness for a predicate row = 1.0/0.0 per bar.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_expr_closeness.py`:

```python
def test_predicate_row_closeness_binary():
    candles = _bars([(10, 11), (11, 10), (10, 10)])  # reuse/adapt the file's candle helper
    norm = Norm(basis="volatility", width=1.0, window=2, atr_length=14)
    vals = row_closeness(parse("bearish(candle)"), candles, "MINUTE_5", {}, norm)
    assert vals == [0.0, 1.0, 0.0]
```

Append to `backend/tests/test_api_expr.py` an end-to-end backtest of the canonical rule. The file's `_candles` helper builds doji bars (open == close), useless for redness — add an open/close-aware builder next to it:

```python
def _oc_candles(bars):
    """bars: list of (open, close); high/low derived. Hourly steps."""
    return [{"time": 3600 * k, "open": o, "high": max(o, c) + 1, "low": min(o, c) - 1,
             "close": c, "volume": 100.0} for k, (o, c) in enumerate(bars)]


def test_expr_backtest_count_red_since_entry_exit():
    """Canonical spec rule: exit when a 3rd red candle since entry closes below
    the entry price. crossAbove(close, 103) fires exactly once, at bar 1
    (102 -> 104); the position fills at bar 2 open (104) -> entry bar 2. Bar 2
    is itself red (104 -> 103) but is the entry bar, so it is EXCLUDED from the
    barsSinceEntry window. Reds since entry: bars 3, 4, 5 -> the count hits 3 on
    bar 5 (close 100 < entry 104 too), exit fills at bar 6 open (100)."""
    bars = [(101, 102), (102, 104), (104, 103), (103, 102), (102, 101), (101, 100), (100, 100)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_oc_candles(bars),
        longEntry=[{"expr": "crossAbove(candle.close, 103)"}],
        longExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"},
                  {"expr": "candle.close < entry"}],
    ))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) == 1
    t = trades[0]
    assert t["entry_time"] == 3600 * 2 and t["entry_price"] == 104
    assert t["exit_time"] == 3600 * 6 and t["exit_price"] == 100  # bar-6 open fill
    assert t["reason"] != "range end"


def test_expr_backtest_count_needs_third_red():
    """Same shape but bar 5 is green (101 -> 103, still below the 103 cross
    threshold so the entry never re-fires): only 2 reds since entry, the rule
    never fires, and the trade exits at range end."""
    bars = [(101, 102), (102, 104), (104, 103), (103, 102), (102, 101), (101, 103), (103, 103)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_oc_candles(bars),
        longEntry=[{"expr": "crossAbove(candle.close, 103)"}],
        longExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"},
                  {"expr": "candle.close < entry"}],
    ))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) == 1
    assert trades[0]["reason"] == "range end"
```

Also add a tf-walker unit test (same file or `test_api_expr.py`):

```python
def test_referenced_tfs_sees_into_count_and_predicates():
    from auto_trader.api.routers.expr import _referenced_tfs
    node = parse("count(bearish(candle@1H), 10) >= 2")
    assert _referenced_tfs(node) == {"1H"}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && .venv/bin/pytest tests/test_expr_closeness.py tests/test_api_expr.py -q -k "predicate or referenced or count"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

In `routers/expr.py`, extend both walkers with new-node branches:

```python
# in _referenced_tfs, before the final `return set()`:
    if isinstance(node, N.Predicate):
        return _referenced_tfs(node.base)
    if isinstance(node, N.Count):
        return _referenced_tfs(node.cond) | _referenced_tfs(node.window)

# in _tf_inner_warmup, before the final `return 0`:
    if isinstance(node, N.Predicate):
        return _tf_inner_warmup(node.base, tf)
    if isinstance(node, N.Count):
        return max(_tf_inner_warmup(node.cond, tf), _tf_inner_warmup(node.window, tf))
```

In `closeness.py`:

```python
from auto_trader.strategy.expr.evaluate import _cond_matches
```

(`series_of` is already imported there.)

In `row_closeness`, before the gap computation:

```python
    if isinstance(node, N.Predicate):
        # A predicate is binary: closeness is 1 when it holds, else 0. There is
        # no meaningful gradient toward "almost red".
        m = _cond_matches(node, candles, resolution, htf)
        return [1.0 if v else 0.0 for v in m]
```

Widen `row_closeness`/`group_closeness` annotations to accept `N.Row` (`N.Compare | N.Cross | N.Chain | N.Predicate`).

- [ ] **Step 4: Run the full backend suite**

```bash
cd backend && .venv/bin/pytest tests -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/expr.py backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py backend/tests/test_api_expr.py
git commit -m "feat(expr): route tf-walkers + closeness support for count/predicate rows"
```

---

### Task 9: Frontend catalog, palette, highlight

**Files:**
- Modify: `frontend/src/lib/expr/catalog.ts`
- Modify: `frontend/src/components/RulePalette.tsx`
- Modify: `frontend/src/lib/expr/highlight.ts`
- Modify: `frontend/src/lib/expr/grammar.lezer` (comment-level: note the new names; the grammar is not built, keep the diff minimal)
- Test: `frontend/src/lib/expr/complete.test.ts` (completion additions land in Task 11; this task is catalog + palette only and is verified by typecheck)

**Interfaces:**
- Produces: `catalog.CONDITIONS: CatalogEntry[]`, `catalog.PREDICATE_FNS = ["bullish", "bearish"] as const`, `catalog.COUNT_FN = "count"`. Palette gets a **Conditions** group.

- [ ] **Step 1: Extend the catalog**

In `catalog.ts` after `CROSSES`:

```typescript
export const CONDITIONS: CatalogEntry[] = [
  { name: "count", insert: "count(bearish(candle), 10)", signature: "count(cond, n)", detail: "Bars matching a condition in the last n bars" },
  { name: "bullish", insert: "bullish(candle)", signature: "bullish(candle)", detail: "Candle closed above its open" },
  { name: "bearish", insert: "bearish(candle)", signature: "bearish(candle)", detail: "Candle closed below its open" },
  { name: "barsSinceEntry", insert: "barsSinceEntry", signature: "barsSinceEntry", detail: "Bars since the trade opened (exit rules only)" },
];

export const PREDICATE_FNS = ["bullish", "bearish"] as const;
export const COUNT_FN = "count";
```

- [ ] **Step 2: Add the palette group**

In `RulePalette.tsx`, import `CONDITIONS` and add a group between Crosses and Timeframes, identical in shape to the Crosses block:

```tsx
      {/* Conditions section */}
      <div className="rule-palette-group">
        <h3>Conditions</h3>
        <div className="rule-palette-items">
          {CONDITIONS.map((entry) => (
            <Tooltip key={entry.name} content={entry.detail}>
              <button onClick={() => onInsert(entry.insert)}>
                {entry.signature}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
```

- [ ] **Step 3: Highlight the new names**

In `highlight.ts`, import `PREDICATE_FNS`, `COUNT_FN` from the catalog and extend `classify` before the final `return "variable"`:

```typescript
  if (value === COUNT_FN) return "wrapper";
  if ((PREDICATE_FNS as readonly string[]).includes(value)) return "cross";
```

(`barsSinceEntry` stays "variable", same as `entry`.)

In `grammar.lezer`, add a one-line comment under the `Wrapper` note that `count`/`bullish`/`bearish`/`barsSinceEntry` are specialized the same way (no structural grammar change — it is permissive and unbuilt).

- [ ] **Step 4: Typecheck + existing tests**

```bash
cd frontend && npx tsc -b --noEmit 2>/dev/null || npx tsc --noEmit -p tsconfig.json; npm run test:unit -- src/lib/expr
```

Expected: clean typecheck; existing expr tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/catalog.ts frontend/src/components/RulePalette.tsx frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/grammar.lezer
git commit -m "feat(expr-editor): Conditions palette group + catalog/highlight entries"
```

---

### Task 10: Frontend parser mirror (parser.ts)

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts`
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: Task 9 catalog exports.
- Produces: `analyze()`/`warmupOf()` handling the three new node kinds with EXACTLY the backend's error codes, messages, spans, literal labels, and warm-up math (Tasks 2–5).

- [ ] **Step 1: Write failing tests**

Append to `parser.test.ts` (match its existing style):

```typescript
describe("count / predicates / barsSinceEntry", () => {
  it("parses the canonical exit rule", () => {
    const r = analyze("count(bearish(candle), barsSinceEntry) >= 3", { isExit: true });
    expect(r.error).toBeNull();
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[3, "threshold"]]);
  });
  it("labels the count window", () => {
    const r = analyze("count(candle.open > candle.close, 10) >= 3");
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[10, "count window"], [3, "threshold"]]);
  });
  it("rejects a non-condition first argument", () => {
    const r = analyze("count(candle.close, 10) > 3");
    expect(r.error?.code).toBe("count_needs_condition");
  });
  it("accepts a bare predicate row", () => {
    expect(analyze("bearish(candle[-1])").error).toBeNull();
  });
  it("rejects a predicate used as a value", () => {
    expect(analyze("bullish(candle) + 1 > 0").error?.code).toBe("predicate_as_value");
  });
  it("rejects a fielded candle in a predicate", () => {
    expect(analyze("bullish(candle.close)").error?.code).toBe("bad_predicate_arg");
  });
  it("gates barsSinceEntry to exit rules", () => {
    expect(analyze("barsSinceEntry > 5").error?.code).toBe("entry_in_entry_rule");
    expect(analyze("barsSinceEntry > 5", { isExit: true }).error).toBeNull();
  });
  it("warm-up: count literal window + cond warmup", () => {
    expect(warmupOf("count(candle.close > EMA(9), 10) >= 3")).toBe(19);
    expect(warmupOf("count(bearish(candle), barsSinceEntry) >= 3")).toBe(0);
    expect(warmupOf("bearish(candle[-2])")).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd frontend && npm run test:unit -- src/lib/expr/parser.test.ts
```

Expected: new tests FAIL.

- [ ] **Step 3: Implement**

Mirror the backend exactly, translated to the file's idiom:

(a) AST kinds + Row:

```typescript
interface PredicateNode { kind: "Predicate"; fn: string; base: Node; start: number; end: number; }
interface CountNode { kind: "Count"; cond: CompareNode | CrossNode | PredicateNode; window: Node; start: number; end: number; }
interface BarsSinceEntryNode { kind: "BarsSinceEntry"; start: number; end: number; }
```

Add all three to the `Node` union; add `PredicateNode` to `Row`. Extend `containsTf` with Predicate (`base`) and Count (`cond` or `window`) cases.

(b) Parser — same three insertions as backend Task 2 (`parse_row` bare-predicate early-return; `parsePrimary` cases for `barsSinceEntry`, predicates, and `count`; a `parseCondition()` method). Import `PREDICATE_FNS`, `COUNT_FN` from the catalog. Error message/spans identical to backend: `count_needs_condition` spans the offending first argument.

(c) Validator — mirror backend Task 3: `checkPredicate` (unknown_tf inside the arg, `bad_predicate_arg` copy `` `${node.fn} takes a candle, like ${node.fn}(candle).` ``), `predicate_as_value` in `walk`, `Count` branch validating cond + window, `BarsSinceEntry` exit-only reusing `entry_in_entry_rule` with message `"barsSinceEntry is only available in exit rules."`, `validate()` predicate-row branch.

(d) Literals — mirror backend Task 4: `render` cases (Predicate/Count/BarsSinceEntry, plus Compare/Cross render arms), `hasIndicator` (Predicate → base; Count → true), `collect` Count/Predicate/BarsSinceEntry branches (`"count window"` label), `literalsOf` predicate-row branch.

(e) `warmupNode` — mirror backend Task 5:

```typescript
    case "Predicate": return warmupNode(node.base, baseSeconds);
    case "BarsSinceEntry": return 0;
    case "Count": {
      const w = node.window;
      const n = w.kind === "Num" ? Math.trunc(w.value) : 0;
      return n + warmupNode(node.cond, baseSeconds);
    }
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npm run test:unit -- src/lib/expr/parser.test.ts src/lib/expr/lint.ts 2>/dev/null; npm run test:unit -- src/lib/expr
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr-editor): mirror count/predicates/barsSinceEntry in the advisory parser"
```

---

### Task 11: Parity corpus + completion

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json` (shared fixture — `backend/tests/test_expr_parser_corpus.py` and `corpus.test.ts` both consume it)
- Modify: `frontend/src/lib/expr/complete.ts`
- Test: `frontend/src/lib/expr/complete.test.ts`, `frontend/src/lib/expr/corpus.test.ts`, `backend/tests/test_expr_parser_corpus.py`

**Interfaces:**
- Consumes: Tasks 2–5 (backend behavior) and Task 10 (mirror).
- Produces: corpus entries pinning both sides; bare-word completion offers `count`, `bullish`, `bearish`, `barsSinceEntry`.

- [ ] **Step 1: Add corpus entries**

Append to `corpus.json` (compute spans by hand against the exact strings; the backend corpus test will catch any miscount — run it before trusting the numbers):

```json
  { "expr": "count(candle.open > candle.close, 10) >= 3", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":10,"from":34,"to":36,"label":"count window"},
      {"ordinal":1,"value":3,"from":41,"to":42,"label":"threshold"}
    ] },
  { "expr": "count(bearish(candle), barsSinceEntry) >= 3", "isExit": true, "error": null,
    "literals": [
      {"ordinal":0,"value":3,"from":42,"to":43,"label":"threshold"}
    ] },
  { "expr": "count(candle.close, 10) > 3", "isExit": false, "error": {"code":"count_needs_condition","from":6,"to":18}, "literals": [] },
  { "expr": "bearish(candle[-1])", "isExit": false, "error": null, "literals": [
      {"ordinal":0,"value":1,"from":16,"to":17,"label":"bar offset"}
    ] },
  { "expr": "bullish(candle.close)", "isExit": false, "error": {"code":"bad_predicate_arg","from":0,"to":21}, "literals": [] },
  { "expr": "bullish(candle) + 1 > 0", "isExit": false, "error": {"code":"predicate_as_value","from":0,"to":15}, "literals": [] },
  { "expr": "barsSinceEntry > 5", "isExit": false, "error": {"code":"entry_in_entry_rule","from":0,"to":14}, "literals": [] },
  { "expr": "barsSinceEntry > 5", "isExit": true, "error": null, "literals": [
      {"ordinal":0,"value":5,"from":17,"to":18,"label":"threshold"}
    ] }
```

IMPORTANT: verify each `from`/`to` by running BOTH corpus suites (next step); fix the JSON, not the implementations, when a span is miscounted by hand — unless the two implementations disagree with each other, which is a real parity bug.

- [ ] **Step 2: Run both corpus suites**

```bash
cd backend && .venv/bin/pytest tests/test_expr_parser_corpus.py -q
cd ../frontend && npm run test:unit -- src/lib/expr/corpus.test.ts
```

Expected: PASS on both (this is the parity gate).

- [ ] **Step 3: Completion**

In `complete.ts`, add the `CONDITIONS` entries to the bare-word candidate list (import `CONDITIONS` from the catalog; feed each through the existing `fnCandidate` helper — `barsSinceEntry` has no `(`, so `argFrom` stays undefined and it inserts as a plain word). Choose a `type` string consistent with what the file uses for crosses.

Add to `complete.test.ts`:

```typescript
it("offers conditions on a bare prefix", () => {
  const labels = completionsFor("cou", 3)!.options.map((o) => o.label);
  expect(labels).toContain("count");
});
it("offers barsSinceEntry", () => {
  const labels = completionsFor("bars", 4)!.options.map((o) => o.label);
  expect(labels).toContain("barsSinceEntry");
});
```

(Adapt the call shape to `completionsFor`'s real signature in that file.)

- [ ] **Step 4: Run frontend expr suites**

```bash
cd frontend && npm run test:unit -- src/lib/expr
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/corpus.json frontend/src/lib/expr/complete.ts frontend/src/lib/expr/complete.test.ts
git commit -m "feat(expr-editor): parity corpus + completion for count/predicates/barsSinceEntry"
```

---

### Task 12: Full verification

**Files:** none new.

- [ ] **Step 1: Full backend suite**

```bash
cd backend && .venv/bin/pytest tests -q
```

Expected: PASS. Pay attention to `test_expr_closeness.py`, `test_api_expr.py`, `test_expr_warmup.py`, and any sweep tests (`substitute` changed).

- [ ] **Step 2: Full frontend suite + typecheck + lint**

```bash
cd frontend && npx tsc -b --noEmit || npx tsc --noEmit; npm run test:unit; npm run lint
```

Expected: PASS/clean. (Sweep-literal suites `sweepLiterals.test.ts`, `pruneLitAxes.test.ts`, and `BacktestSettingsModal.test.tsx` exercise `analyze`/`warmupOf` indirectly.)

- [ ] **Step 3: Verify the canonical rule end-to-end**

Confirm the Task 8 API test covers: long exit rows `["count(bearish(candle), barsSinceEntry) >= 3", "candle.close < entry"]` producing an exit on the 3rd red bar below entry. If it was stubbed, finish it now — this is the feature's acceptance test.

- [ ] **Step 4: Use superpowers:requesting-code-review, then superpowers:finishing-a-development-branch**

Follow those skills for review and merge/PR handling.
