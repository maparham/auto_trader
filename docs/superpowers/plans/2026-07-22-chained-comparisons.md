# Chained Comparisons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse `candle.close > EMA(9) > EMA(50)` as the AND of consecutive comparisons `(close>EMA9) AND (EMA9>EMA50)`, instead of raising a 422.

**Architecture:** Add a `Chain` node holding a list of consecutive `Compare` links. The parser emits `Chain` for 2+ links, `Compare` for one (unchanged). Every row-level consumer (validate, warmup, evaluate, closeness, literals, router, plus the frontend editor's mirror parser) handles `Chain` as an AND of its parts. A chain is atomic within its row: it stays AND even when its rule group combines with OR.

**Tech Stack:** Python (backend expr engine, pytest), TypeScript (frontend CodeMirror mirror parser, vitest).

## Global Constraints

- Any operator mix is allowed in a chain (`> < >= <=`); there is no direction/monotonicity check.
- A single comparison stays `Compare` (2+ links become `Chain`) — existing rules and their serialization are unchanged.
- A chain folds with AND everywhere: evaluate requires all parts true; closeness takes the per-bar `min` of the parts (None poisons the bar).
- `crossAbove`/`crossBelow` stay whole-row only and never appear inside a chain (the parser's cross branch returns before the chain loop).
- No em dashes in any user-facing copy. No new error codes are introduced.
- Consecutive `Compare` parts share operand node objects (link _i_'s right is link _i+1_'s left); nodes are immutable so sharing is safe.

**Ordering rationale:** The backend parser (Task 7) is the only thing that emits `Chain` in real use. Every consumer task before it (Tasks 2-6) is tested by constructing `Chain` nodes directly in the test, so the suite stays green at every commit — no runtime path produces a `Chain` until all consumers handle it.

---

### Task 1: `Chain` node type

**Files:**
- Modify: `backend/auto_trader/strategy/expr/nodes.py`
- Test: `backend/tests/test_expr_nodes.py` (create)

**Interfaces:**
- Produces: `N.Chain(parts: list[N.Compare], start: int, end: int)`, added to the `Node` union; `N.contains_tf` handles it.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_nodes.py`:

```python
from auto_trader.strategy.expr import nodes as N


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def test_chain_holds_parts_and_span():
    close = N.Candle("close", 0, 12)
    e9 = N.Call("EMA", [N.Num(9, 21, 22)], 15, 23)
    e50 = N.Call("EMA", [N.Num(50, 30, 32)], 26, 33)
    p1 = _cmp(">", close, e9)
    p2 = _cmp(">", e9, e50)
    chain = N.Chain([p1, p2], p1.start, p2.end)
    assert chain.parts == [p1, p2]
    assert (chain.start, chain.end) == (0, 33)


def test_contains_tf_sees_into_chain_parts():
    close = N.Candle("close", 0, 12)
    e9_d = N.Tf(N.Call("EMA", [N.Num(9, 0, 0)], 0, 0), "D", 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    plain = N.Chain([_cmp(">", close, e50), _cmp(">", e50, e50)], 0, 0)
    tfd = N.Chain([_cmp(">", close, e9_d), _cmp(">", e9_d, e50)], 0, 0)
    assert N.contains_tf(plain) is False
    assert N.contains_tf(tfd) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_nodes.py -v`
Expected: FAIL with `AttributeError: module ... has no attribute 'Chain'`.

- [ ] **Step 3: Add the node**

In `nodes.py`, after the `Cross` dataclass (around line 89):

```python
@dataclass(frozen=True, slots=True)
class Chain:
    parts: list["Compare"]
    start: int
    end: int
```

Add `Chain` to the `Node` union:

```python
Node = (
    Num | Candle | Entry | Call | Field | Offset | Tf | Unary | Binary | Compare | Cross | Chain
)
```

In `contains_tf`, before the final `return False`:

```python
    if isinstance(node, Chain):
        return any(contains_tf(p) for p in node.parts)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_nodes.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/nodes.py backend/tests/test_expr_nodes.py
git commit -m "feat(expr): Chain node for chained comparisons"
```

---

### Task 2: Evaluate a `Chain` as AND

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py:161-257`
- Test: `backend/tests/test_expr_closeness.py` (append) — or a new `test_expr_evaluate_chain.py`

**Interfaces:**
- Consumes: `N.Chain` from Task 1.
- Produces: `CompiledRow` accepts a `Chain`; `compile_row(chain, ...)` precomputes all parts' operands; `evaluate(i, entry)` returns True only when every part holds.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_evaluate_chain.py`:

```python
from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.evaluate import compile_row


def _c(close, i):
    t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
    return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                  open=close, high=close + 1, low=close - 1, close=close, volume=100)


def _cmp(op, a, b):
    return N.Compare(op, a, b, 0, 0)


def _chain(*parts):
    return N.Chain(list(parts), 0, 0)


def test_chain_true_only_when_all_links_hold():
    # links: close > 100  AND  close < 200
    candles = [_c(x, i) for i, x in enumerate([90, 150, 250])]
    close = N.Candle("close", 0, 0)
    chain = _chain(_cmp(">", close, N.Num(100, 0, 0)),
                   _cmp("<", close, N.Num(200, 0, 0)))
    row = compile_row(chain, candles, "MINUTE", {})
    assert row.evaluate(0, None) is False   # 90 not > 100
    assert row.evaluate(1, None) is True    # 100<150<200
    assert row.evaluate(2, None) is False   # 250 not < 200


def test_chain_false_when_an_operand_undefined():
    # SMA(5) is undefined on bar 0 (warmup) -> its link is False -> chain False
    candles = [_c(x, i) for i, x in enumerate([100, 101, 102, 103, 104, 105])]
    close = N.Candle("close", 0, 0)
    sma = N.Call("SMA", [N.Num(5, 0, 0)], 0, 0)
    chain = _chain(_cmp(">", close, N.Num(0, 0, 0)),
                   _cmp(">", close, sma))
    row = compile_row(chain, candles, "MINUTE", {})
    assert row.evaluate(0, None) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_evaluate_chain.py -v`
Expected: FAIL — `compile_row` unpacks `node.left`/`node.a` on a `Chain` and raises `AttributeError`.

- [ ] **Step 3: Handle `Chain` in evaluate**

In `evaluate.py`, widen the `CompiledRow.node` type hint (line 163) to `N.Compare | N.Cross | N.Chain`.

Extract the comparison logic and add the `Chain` branch. Replace the `evaluate` method (lines 193-218) so the `Compare` arithmetic lives in a helper reused by `Chain`:

```python
    def _cmp(self, part: N.Compare, i: int, entry: float | None) -> bool:
        l = self._val(part.left, i, entry)
        r = self._val(part.right, i, entry)
        if not (_defined(l) and _defined(r)):
            return False
        if part.op == ">":
            return l > r
        if part.op == "<":
            return l < r
        if part.op == ">=":
            return l >= r
        return l <= r

    def evaluate(self, i: int, entry_price: float | None) -> bool:
        node = self.node
        if isinstance(node, N.Compare):
            return self._cmp(node, i, entry_price)
        if isinstance(node, N.Chain):
            return all(self._cmp(p, i, entry_price) for p in node.parts)
        # Cross
        if i == 0:
            return False
        lnow = self._val(node.a, i, entry_price)
        lprev = self._val(node.a, i - 1, entry_price)
        rnow = self._val(node.b, i, entry_price)
        rprev = self._val(node.b, i - 1, entry_price)
        if not all(_defined(v) for v in (lnow, lprev, rnow, rprev)):
            return False
        if node.fn == "crossAbove":
            return lprev <= rprev and lnow > rnow
        return lprev >= rprev and lnow < rnow
```

Update `compile_row` (lines 252-257) so a `Chain` precomputes every part's operands, and widen its type hint:

```python
def compile_row(node: N.Compare | N.Cross | N.Chain, candles, resolution, htf) -> CompiledRow:
    cache: dict[int, list[float | None]] = {}
    if isinstance(node, N.Chain):
        subs = [operand for p in node.parts for operand in (p.left, p.right)]
    elif isinstance(node, N.Compare):
        subs = [node.left, node.right]
    else:
        subs = [node.a, node.b]
    for sub in subs:
        _precompute(sub, candles, resolution, htf, cache)
    return CompiledRow(node, candles, resolution, htf, warmup_bars(node), cache)
```

Note: `warmup_bars(node)` on a `Chain` is handled in Task 4. Until then this line still runs — `warmup_bars` falls through to `return 0` for an unknown node, which is harmless for these evaluate tests (warmup only trims leading bars in the strategy runner, not in `compile_row`/`evaluate`). Task 4 makes it correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_evaluate_chain.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_evaluate_chain.py
git commit -m "feat(expr): evaluate a Chain as AND of its links"
```

---

### Task 3: Closeness (heatmap) for a `Chain`

**Files:**
- Modify: `backend/auto_trader/strategy/expr/closeness.py:112-145`
- Test: `backend/tests/test_expr_closeness.py` (append)

**Interfaces:**
- Consumes: `N.Chain`.
- Produces: `row_closeness(chain, ...)` returns the per-bar `min` of each part's `row_closeness`, None-poisoned. A shared `_fold` helper is used by both `row_closeness(Chain)` and `group_closeness`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_closeness.py`:

```python
def test_chain_closeness_is_min_of_link_closeness():
    candles = [_c(c, i) for i, c in enumerate([90, 95, 100, 105, 110, 100])]
    close = N.Candle("close", 0, 0)
    p1 = N.Compare(">", close, N.Num(108, 0, 0), 0, 0)
    p2 = N.Compare(">", close, N.Num(100, 0, 0), 0, 0)
    chain = N.Chain([p1, p2], 0, 0)
    norm = Norm(basis="volatility", width=5.0, window=2, atr_length=14)
    out = row_closeness(chain, candles, "MINUTE", {}, norm)
    c1 = row_closeness(p1, candles, "MINUTE", {}, norm)
    c2 = row_closeness(p2, candles, "MINUTE", {}, norm)
    for i in range(len(candles)):
        if c1[i] is None or c2[i] is None:
            assert out[i] is None
        else:
            assert out[i] == min(c1[i], c2[i])
```

Add `from auto_trader.strategy.expr import nodes as N` to the test file's imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_closeness.py::test_chain_closeness_is_min_of_link_closeness -v`
Expected: FAIL — `row_gap_series` is called on a `Chain` and reads `node.left` / `node.a`, raising `AttributeError`.

- [ ] **Step 3: Handle `Chain` in `row_closeness`, factor the fold**

In `closeness.py`, add a module-level fold helper (place it above `group_closeness`):

```python
def _fold(per: list[list[float | None]], combine: str, n: int) -> list[float | None]:
    """Combine per-row closeness by fuzzy logic: AND -> min, OR -> max. Any
    undefined row poisons the bar."""
    reduce = min if combine == "AND" else max
    out: list[float | None] = []
    for i in range(n):
        vals = [p[i] for p in per]
        out.append(None if any(v is None for v in vals) else reduce(vals))
    return out
```

Widen `row_closeness`'s type hint (line 113) to `N.Compare | N.Cross | N.Chain` and dispatch `Chain` first:

```python
def row_closeness(
    node: N.Compare | N.Cross | N.Chain,
    candles: Sequence[Candle],
    resolution: str,
    htf: dict[str, list[Candle]],
    norm: Norm,
) -> list[float | None]:
    if isinstance(node, N.Chain):
        per = [row_closeness(p, candles, resolution, htf, norm) for p in node.parts]
        return _fold(per, "AND", len(candles))
    gaps = row_gap_series(node, candles, resolution, htf)
    atr = atr_series(candles, norm.atr_length) if norm.basis == "atr" else None
    scale = scale_series(gaps, norm.basis, norm.width, norm.window, atr)
    return [ramp(gaps[i], scale[i]) for i in range(len(gaps))]
```

Rewrite `group_closeness`'s fold body (lines 139-144) to reuse `_fold`, and widen its `rows` type hint to `list[N.Compare | N.Cross | N.Chain]`:

```python
    per = [row_closeness(r, candles, resolution, htf, norm) for r in rows]
    return _fold(per, combine, n)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_closeness.py -v`
Expected: PASS (all closeness tests, including the new one and the untouched group-fold tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/closeness.py backend/tests/test_expr_closeness.py
git commit -m "feat(expr): chain closeness = min-fold of link closeness"
```

---

### Task 4: Validate and warmup for a `Chain`

**Files:**
- Modify: `backend/auto_trader/strategy/expr/validate.py:8-14,68`
- Modify: `backend/auto_trader/strategy/expr/warmup.py:7-11`
- Test: `backend/tests/test_expr_chain_static.py` (create)

**Interfaces:**
- Consumes: `N.Chain`.
- Produces: `validate(chain, is_exit=...)` walks every part's operands and raises the existing errors; `warmup_bars(chain)` = max over parts.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_chain_static.py`:

```python
import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def test_validate_walks_all_chain_parts():
    close = N.Candle("close", 0, 5)
    # second link has a bad candle field (candle with no field)
    bad = N.Candle(None, 8, 14)
    chain = N.Chain([_cmp(">", close, N.Num(1, 0, 0)), _cmp(">", close, bad)], 0, 14)
    with pytest.raises(ExprError) as e:
        validate(chain, is_exit=False)
    assert e.value.code == "bad_candle_field"


def test_validate_accepts_valid_chain():
    close = N.Candle("close", 0, 5)
    e9 = N.Call("EMA", [N.Num(9, 0, 0)], 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    validate(N.Chain([_cmp(">", close, e9), _cmp(">", e9, e50)], 0, 0), is_exit=False)


def test_warmup_is_max_over_chain_parts():
    close = N.Candle("close", 0, 0)
    e9 = N.Call("EMA", [N.Num(9, 0, 0)], 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    chain = N.Chain([_cmp(">", close, e9), _cmp(">", e9, e50)], 0, 0)
    assert warmup_bars(chain) == 50
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_chain_static.py -v`
Expected: FAIL — `validate` reads `node.left` on a `Chain` (`AttributeError`); `warmup_bars` returns 0.

- [ ] **Step 3: Handle `Chain` in validate and warmup**

In `validate.py`, widen the `validate` signature (line 8) to `N.Compare | N.Cross | N.Chain` and add the `Chain` branch at the top of the function:

```python
def validate(node: N.Compare | N.Cross | N.Chain, *, is_exit: bool) -> None:
    if isinstance(node, N.Chain):
        for p in node.parts:
            _walk(p.left, is_exit=is_exit)
            _walk(p.right, is_exit=is_exit)
        return
    if isinstance(node, N.Cross):
        _walk(node.a, is_exit=is_exit)
        _walk(node.b, is_exit=is_exit)
        return
    _walk(node.left, is_exit=is_exit)
    _walk(node.right, is_exit=is_exit)
```

Extend the nested-comparison guard in `_walk` (line 68) to also reject a `Chain` reached as a sub-node (defensive; the parser never nests one):

```python
    if isinstance(node, (N.Compare, N.Cross, N.Chain)):
        raise ExprError("cross_not_toplevel", "A comparison or cross can only be the whole row.", node.start, node.end)
```

In `warmup.py`, add the `Chain` case at the top of `warmup_bars` (before the `Compare` case, line 8):

```python
    if isinstance(node, N.Chain):
        return max(warmup_bars(p) for p in node.parts)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_chain_static.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/validate.py backend/auto_trader/strategy/expr/warmup.py backend/tests/test_expr_chain_static.py
git commit -m "feat(expr): validate and warmup a Chain"
```

---

### Task 5: Literals and substitution for a `Chain` (sweeps)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/literals.py:111-164`
- Test: `backend/tests/test_expr_chain_literals.py` (create)

**Interfaces:**
- Consumes: `N.Chain`.
- Produces: `literals(chain)` extracts each operand's literals once (shared middle operands are not double-counted); `substitute(chain, overrides)` rewrites literals in every part.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_chain_literals.py`:

```python
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.literals import literals, substitute


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def _chain_src():
    # close > EMA(9) > EMA(50): spans chosen so starts are strictly increasing
    close = N.Candle("close", 0, 12)
    e9 = N.Call("EMA", [N.Num(9, 20, 21)], 16, 22)
    e50 = N.Call("EMA", [N.Num(50, 30, 32)], 25, 33)
    p1 = _cmp(">", close, e9)
    p2 = _cmp(">", e9, e50)  # e9 shared with p1
    return N.Chain([p1, p2], 0, 33), (e9, e50)


def test_literals_extracts_each_operand_once():
    chain, _ = _chain_src()
    lits = literals(chain)
    # EMA(9) is shared between the two links but must appear once
    assert [lit.value for lit in lits] == [9, 50]
    assert [lit.ordinal for lit in lits] == [0, 1]


def test_substitute_rewrites_literals_in_all_links():
    chain, _ = _chain_src()
    out = substitute(chain, {0: 21.0, 1: 55.0})
    # the shared EMA(9) becomes EMA(21) in both links (same node object)
    assert out.parts[0].right.args[0].value == 21.0
    assert out.parts[1].left.args[0].value == 21.0
    assert out.parts[1].right.args[0].value == 55.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_chain_literals.py -v`
Expected: FAIL — `literals` reads `node.left`/`node.a` on a `Chain` (`AttributeError`).

- [ ] **Step 3: Handle `Chain` in `literals` and `substitute`**

In `literals.py`, widen the `literals` signature (line 111) to `N.Compare | N.Cross | N.Chain` and add a `Chain` branch that collects the first part's left, then each part's right (so each distinct operand is collected exactly once):

```python
def literals(node: N.Compare | N.Cross | N.Chain) -> list[Literal]:
    out: list[tuple[N.Num, str]] = []
    if isinstance(node, N.Chain):
        _collect_side(node.parts[0].left, out)
        for p in node.parts:
            _collect_side(p.right, out)
    elif isinstance(node, N.Compare):
        _collect_side(node.left, out)
        _collect_side(node.right, out)
    else:
        _collect(node.a, "constant", out)
        _collect(node.b, "constant", out)
    out.sort(key=lambda pair: pair[0].start)
    return [Literal(k, num.value, num.start, num.end, label) for k, (num, label) in enumerate(out)]
```

Widen `substitute`'s signature (line 131) to `N.Compare | N.Cross | N.Chain` and add a `Chain` case to the inner `rewrite` (before `return n`):

```python
        if isinstance(n, N.Chain):
            return dataclasses.replace(n, parts=[rewrite(p) for p in n.parts])
```

Note on the shared operand: `rewrite` on the shared middle operand runs twice (once via each adjacent part), but both rewrites key off the same `Num.start` in `by_pos`, so they produce the same value. The test asserts both links reflect the override.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_chain_literals.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/literals.py backend/tests/test_expr_chain_literals.py
git commit -m "feat(expr): literals and substitution for a Chain"
```

---

### Task 6: Router support (`_referenced_tfs` + series plot)

**Files:**
- Modify: `backend/auto_trader/api/routers/expr.py:260-262,272-284`
- Test: `backend/tests/test_expr_router_chain.py` (create)

**Interfaces:**
- Consumes: `N.Chain`.
- Produces: `_referenced_tfs(chain)` unions the referenced timeframes across all parts; the series-plot endpoint plots `chain.parts[0].left`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_router_chain.py`:

```python
from auto_trader.api.routers.expr import _referenced_tfs
from auto_trader.strategy.expr import nodes as N


def _cmp(op, a, b):
    return N.Compare(op, a, b, 0, 0)


def test_referenced_tfs_unions_across_chain_parts():
    close = N.Candle("close", 0, 0)
    e9_d = N.Tf(N.Call("EMA", [N.Num(9, 0, 0)], 0, 0), "D", 0, 0)
    e50_h = N.Tf(N.Call("EMA", [N.Num(50, 0, 0)], 0, 0), "H", 0, 0)
    chain = N.Chain([_cmp(">", close, e9_d), _cmp(">", e9_d, e50_h)], 0, 0)
    assert _referenced_tfs(chain) == {"D", "H"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_router_chain.py -v`
Expected: FAIL — `_referenced_tfs` falls through to `return set()` for a `Chain` (returns `set()`, not `{"D","H"}`).

- [ ] **Step 3: Handle `Chain` in the router**

In `routers/expr.py`, add a `Chain` branch to `_referenced_tfs` (after the `Tf` branch, around line 275):

```python
    if isinstance(node, N.Chain):
        return set().union(*(_referenced_tfs(p) for p in node.parts))
```

In the `/api/expr/series` handler, replace the plot-operand pick (line 260) so a `Chain` plots its first link's left operand:

```python
    if isinstance(node, N.Chain):
        top = node.parts[0].left
    else:
        top = node.left if hasattr(node, "left") else node.a
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_expr_router_chain.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/expr.py backend/tests/test_expr_router_chain.py
git commit -m "feat(expr): router tf-walk and series-plot for a Chain"
```

---

### Task 7: Parser emits `Chain` (backend) + end-to-end regression

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py:28-47,144-145`
- Test: `backend/tests/test_expr_parser_chain.py` (create)

**Interfaces:**
- Consumes: all consumer handling from Tasks 1-6.
- Produces: `parse("a>b>c")` returns `N.Chain`; `parse("a>b")` returns `N.Compare` (unchanged); `parse()`'s return type is `N.Compare | N.Cross | N.Chain`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_expr_parser_chain.py`:

```python
import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_single_comparison_stays_compare():
    assert isinstance(parse("candle.close > 100"), N.Compare)


def test_two_links_become_chain_sharing_middle_operand():
    node = parse("candle.close > EMA(9) > EMA(50)")
    assert isinstance(node, N.Chain)
    assert len(node.parts) == 2
    assert node.parts[0].op == ">" and node.parts[1].op == ">"
    # middle operand (EMA(9)) is the same object in both links
    assert node.parts[0].right is node.parts[1].left


def test_mixed_operators_are_allowed():
    node = parse("candle.close > EMA(9) < EMA(50)")
    assert isinstance(node, N.Chain)
    assert [p.op for p in node.parts] == [">", "<"]


def test_trailing_operator_still_errors():
    with pytest.raises(ExprError):
        parse("candle.close > EMA(9) >")


def test_cross_is_not_chained():
    assert isinstance(parse("crossAbove(candle.close, EMA(9))"), N.Cross)


def test_original_failing_rule_now_parses_and_validates():
    node = parse("candle.close>EMA(9)>EMA(50)")
    validate(node, is_exit=False)  # no raise
    assert isinstance(node, N.Chain)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_parser_chain.py -v`
Expected: FAIL — the two-link cases raise `ExprError("unexpected_token", "Expected eof here.")` (current behavior).

- [ ] **Step 3: Make the parser loop over comparison operators**

In `parser.py`, replace the tail of `parse_row` (lines 39-47, the part after the cross branch) with a loop:

```python
        left = self.parse_arith()
        op = self.peek()
        if op.type not in ("GT", "LT", "GE", "LE"):
            raise ExprError("expected_operator", "Expected a comparison operator (> < >= <=).", op.start, op.end)
        sym_of = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<="}
        parts: list[N.Compare] = []
        operand = left
        while self.peek().type in ("GT", "LT", "GE", "LE"):
            optok = self.next()
            right = self.parse_arith()
            parts.append(N.Compare(sym_of[optok.type], operand, right, operand.start, right.end))
            operand = right
        self.expect("EOF")
        if len(parts) == 1:
            return parts[0]
        return N.Chain(parts, parts[0].start, parts[-1].end)
```

Widen the return-type hints of `parse_row` (line 28) and `parse` (line 144) to `N.Compare | N.Cross | N.Chain`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_parser_chain.py -v`
Expected: PASS (6 tests).

Then run the full expr suite to confirm no regression across every consumer now that the parser emits `Chain`:

Run: `cd backend && python -m pytest tests/ -k expr -q`
Expected: PASS (all expr tests green).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/parser.py backend/tests/test_expr_parser_chain.py
git commit -m "feat(expr): parse chained comparisons into a Chain"
```

---

### Task 8: Frontend editor mirror

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts:80-97,191-213,337-345,541-558,603-642`
- Test: `frontend/src/lib/expr/parser.test.ts` (append)

**Interfaces:**
- Consumes: nothing from the backend at runtime; this is the editor's advisory parser, kept in sync so a valid chained expression is not red-underlined.
- Produces: `analyze("a>b>c")` returns no error and the chained literals; `warmupOf` maxes over the chain.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/expr/parser.test.ts`:

```ts
describe("chained comparisons", () => {
  it("accepts a chain without a diagnostic", () => {
    const res = analyze("candle.close > EMA(9) > EMA(50)");
    expect(res.error).toBeNull();
  });

  it("still flags a single-comparison typo", () => {
    const res = analyze("candle.close > EMA(9) >");
    expect(res.error).not.toBeNull();
  });

  it("accepts a mixed-operator chain", () => {
    expect(analyze("candle.close > EMA(9) < EMA(50)").error).toBeNull();
  });

  it("extracts each chain operand's literals once", () => {
    const res = analyze("candle.close > EMA(9) > EMA(50)");
    expect(res.literals.map((l) => l.value)).toEqual([9, 50]);
  });

  it("warms up to the largest link", () => {
    expect(warmupOf("candle.close > EMA(9) > EMA(50)")).toBe(50);
  });
});
```

Confirm `analyze` and `warmupOf` are imported at the top of the test file (they are already used by existing tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: FAIL — the chain cases produce an `unexpected_token` error ("Expected eof here.").

- [ ] **Step 3: Mirror the `Chain` handling**

In `parser.ts`:

Add the node interface after `CrossNode` (line 81) and extend the `Row` union (line 87):

```ts
interface ChainNode { kind: "Chain"; parts: CompareNode[]; start: number; end: number; }

type Row = CompareNode | CrossNode | ChainNode;
```

Rewrite `parseRow`'s tail (lines 203-212) to loop over comparison operators:

```ts
    const left = this.parseArith();
    const op = this.peek();
    if (op.type !== "GT" && op.type !== "LT" && op.type !== "GE" && op.type !== "LE") {
      throw new ExprErr("expected_operator", "Expected a comparison operator (> < >= <=).", op.start, op.end);
    }
    const symOf: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=" };
    const parts: CompareNode[] = [];
    let operand: Node = left;
    while (["GT", "LT", "GE", "LE"].includes(this.peek().type)) {
      const optok = this.next();
      const right = this.parseArith();
      parts.push({ kind: "Compare", op: symOf[optok.type], left: operand, right, start: operand.start, end: right.end });
      operand = right;
    }
    this.expect("EOF");
    if (parts.length === 1) return parts[0];
    return { kind: "Chain", parts, start: parts[0].start, end: parts[parts.length - 1].end };
```

Add a `Chain` branch at the top of `validate` (line 337):

```ts
function validate(node: Row, isExit: boolean): void {
  if (node.kind === "Chain") {
    for (const p of node.parts) {
      walk(p.left, isExit);
      walk(p.right, isExit);
    }
    return;
  }
  if (node.kind === "Cross") {
    walk(node.a, isExit);
    walk(node.b, isExit);
    return;
  }
  walk(node.left, isExit);
  walk(node.right, isExit);
}
```

Add a `Chain` branch to `literalsOf` (line 541), collecting the first part's left then each part's right (each operand once):

```ts
function literalsOf(node: Row): LiteralSpan[] {
  const out: Collected[] = [];
  if (node.kind === "Chain") {
    collectSide(node.parts[0].left, out);
    for (const p of node.parts) collectSide(p.right, out);
  } else if (node.kind === "Compare") {
    collectSide(node.left, out);
    collectSide(node.right, out);
  } else {
    collect(node.a, "constant", out);
    collect(node.b, "constant", out);
  }
  out.sort((x, y) => x.num.start - y.num.start);
  return out.map((c, ordinal) => ({
    ordinal,
    value: c.num.value,
    from: c.num.start,
    to: c.num.end,
    label: c.label,
  }));
}
```

Handle `Chain` in `warmupNode` — widen its parameter type to `Node | ChainNode` and add the case (line 618):

```ts
function warmupNode(node: Node | ChainNode): number {
  switch (node.kind) {
    case "Chain": return Math.max(...node.parts.map(warmupNode));
    case "Compare": return Math.max(warmupNode(node.left), warmupNode(node.right));
```

(The remaining cases are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: PASS (existing tests plus the 5 new ones).

Then typecheck to confirm the widened unions are consistent:

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): mirror Chain in the frontend editor parser"
```

---

## Post-plan verification

After Task 8, verify end-to-end against the running app: enter `candle.close > EMA(9) > EMA(50)` as an entry rule, confirm the editor shows no error, run the heatmap on it, and confirm the closeness endpoint returns values (no 422). This is the original failing rule from the report.
