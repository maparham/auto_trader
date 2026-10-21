# Screener Part A (condition screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Screener side panel that judges a rule expression on the last closed bar of every symbol in a saved list and shows the matches.

**Architecture:** `abs()` joins the rule language on both stacks. A pure evaluator (`core/screen_eval.py`) judges one symbol's candles; a store (`core/screen_store.py`) keeps saved screens per user; an in-memory runner (`api/screen_jobs.py`) fetches candles through the shared candle cache with a per-broker cap and evaluates in threads; `api/routers/screens.py` exposes CRUD, run, poll and cancel. The frontend adds `lib/screens.ts` (client) and `ScreenerPanel.tsx`, docked through the existing side-panel registry.

**Tech Stack:** Python 3.14, FastAPI, sqlite3, pytest (backend); React + TypeScript, vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-21-screener-design.md` (Part A).

## Global Constraints

- Indicators are uppercase (`EMA`, `RSI`, `ATR`), candle fields use the `candle.` prefix; every example and test uses real syntax.
- Screens judge the last CLOSED bar only; the forming bar is dropped.
- `@tf` pins and chart-pane references (`RSI.bullDiv`) are refused in screens with a 422 (spec Part A has no chart panes and no HTF fetch).
- One run per user at a time (409 on a second). Per-broker concurrency cap 4, shared across users.
- Per-symbol failures go to `skipped` with a reason, never fail the run.
- UI text: no em dashes, no `--`; tooltips via `Tooltip`/`InfoTip`, never `title=`; tip text is short lines (`string[]`); muted gray toggle states, not solid accent.
- Frontend tests: run only the affected files (`npx vitest run <files>`), never the whole suite. Typecheck is `npx tsc -b` (ask the user before running it, it is CPU-heavy).
- Commit to the current branch (`main`); stage by explicit path; never stash, clean or restore.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A symbol whose broker returns fewer closed bars than the expression's warm-up: skipped with "not enough history", not judged on a half-warm EMA. (Task 3 test `test_short_history_is_skipped`.)
2. Running a screen at the moment a bar is still forming: the forming bar must not be judged. (Task 3 test `test_forming_bar_is_dropped`.)
3. One broker erroring for one symbol mid-run: the other symbols still finish. (Task 5 test `test_one_symbol_error_does_not_fail_run`.)
4. A user editing the expression into a value (`RSI(14)`) or a pinned term (`EMA(9)@D`) and pressing Run: a 422 with span, shown inline, no job started. (Task 3 tests `test_value_expression_rejected`, `test_tf_pin_rejected`; Task 6 test `test_run_bad_expression_422`.)
5. A column expression that divides by zero or reads an undefined indicator value: the cell shows "n/a", the row still shows. (Task 3 test `test_column_undefined_is_none`.)

---

### Task 1: `abs()` in the backend rule language

**Files:**
- Modify: `backend/auto_trader/strategy/expr/registry.py`
- Modify: `backend/auto_trader/strategy/expr/parser.py` (the `is_ref` check in `parse_postfix`, ~line 236)
- Modify: `backend/auto_trader/strategy/expr/validate.py` (`_walk`, Call branch ~line 252)
- Modify: `backend/auto_trader/strategy/expr/evaluate.py` (`series_of` Call branch ~line 357, `CompiledRow._val` ~line 423)
- Modify: `backend/auto_trader/strategy/expr/warmup.py` (Call branch ~line 88)
- Modify: `backend/auto_trader/strategy/expr/literals.py` (`_collect` Call branch ~line 113)
- Test: `backend/tests/test_expr_abs.py`

**Interfaces:**
- Produces: `registry.FUNCS: dict[str, int]` = `{"abs": 1}` (name to arity). Later tasks only use `abs` through expressions.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_expr_abs.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(time=t0 + timedelta(hours=k), open=c, high=c, low=c, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def _bools(src, closes, entry=None):
    node = parse(src)
    validate(node, is_exit=entry is not None)
    row = compile_row(node, _candles(closes), "HOUR", {})
    return [row.evaluate(i, entry) for i in range(len(closes))]


def test_abs_of_negative_difference():
    # close - 10 is -2 then +2; abs is 2 both times.
    assert _bools("abs(candle.close - 10) == 2", [8, 12]) == [True, True]


def test_abs_with_entry_in_exit_rule():
    # entry-bearing abs goes through the per-bar path, not the precompute.
    assert _bools("abs(candle.close - entry) > 1", [10, 10.5, 12], entry=10.0) == [False, False, True]


def test_abs_wraps_indicator_and_warms_up():
    node = parse("abs(candle.close - EMA(3)) < 100")
    assert warmup_bars(node, "HOUR") == 3


def test_abs_arity():
    with pytest.raises(ExprError) as e:
        validate(parse("abs(candle.close, 2) > 1"), is_exit=False)
    assert e.value.code == "bad_arity"


def test_abs_is_not_an_instance_ref():
    with pytest.raises(ExprError) as e:
        validate(parse("abs.x > 1"), is_exit=False)
    assert e.value.code != "unknown_indicator_ref"


def test_abs_literals_recurse_into_argument():
    lits = literals(parse("abs(candle.close - EMA(200)) < 2 * ATR(14)"))
    assert [(l.value, l.label) for l in lits] == [
        (200, "EMA length"), (2, "multiplier of ATR(14)"), (14, "ATR length"),
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_expr_abs.py -q`
Expected: FAIL (`Unknown name abs.` from validate).

- [ ] **Step 3: Implement**

`registry.py`, after `WRAPPERS`:

```python
# Plain math functions: pointwise over their argument, no window, and (unlike
# WRAPPERS) legal around entry-based values, so `abs(candle.close - entry)`
# works in an exit rule.
FUNCS: dict[str, int] = {"abs": 1}
```

`parser.py`: import `FUNCS` beside `INDICATORS, WRAPPERS`, and in the `is_ref` expression add a line after `and node.name not in WRAPPERS`:

```python
                    and node.name not in FUNCS
```

`validate.py`: import `FUNCS`; in `_walk`'s `if isinstance(node, N.Call):` block, insert before the `if node.name in WRAPPERS:` branch:

```python
        if node.name in FUNCS:
            if len(node.args) != FUNCS[node.name]:
                raise ExprError("bad_arity", f"{node.name} takes {FUNCS[node.name]} argument(s).", node.start, node.end)
            for a in node.args:
                _walk(a, is_exit=is_exit, instances=instances)
            return
```

Also add `FUNCS` to the field-on-call set at ~line 172: `root.name in {*INDICATORS, *WRAPPERS, *FUNCS}`.

`evaluate.py`: import `FUNCS` from the registry. In `series_of`'s `if isinstance(node, N.Call):` branch, first line:

```python
        if node.name in FUNCS:  # abs: pointwise
            inner = series_of(node.args[0], candles, resolution, htf, instances)
            return [None if v is None else abs(v) for v in inner]
```

In `CompiledRow._val`, before the final `# Any remaining node is entry-free` fallback:

```python
        if isinstance(sub, N.Call) and sub.name in FUNCS:
            v = self._val(sub.args[0], i, entry, entry_i)
            return None if v is None else abs(v)
```

`warmup.py`: import `FUNCS`; in the Call branch, first line:

```python
        if node.name in FUNCS:
            return max((warmup_bars(a, resolution, instances) for a in node.args), default=0)
```

`literals.py`: import `FUNCS`; in `_collect`'s Call branch, before `if node.name in WRAPPERS:`:

```python
        if node.name in FUNCS:
            for a in node.args:
                _collect(a, label, out)
            return
```

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_expr_abs.py tests/test_expr_validate.py tests/test_expr_evaluate.py tests/test_expr_warmup.py -q`
Expected: PASS. If `test_abs_literals_recurse_into_argument` shows a different label for `2`, read `literals.py`'s Binary branch and match the label it actually produces for `2 * ATR(14)` elsewhere in `corpus.json` (search `multiplier of ATR(14)`); the expected list must mirror existing corpus labels.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/registry.py backend/auto_trader/strategy/expr/parser.py backend/auto_trader/strategy/expr/validate.py backend/auto_trader/strategy/expr/evaluate.py backend/auto_trader/strategy/expr/warmup.py backend/auto_trader/strategy/expr/literals.py backend/tests/test_expr_abs.py
git commit -m "feat(expr): abs() in the backend rule language"
```

---

### Task 2: `abs()` in the frontend rule language + parity corpus

**Files:**
- Modify: `frontend/src/lib/expr/catalog.ts`
- Modify: `frontend/src/lib/expr/parser.ts` (isRef ~line 552, field_on_call ~line 758, walk Call ~line 845, collect Call ~line 1011, warmupNode Call ~line 1272)
- Modify: `frontend/src/lib/expr/highlight.ts` (~lines 65 and 100)
- Modify: `frontend/src/lib/expr/complete.ts` (~line 120)
- Modify: `frontend/src/lib/expr/corpus.json`
- Test: `frontend/src/lib/expr/corpus.test.ts` (existing), `backend/tests/test_expr_parser_corpus.py` (existing)

**Interfaces:**
- Consumes: backend `FUNCS` from Task 1 (parity).
- Produces: `catalog.FUNC_ARITY: Record<string, number>` and `catalog.FUNCS: CatalogEntry[]`.

- [ ] **Step 1: Add corpus rows (the failing test)**

Append to the array in `corpus.json` (keep the file's one-object-per-entry style):

```json
  { "expr": "abs(candle.close - EMA(200)) < 2 * ATR(14)", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":200,"from":23,"to":26,"label":"EMA length"},
      {"ordinal":1,"value":2,"from":31,"to":32,"label":"multiplier of ATR(14)"},
      {"ordinal":2,"value":14,"from":39,"to":41,"label":"ATR length"}
    ] },
  { "expr": "abs(candle.close, 2) > 1", "isExit": false,
    "error": {"code":"bad_arity","from":0,"to":20}, "literals": [] },
  { "expr": "abs(candle.close - entry) > 1", "isExit": true, "error": null,
    "literals": [
      {"ordinal":0,"value":1,"from":28,"to":29,"label":"threshold"}
    ] }
```

Check the spans by counting characters (0-based, `to` exclusive). If the backend run in Step 2 reports different literal labels or spans, the backend is the source of truth: copy its values into the rows.

- [ ] **Step 2: Run both corpus tests to verify the frontend fails**

Run: `cd backend && uv run pytest tests/test_expr_parser_corpus.py -q` (Expected: PASS, backend already has abs)
Run: `cd frontend && npx vitest run src/lib/expr/corpus.test.ts` (Expected: FAIL on the three abs rows, `unknown_name`)

- [ ] **Step 3: Implement**

`catalog.ts`, after `WRAPPERS`:

```ts
// Plain math functions (backend registry.FUNCS): pointwise, no window, legal
// around entry-based values.
export const FUNCS: CatalogEntry[] = [
  { name: "abs", insert: "abs(candle.close - EMA(200))", signature: "abs(x)", detail: "Absolute value" },
];
```

after `WRAPPER_ARITY`:

```ts
export const FUNC_ARITY: Record<string, number> = {
  abs: 1,
};
```

`parser.ts`: import `FUNC_ARITY`. In the `isRef` expression add `&& !Object.hasOwn(FUNC_ARITY, node.name)` after the WRAPPER_ARITY line. In the field_on_call check add `|| Object.hasOwn(FUNC_ARITY, root.name)`. In `walk`'s `case "Call":`, before the `WRAPPER_ARITY` branch:

```ts
      if (Object.hasOwn(FUNC_ARITY, node.name)) {
        const arity = FUNC_ARITY[node.name];
        if (node.args.length !== arity) {
          throw new ExprErr("bad_arity", `${node.name} takes ${arity} argument(s).`, node.start, node.end);
        }
        for (const a of node.args) walk(a, isExit, instances);
        return;
      }
```

In `collect`'s `if (node.kind === "Call")` block, first:

```ts
    if (Object.hasOwn(FUNC_ARITY, node.name)) {
      for (const a of node.args) collect(a, label, out);
      return;
    }
```

In `warmupNode`'s `case "Call":`, first:

```ts
      if (Object.hasOwn(FUNC_ARITY, node.name)) {
        return Math.max(0, ...node.args.map((a) => warmupNode(a, baseSeconds, refs)));
      }
```

`highlight.ts`: import `FUNC_ARITY`; in `isInstanceRef` add `&& !Object.hasOwn(FUNC_ARITY, value)`; in the classifier add `if (Object.hasOwn(FUNC_ARITY, value)) return "wrapper";` after the WRAPPER_ARITY line.

`complete.ts`: import `FUNCS` and add `...FUNCS.map((e) => fnCandidate(e, "wrapper")),` after the WRAPPERS line in `WORD_CANDIDATES`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/expr/corpus.test.ts src/lib/expr/parser.test.ts src/lib/expr/highlight.test.ts src/lib/expr/complete.test.ts`
Run: `cd backend && uv run pytest tests/test_expr_parser_corpus.py -q`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/parser.ts frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/complete.ts frontend/src/lib/expr/corpus.json
git commit -m "feat(expr): abs() in the editor, with parity corpus rows"
```

---

### Task 3: Screen evaluator (pure)

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py` (add `parse_value`)
- Create: `backend/auto_trader/core/screen_eval.py`
- Test: `backend/tests/test_screen_eval.py`

**Interfaces:**
- Consumes: `parse`, `validate`, `compile_row`, `series_of`, `warmup_bars`, `referenced_tfs` (`api/sweep_apply.py:123`).
- Produces:
  - `parser.parse_value(src: str) -> N.Node` (an arithmetic expression, EOF-terminated).
  - `screen_eval.ScreenSpecError(field: str, index: int, err: ExprError)`, raised by `compile_screen`.
  - `screen_eval.CompiledScreen` (frozen dataclass: `row: N.Row`, `source: str`, `columns: list[tuple[str, N.Node]]`, `warmup: int`).
  - `screen_eval.compile_screen(expression: str, columns: list[dict]) -> CompiledScreen` (`columns` items are `{"name": str, "expression": str}`).
  - `screen_eval.closed_bars(bars: list[Candle], res_seconds: int, now: float) -> list[Candle]`.
  - `screen_eval.judge(cs: CompiledScreen, bars: list[Candle], resolution: str) -> Judgement` where `Judgement` is a frozen dataclass `(matched: bool, bar_time_ms: int | None, columns: dict[str, float | None], skip_reason: str | None)`.
  - `screen_eval.bars_needed(cs: CompiledScreen) -> int`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_screen_eval.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import (
    ScreenSpecError, bars_needed, closed_bars, compile_screen, judge,
)

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _bars(closes, step_s=3600):
    return [Candle(time=T0 + timedelta(seconds=step_s * k), open=c, high=c + 1, low=c - 1, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def test_match_on_last_bar():
    cs = compile_screen("candle.close > 10", [])
    j = judge(cs, _bars([5, 5, 11]), "HOUR")
    assert j.matched and j.skip_reason is None
    assert j.bar_time_ms == int((T0 + timedelta(hours=2)).timestamp() * 1000)


def test_no_match_when_only_earlier_bar_matched():
    cs = compile_screen("candle.close > 10", [])
    assert not judge(cs, _bars([11, 5]), "HOUR").matched


def test_count_window_catches_recent_fire():
    cs = compile_screen("count(candle.close > 10, 3) >= 1", [])
    assert judge(cs, _bars([5, 5, 5, 11, 5, 5]), "HOUR").matched


def test_short_history_is_skipped():
    cs = compile_screen("candle.close > EMA(20)", [])
    j = judge(cs, _bars([1.0] * 10), "HOUR")
    assert not j.matched and j.skip_reason == "not enough history"


def test_forming_bar_is_dropped():
    bars = _bars([1, 2, 3])  # last bar opens at T0+2h
    now = (T0 + timedelta(hours=2, minutes=30)).timestamp()
    assert [b.close for b in closed_bars(bars, 3600, now)] == [1, 2]
    now_closed = (T0 + timedelta(hours=3)).timestamp()
    assert len(closed_bars(bars, 3600, now_closed)) == 3


def test_columns_evaluated_on_matched_bar():
    cs = compile_screen("candle.close > 0", [{"name": "Dist", "expression": "abs(candle.close - 10)"}])
    j = judge(cs, _bars([3, 7]), "HOUR")
    assert j.columns == {"Dist": 3.0}


def test_column_undefined_is_none():
    cs = compile_screen("candle.close > 0", [{"name": "Ratio", "expression": "candle.close / (candle.close - candle.close)"}])
    j = judge(cs, _bars([3, 7]), "HOUR")
    assert j.matched and j.columns["Ratio"] is None


def test_value_expression_rejected():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("RSI(14)", [])
    assert e.value.field == "expression"


def test_tf_pin_rejected():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > EMA(9)@D", [])
    assert e.value.err.code == "screen_tf_unsupported"


def test_bad_column_names_its_index():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > 0", [{"name": "ok", "expression": "1"}, {"name": "bad", "expression": "FOO(1)"}])
    assert (e.value.field, e.value.index) == ("columns", 1)


def test_bars_needed_covers_warmup():
    cs = compile_screen("candle.close > EMA(200)", [{"name": "R", "expression": "RSI(14)"}])
    assert bars_needed(cs) >= 201
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_screen_eval.py -q`
Expected: FAIL (`ModuleNotFoundError: auto_trader.core.screen_eval`).

- [ ] **Step 3: Implement**

`parser.py`, after `parse`:

```python
def parse_value(src: str) -> N.Node:
    """A bare arithmetic expression (a screen column like `RSI(14)`), not a
    condition. Same grammar as an operand of a comparison."""
    p = _Parser(tokenize(src))
    node = p.parse_arith()
    p.expect("EOF")
    return node
```

`backend/auto_trader/core/screen_eval.py`:

```python
"""One symbol's verdict for a screen: compile the screen's condition and
columns once, then judge each symbol's candles on its last CLOSED bar.

Pure: no I/O. The runner (api/screen_jobs.py) fetches candles and hands them
here, which keeps this module testable with plain Candle lists.

Screens have no chart panes and fetch no higher timeframes, so `@tf` pins and
pane references are refused at compile time rather than misjudged."""

from __future__ import annotations

from dataclasses import dataclass

from auto_trader.api.sweep_apply import referenced_tfs
from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.parser import parse, parse_value
from auto_trader.strategy.expr.validate import _walk, validate
from auto_trader.strategy.expr.warmup import warmup_bars

# Extra closed bars beyond the warm-up, so an EMA is not judged on the very
# first bar it becomes defined.
_SLACK = 20
_MAX_BARS = 2000


class ScreenSpecError(Exception):
    """A screen's expression or one of its columns failed to parse/validate.
    `field` is "expression" or "columns"; `index` the column's position (0
    for the expression)."""

    def __init__(self, field: str, index: int, err: ExprError):
        super().__init__(err.message)
        self.field = field
        self.index = index
        self.err = err


@dataclass(frozen=True, slots=True)
class CompiledScreen:
    row: N.Row
    source: str
    columns: list[tuple[str, N.Node]]
    warmup: int


@dataclass(frozen=True, slots=True)
class Judgement:
    matched: bool
    bar_time_ms: int | None
    columns: dict[str, float | None]
    skip_reason: str | None


def _refuse_unsupported(node: N.Node, src: str) -> None:
    if referenced_tfs(node, None):
        raise ExprError("screen_tf_unsupported",
                        "Timeframe pins like @D are not available in screens yet.",
                        0, len(src))


def compile_screen(expression: str, columns: list[dict]) -> CompiledScreen:
    try:
        row = parse(expression)
        validate(row, is_exit=False)
        _refuse_unsupported(row, expression)
    except ExprError as e:
        raise ScreenSpecError("expression", 0, e) from e
    cols: list[tuple[str, N.Node]] = []
    for idx, col in enumerate(columns):
        src = col["expression"]
        try:
            node = parse_value(src)
            _walk(node, is_exit=False, instances=None)
            _refuse_unsupported(node, src)
        except ExprError as e:
            raise ScreenSpecError("columns", idx, e) from e
        cols.append((col["name"], node))
    warm = max([warmup_bars(row, None)] + [warmup_bars(n, None) for _, n in cols])
    return CompiledScreen(row, expression, cols, warm)


def bars_needed(cs: CompiledScreen) -> int:
    return min(_MAX_BARS, cs.warmup + 1 + _SLACK)


def closed_bars(bars: list[Candle], res_seconds: int, now: float) -> list[Candle]:
    """Drop the forming bar: a bar is closed once its open + one interval has
    passed."""
    if bars and bars[-1].time.timestamp() + res_seconds > now:
        return bars[:-1]
    return bars


def judge(cs: CompiledScreen, bars: list[Candle], resolution: str) -> Judgement:
    if len(bars) < cs.warmup + 1:
        return Judgement(False, None, {}, "not enough history")
    compiled = compile_row(cs.row, bars, resolution, {}, None, source=cs.source)
    last = len(bars) - 1
    matched = compiled.evaluate(last, None)
    bar_ms = int(bars[last].time.timestamp() * 1000)
    cols: dict[str, float | None] = {}
    if matched:
        for name, node in cs.columns:
            v = series_of(node, bars, resolution, {}, None)[last]
            cols[name] = None if v is None or v != v or v in (float("inf"), float("-inf")) else float(v)
    return Judgement(bool(matched), bar_ms, cols, None)
```

Note: `_walk` is validate's private value walker; importing it is the narrowest way to validate a value node. If a reviewer objects, add a public `validate_value(node)` wrapper in `validate.py` that calls `_walk(node, is_exit=False, instances=None)` and import that instead.

`warmup_bars(row, None)`: the second parameter is the resolution, `None` meaning "unknown"; it only matters for instance pins, which screens refuse.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_screen_eval.py tests/test_expr_abs.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/parser.py backend/auto_trader/core/screen_eval.py backend/tests/test_screen_eval.py
git commit -m "feat(screener): pure screen evaluator on the last closed bar"
```

---

### Task 4: Screen store

**Files:**
- Modify: `backend/auto_trader/config.py` (after `patterns_db_path`)
- Create: `backend/auto_trader/core/screen_store.py`
- Modify: `docs/superpowers/specs/2026-10-21-screener-design.md` (Storage: replace "`SCREEN_DB`" with "`settings.screens_db_path`, env `CAPITAL_SCREENS_DB_PATH`", matching the other stores)
- Test: `backend/tests/test_screen_store.py`

**Interfaces:**
- Produces: `screen_store.SCREEN_STORE: ScreenStore` with async methods
  - `list(user_id) -> list[dict]`
  - `get(user_id, screen_id) -> dict | None`
  - `create(user_id, data: dict) -> dict`
  - `update(user_id, screen_id, data: dict) -> dict | None`
  - `delete(user_id, screen_id) -> bool`
  - A screen dict is `{"id", "name", "broker", "resolution", "symbols": list[str], "expression", "columns": list[{"name","expression"}], "created_at", "updated_at"}`; `data` carries every field except id and the timestamps.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_screen_store.py`:

```python
import asyncio

import pytest

from auto_trader.core.screen_store import ScreenStore

DATA = {"name": "Oversold", "broker": "yfinance", "resolution": "DAY",
        "symbols": ["AAPL", "MSFT"], "expression": "RSI(14) < 30",
        "columns": [{"name": "RSI", "expression": "RSI(14)"}]}


@pytest.fixture
def store(tmp_path):
    return ScreenStore(str(tmp_path / "screens.db"))


def test_create_get_list(store):
    row = asyncio.run(store.create("u1", DATA))
    assert row["id"] and row["symbols"] == ["AAPL", "MSFT"]
    assert asyncio.run(store.get("u1", row["id"]))["columns"] == DATA["columns"]
    assert [r["id"] for r in asyncio.run(store.list("u1"))] == [row["id"]]


def test_user_isolation(store):
    row = asyncio.run(store.create("u1", DATA))
    assert asyncio.run(store.get("u2", row["id"])) is None
    assert asyncio.run(store.list("u2")) == []
    assert asyncio.run(store.delete("u2", row["id"])) is False


def test_update_and_delete(store):
    row = asyncio.run(store.create("u1", DATA))
    upd = asyncio.run(store.update("u1", row["id"], {**DATA, "name": "Renamed"}))
    assert upd["name"] == "Renamed" and upd["updated_at"] >= row["updated_at"]
    assert asyncio.run(store.update("u1", "nope", DATA)) is None
    assert asyncio.run(store.delete("u1", row["id"])) is True
    assert asyncio.run(store.get("u1", row["id"])) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_screen_store.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`config.py`, after `patterns_db_path`:

```python
    # Where saved screener screens are persisted. Set CAPITAL_SCREENS_DB_PATH
    # to relocate.
    screens_db_path: str = "screens.db"
```

`backend/auto_trader/core/screen_store.py`:

```python
"""Saved screener screens, per user.

Same storage idiom as pattern_preset_store: stdlib sqlite3, a fresh
connection per operation, work via asyncio.to_thread, JSON columns parsed at
the read boundary so callers never see a JSON string."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid

from auto_trader.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS screens (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, broker TEXT NOT NULL, resolution TEXT NOT NULL,
  symbols TEXT NOT NULL, expression TEXT NOT NULL, columns TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
"""
_COLS = "id,name,broker,resolution,symbols,expression,columns,created_at,updated_at"


class ScreenStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.executescript(_SCHEMA)
        return conn

    @staticmethod
    def _row(r: tuple) -> dict:
        return {"id": r[0], "name": r[1], "broker": r[2], "resolution": r[3],
                "symbols": json.loads(r[4]), "expression": r[5],
                "columns": json.loads(r[6]), "created_at": r[7], "updated_at": r[8]}

    def _get_sync(self, conn, user_id: str, screen_id: str) -> dict | None:
        r = conn.execute(f"SELECT {_COLS} FROM screens WHERE user_id=? AND id=?",
                         (user_id, screen_id)).fetchone()
        return self._row(r) if r else None

    async def list(self, user_id: str) -> list[dict]:
        def op() -> list[dict]:
            with self._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_COLS} FROM screens WHERE user_id=? ORDER BY created_at, id",
                    (user_id,)).fetchall()
            return [self._row(r) for r in rows]
        return await asyncio.to_thread(op)

    async def get(self, user_id: str, screen_id: str) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                return self._get_sync(conn, user_id, screen_id)
        return await asyncio.to_thread(op)

    async def create(self, user_id: str, data: dict) -> dict:
        def op() -> dict:
            sid = uuid.uuid4().hex[:12]
            now = int(time.time())
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO screens VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (user_id, sid, data["name"], data["broker"], data["resolution"],
                     json.dumps(data["symbols"]), data["expression"],
                     json.dumps(data["columns"]), now, now))
                return self._get_sync(conn, user_id, sid)
        return await asyncio.to_thread(op)

    async def update(self, user_id: str, screen_id: str, data: dict) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE screens SET name=?, broker=?, resolution=?, symbols=?, "
                    "expression=?, columns=?, updated_at=? WHERE user_id=? AND id=?",
                    (data["name"], data["broker"], data["resolution"],
                     json.dumps(data["symbols"]), data["expression"],
                     json.dumps(data["columns"]), int(time.time()), user_id, screen_id))
                if cur.rowcount == 0:
                    return None
                return self._get_sync(conn, user_id, screen_id)
        return await asyncio.to_thread(op)

    async def delete(self, user_id: str, screen_id: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM screens WHERE user_id=? AND id=?",
                                   (user_id, screen_id))
            return cur.rowcount > 0
        return await asyncio.to_thread(op)


SCREEN_STORE = ScreenStore(settings.screens_db_path)
```

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_screen_store.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/config.py backend/auto_trader/core/screen_store.py backend/tests/test_screen_store.py docs/superpowers/specs/2026-10-21-screener-design.md
git commit -m "feat(screener): per-user screen store"
```

---

### Task 5: Screen job runner

**Files:**
- Create: `backend/auto_trader/api/screen_jobs.py`
- Test: `backend/tests/test_screen_jobs.py`

**Interfaces:**
- Consumes: `screen_eval.compile_screen`, `bars_needed`, `closed_bars`, `judge`; `deps.load_alert_bars(broker_id, epic, resolution, side, count) -> (bars, degraded)` (`api/deps.py:226`).
- Produces:
  - `screen_jobs.Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]`.
  - `screen_jobs.ScreenJobs(loader: Loader = deps.load_alert_bars, per_broker: int = 4, clock: Callable[[], float] = time.time)`.
  - `ScreenJobs.start(user_id: str, *, broker: str, resolution: str, side: str, symbols: list[str], cs: CompiledScreen) -> str` (job id; raises `JobBusy` when the user has a running job).
  - `ScreenJobs.status(user_id: str, job_id: str) -> dict | None` returning `{"status": "running"|"done"|"cancelled", "done": int, "total": int, "result": dict | None}`; `result` is `{"matches": [{"epic", "bar_time", "columns"}], "skipped": [{"epic", "reason"}], "stats": {"symbols", "matched", "skipped", "ms"}}`.
  - `ScreenJobs.cancel(user_id: str, job_id: str) -> bool`.
  - `screen_jobs.JobBusy(Exception)`, `screen_jobs.SCREEN_JOBS = ScreenJobs()`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_screen_jobs.py`:

```python
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.api.screen_jobs import JobBusy, ScreenJobs
from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import compile_screen

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
NOW = (T0 + timedelta(days=400)).timestamp()  # every fake bar is closed


def _bars(closes):
    return [Candle(time=T0 + timedelta(days=k), open=c, high=c, low=c, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def _loader(table, calls=None, gate=None):
    async def load(broker, epic, resolution, side, count):
        if calls is not None:
            calls.append((broker, epic, count))
        if gate is not None:
            await gate.wait()
        v = table[epic]
        if isinstance(v, Exception):
            raise v
        return v, False
    return load


async def _finish(jobs, user, jid):
    for _ in range(200):
        st = jobs.status(user, jid)
        if st["status"] != "running":
            return st
        await asyncio.sleep(0.01)
    raise AssertionError("job did not finish")


def _start(jobs, symbols, expr="candle.close > 10", user="u1"):
    return jobs.start(user, broker="yfinance", resolution="DAY", side="mid",
                      symbols=symbols, cs=compile_screen(expr, []))


def test_matches_and_stats():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _bars([5, 11]), "B": _bars([5, 5])}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["A", "B"]))
        assert st["status"] == "done" and st["done"] == st["total"] == 2
        assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
        assert st["result"]["stats"]["matched"] == 1
    asyncio.run(run())


def test_one_symbol_error_does_not_fail_run():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": RuntimeError("broker down"), "B": _bars([5, 11])}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["A", "B"]))
        assert [m["epic"] for m in st["result"]["matches"]] == ["B"]
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "broker down"}]
    asyncio.run(run())


def test_degraded_and_empty_are_skipped():
    async def run():
        async def load(broker, epic, res, side, count):
            return (_bars([11]), True) if epic == "D" else ([], False)
        jobs = ScreenJobs(loader=load, clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["D", "E"]))
        reasons = {s["epic"]: s["reason"] for s in st["result"]["skipped"]}
        assert reasons == {"D": "broker unavailable, cached bars only", "E": "no candles"}
    asyncio.run(run())


def test_one_run_per_user():
    async def run():
        gate = asyncio.Event()
        jobs = ScreenJobs(loader=_loader({"A": _bars([11])}, gate=gate), clock=lambda: NOW)
        jid = _start(jobs, ["A"])
        with pytest.raises(JobBusy):
            _start(jobs, ["A"])
        other = _start(jobs, ["A"], user="u2")  # another user is not blocked
        gate.set()
        await _finish(jobs, "u1", jid)
        await _finish(jobs, "u2", other)
        _start(jobs, ["A"])  # free again after finishing
    asyncio.run(run())


def test_per_broker_cap():
    async def run():
        active = 0
        peak = 0

        async def load(broker, epic, res, side, count):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return _bars([11]), False
        jobs = ScreenJobs(loader=load, per_broker=2, clock=lambda: NOW)
        await _finish(jobs, "u1", _start(jobs, [f"S{i}" for i in range(8)]))
        assert peak == 2
    asyncio.run(run())


def test_cancel_and_foreign_user():
    async def run():
        gate = asyncio.Event()
        jobs = ScreenJobs(loader=_loader({"A": _bars([11])}, gate=gate), clock=lambda: NOW)
        jid = _start(jobs, ["A"])
        assert jobs.status("u2", jid) is None and jobs.cancel("u2", jid) is False
        assert jobs.cancel("u1", jid) is True
        st = await _finish(jobs, "u1", jid)
        assert st["status"] == "cancelled"
    asyncio.run(run())


def test_asks_for_enough_bars():
    async def run():
        calls = []
        jobs = ScreenJobs(loader=_loader({"A": _bars([1.0] * 300)}, calls=calls), clock=lambda: NOW)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("candle.close > EMA(200)", []))
        await _finish(jobs, "u1", jid)
        assert calls[0][2] >= 202  # warm-up + the forming bar it may drop
    asyncio.run(run())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_screen_jobs.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`backend/auto_trader/api/screen_jobs.py`:

```python
"""In-memory screen runs: fetch each symbol's candles through the shared
candle cache, judge them in a thread, report progress per symbol.

Not the sweep runner on purpose: that ships one candle set per job to
process workers and sits behind the sweep FairGate, so a screen would queue
behind sweeps. Fetches stay in the event loop (the candle cache is async)
under a per-broker cap shared by every user, so one large screen cannot
swamp a broker that also serves everyone's charts.

Jobs live only in this process and are dropped an hour after they finish."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import CompiledScreen, bars_needed, closed_bars, judge

from . import deps

Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]

_KEEP_FINISHED_S = 3600


class JobBusy(Exception):
    """The user already has a screen running."""


@dataclass
class _Job:
    user_id: str
    total: int
    status: str = "running"
    done: int = 0
    result: dict | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class ScreenJobs:
    def __init__(self, loader: Loader | None = None, per_broker: int = 4,
                 clock: Callable[[], float] = time.time) -> None:
        self._loader = loader or deps.load_alert_bars
        self._per_broker = per_broker
        self._clock = clock
        self._sems: dict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(self._per_broker))
        self._jobs: dict[str, _Job] = {}

    def _prune(self) -> None:
        now = self._clock()
        for jid in [j for j, job in self._jobs.items()
                    if job.finished_at is not None and now - job.finished_at > _KEEP_FINISHED_S]:
            del self._jobs[jid]

    def start(self, user_id: str, *, broker: str, resolution: str, side: str,
              symbols: list[str], cs: CompiledScreen) -> str:
        self._prune()
        if any(j.user_id == user_id and j.status == "running" for j in self._jobs.values()):
            raise JobBusy()
        jid = uuid.uuid4().hex[:12]
        job = _Job(user_id=user_id, total=len(symbols))
        self._jobs[jid] = job
        job.task = asyncio.get_running_loop().create_task(
            self._run(job, broker, resolution, side, symbols, cs))
        return jid

    async def _one(self, job: _Job, broker: str, resolution: str, side: str,
                   epic: str, cs: CompiledScreen, res_s: int) -> tuple[dict | None, dict | None]:
        try:
            async with self._sems[broker]:
                bars, degraded = await self._loader(broker, epic, resolution, side, bars_needed(cs) + 1)
            if degraded:
                return None, {"epic": epic, "reason": "broker unavailable, cached bars only"}
            if not bars:
                return None, {"epic": epic, "reason": "no candles"}
            bars = closed_bars(list(bars), res_s, self._clock())
            j = await asyncio.to_thread(judge, cs, bars, resolution)
            if j.skip_reason:
                return None, {"epic": epic, "reason": j.skip_reason}
            if j.matched:
                return {"epic": epic, "bar_time": j.bar_time_ms, "columns": j.columns}, None
            return None, None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # one bad symbol must not kill the run
            return None, {"epic": epic, "reason": str(e) or type(e).__name__}
        finally:
            job.done += 1

    async def _run(self, job: _Job, broker: str, resolution: str, side: str,
                   symbols: list[str], cs: CompiledScreen) -> None:
        t0 = time.perf_counter()
        res_s = resolution_seconds(resolution)
        try:
            pairs = await asyncio.gather(*(
                self._one(job, broker, resolution, side, epic, cs, res_s) for epic in symbols))
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.finished_at = self._clock()
            return
        matches = [m for m, _ in pairs if m]
        skipped = [s for _, s in pairs if s]
        job.result = {"matches": matches, "skipped": skipped,
                      "stats": {"symbols": len(symbols), "matched": len(matches),
                                "skipped": len(skipped),
                                "ms": int((time.perf_counter() - t0) * 1000)}}
        job.status = "done"
        job.finished_at = self._clock()

    def status(self, user_id: str, job_id: str) -> dict | None:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id:
            return None
        return {"status": job.status, "done": job.done, "total": job.total, "result": job.result}

    def cancel(self, user_id: str, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id or job.status != "running" or job.task is None:
            return False
        job.task.cancel()
        return True


SCREEN_JOBS = ScreenJobs()
```

Check `resolution_seconds` accepts a canonical resolution string like `"DAY"` (it is imported the same way in `api/expr_exec.py`). If it takes a different shape, use `Resolution(resolution).seconds` from `core/models.py` instead.

`cancel` returns True before the task has observed the cancellation; the task's own `except CancelledError` then marks it cancelled. Because the gather is cancelled, `_one`'s `finally` still bumps `done` for in-flight symbols; that is fine.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_screen_jobs.py tests/test_screen_eval.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/screen_jobs.py backend/tests/test_screen_jobs.py
git commit -m "feat(screener): in-memory screen runner with per-broker cap"
```

---

### Task 6: Screens router

**Files:**
- Create: `backend/auto_trader/api/routers/screens.py`
- Modify: `backend/auto_trader/api/app.py` (import list line 38 and the include loop line 247)
- Test: `backend/tests/test_api_screens.py`

**Interfaces:**
- Consumes: `SCREEN_STORE` (Task 4), `SCREEN_JOBS`, `JobBusy` (Task 5), `compile_screen`, `ScreenSpecError` (Task 3), `deps.current_user`, `deps.resolve_broker`.
- Produces (HTTP):
  - `GET /api/screens` gives `{"screens": [screen]}`.
  - `POST /api/screens` (body `ScreenBody`) gives the screen; 422 on a bad expression.
  - `PUT /api/screens/{id}` (body `ScreenBody`) gives the screen; 404 unknown.
  - `DELETE /api/screens/{id}` gives 204; 404 unknown.
  - `POST /api/screens/run` (body `ScreenRunBody`) gives `{"jobId": str, "total": int}`; 422 bad expression with detail `{"code","message","start","end","field","index"}`; 409 busy; 422 when there are no symbols or more than 500.
  - `GET /api/screens/jobs/{job_id}` gives the status dict from Task 5; 404 unknown.
  - `POST /api/screens/jobs/{job_id}/cancel` gives 204; 404 when not running.
- `ScreenBody`: `name: str (1..80)`, `broker: str`, `resolution: Resolution`, `symbols: list[str]`, `expression: str`, `columns: list[ColumnBody]` (default `[]`, max 8); `ColumnBody`: `name: str (1..40)`, `expression: str`.
- `ScreenRunBody`: `ScreenBody` fields minus `name`, plus `priceSide: str = "mid"`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_screens.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import screen_jobs
from auto_trader.api.app import app
from auto_trader.core import screen_store
from auto_trader.core.models import Candle

client = TestClient(app)
T0 = datetime(2020, 1, 1, tzinfo=timezone.utc)
BODY = {"name": "Up", "broker": "yfinance", "resolution": "DAY",
        "symbols": ["A", "B"], "expression": "candle.close > 10",
        "columns": [{"name": "C", "expression": "candle.close"}]}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(screen_store.SCREEN_STORE, "_db_path", str(tmp_path / "screens.db"))

    async def load(broker, epic, res, side, count):
        closes = [5, 11] if epic == "A" else [5, 5]
        return [Candle(time=T0 + timedelta(days=k), open=c, high=c, low=c, close=c, volume=1.0)
                for k, c in enumerate(closes)], False
    monkeypatch.setattr(screen_jobs, "SCREEN_JOBS", screen_jobs.ScreenJobs(loader=load))
    from auto_trader.api.routers import screens
    monkeypatch.setattr(screens, "SCREEN_JOBS", screen_jobs.SCREEN_JOBS)


def test_crud_roundtrip():
    created = client.post("/api/screens", json=BODY).json()
    assert created["symbols"] == ["A", "B"]
    assert client.get("/api/screens").json()["screens"][0]["id"] == created["id"]
    upd = client.put(f"/api/screens/{created['id']}", json={**BODY, "name": "Up2"}).json()
    assert upd["name"] == "Up2"
    assert client.delete(f"/api/screens/{created['id']}").status_code == 204
    assert client.delete(f"/api/screens/{created['id']}").status_code == 404


def test_save_bad_expression_422():
    r = client.post("/api/screens", json={**BODY, "expression": "candle.close >"})
    assert r.status_code == 422 and r.json()["detail"]["field"] == "expression"


def test_run_and_poll():
    body = {k: v for k, v in BODY.items() if k != "name"}
    r = client.post("/api/screens/run", json=body)
    assert r.status_code == 200
    jid = r.json()["jobId"]
    for _ in range(100):
        st = client.get(f"/api/screens/jobs/{jid}").json()
        if st["status"] != "running":
            break
    assert st["status"] == "done"
    assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
    assert st["result"]["matches"][0]["columns"] == {"C": 11.0}


def test_run_bad_expression_422():
    body = {k: v for k, v in BODY.items() if k != "name"}
    r = client.post("/api/screens/run", json={**body, "expression": "EMA(9)@D > 1"})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "screen_tf_unsupported" and d["field"] == "expression"


def test_run_needs_symbols():
    body = {k: v for k, v in BODY.items() if k != "name"}
    assert client.post("/api/screens/run", json={**body, "symbols": []}).status_code == 422


def test_unknown_job_404():
    assert client.get("/api/screens/jobs/nope").status_code == 404
    assert client.post("/api/screens/jobs/nope/cancel").status_code == 404
```

`TestClient` drives the app's event loop between requests, so the polling loop advances the job. If the job never leaves `running` under `TestClient`, switch the run test to `httpx.AsyncClient(transport=ASGITransport(app=app))` inside `asyncio.run`, the way `tests/test_api_pattern_presets.py` imports it, and `await asyncio.sleep(0.01)` between polls.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_screens.py -q`
Expected: FAIL (404s: router not mounted).

- [ ] **Step 3: Implement**

`backend/auto_trader/api/routers/screens.py`:

```python
"""Screener: saved screens (CRUD) and screen runs (start, poll, cancel).

A screen is judged on each symbol's last closed bar (core/screen_eval.py);
runs are in-memory jobs (api/screen_jobs.py). Every route is per user."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auto_trader.api import deps
from auto_trader.api.screen_jobs import SCREEN_JOBS, JobBusy
from auto_trader.core.models import Resolution
from auto_trader.core.screen_eval import ScreenSpecError, compile_screen
from auto_trader.core.screen_store import SCREEN_STORE

router = APIRouter()

_MAX_SYMBOLS = 500


class ColumnBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    expression: str


class ScreenRunBody(BaseModel):
    broker: str
    resolution: Resolution
    symbols: list[str]
    expression: str
    columns: list[ColumnBody] = Field(default_factory=list, max_length=8)
    priceSide: str = "mid"


class ScreenBody(ScreenRunBody):
    name: str = Field(min_length=1, max_length=80)


def _compile(body: ScreenRunBody):
    try:
        return compile_screen(body.expression, [c.model_dump() for c in body.columns])
    except ScreenSpecError as e:
        raise HTTPException(422, {
            "code": e.err.code, "message": e.err.message,
            "start": e.err.start, "end": e.err.end,
            "field": e.field, "index": e.index,
        })


def _data(body: ScreenBody, broker: str) -> dict:
    return {"name": body.name, "broker": broker, "resolution": body.resolution.value,
            "symbols": body.symbols, "expression": body.expression,
            "columns": [c.model_dump() for c in body.columns]}


@router.get("/api/screens")
async def list_screens(request: Request) -> dict:
    return {"screens": await SCREEN_STORE.list(deps.current_user(request))}


@router.post("/api/screens")
async def create_screen(request: Request, body: ScreenBody) -> dict:
    _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    return await SCREEN_STORE.create(deps.current_user(request), _data(body, broker))


@router.put("/api/screens/{screen_id}")
async def update_screen(request: Request, screen_id: str, body: ScreenBody) -> dict:
    _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    row = await SCREEN_STORE.update(deps.current_user(request), screen_id, _data(body, broker))
    if row is None:
        raise HTTPException(404, "no such screen")
    return row


@router.delete("/api/screens/{screen_id}", status_code=204)
async def delete_screen(request: Request, screen_id: str) -> None:
    if not await SCREEN_STORE.delete(deps.current_user(request), screen_id):
        raise HTTPException(404, "no such screen")


@router.post("/api/screens/run")
async def run_screen(request: Request, body: ScreenRunBody) -> dict:
    symbols = list(dict.fromkeys(s for s in body.symbols if s.strip()))
    if not symbols:
        raise HTTPException(422, "add at least one symbol")
    if len(symbols) > _MAX_SYMBOLS:
        raise HTTPException(422, f"at most {_MAX_SYMBOLS} symbols per screen")
    cs = _compile(body)
    broker = deps.resolve_broker(request, body.broker)
    try:
        jid = SCREEN_JOBS.start(deps.current_user(request), broker=broker,
                                resolution=body.resolution.value, side=body.priceSide,
                                symbols=symbols, cs=cs)
    except JobBusy:
        raise HTTPException(409, "a screen is already running")
    return {"jobId": jid, "total": len(symbols)}


@router.get("/api/screens/jobs/{job_id}")
async def screen_job(request: Request, job_id: str) -> dict:
    st = SCREEN_JOBS.status(deps.current_user(request), job_id)
    if st is None:
        raise HTTPException(404, "no such screen run")
    return st


@router.post("/api/screens/jobs/{job_id}/cancel", status_code=204)
async def cancel_screen_job(request: Request, job_id: str) -> None:
    if not SCREEN_JOBS.cancel(deps.current_user(request), job_id):
        raise HTTPException(404, "no running screen with that id")
```

The router reads `SCREEN_JOBS` as a module global so the test's monkeypatch of `screens.SCREEN_JOBS` takes effect.

`app.py`: add `screens` to the `from .routers import ...` list (line 38) and to the `for _module in (...)` tuple (line 247), after `pattern_presets`.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_api_screens.py tests/test_screen_jobs.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/screens.py backend/auto_trader/api/app.py backend/tests/test_api_screens.py
git commit -m "feat(screener): /api/screens CRUD and run endpoints"
```

---

### Task 7: Frontend screens client

**Files:**
- Create: `frontend/src/lib/screens.ts`
- Test: `frontend/src/lib/screens.test.ts`

**Interfaces:**
- Consumes: `API_BASE`, `apiFetch`, `errorDetail` from `frontend/src/lib/http`.
- Produces:

```ts
export interface ScreenColumn { name: string; expression: string }
export interface ScreenDraft { broker: string; resolution: string; symbols: string[]; expression: string; columns: ScreenColumn[] }
export interface Screen extends ScreenDraft { id: string; name: string; created_at: number; updated_at: number }
export interface ScreenMatch { epic: string; bar_time: number; columns: Record<string, number | null> }
export interface ScreenResult { matches: ScreenMatch[]; skipped: { epic: string; reason: string }[]; stats: { symbols: number; matched: number; skipped: number; ms: number } }
export interface ScreenJobStatus { status: "running" | "done" | "cancelled"; done: number; total: number; result: ScreenResult | null }
export interface ScreenExprError { code: string; message: string; start: number; end: number; field: "expression" | "columns"; index: number }
export class ScreenSpecError extends Error { constructor(public detail: ScreenExprError) }
export function listScreens(): Promise<Screen[]>
export function saveScreen(name: string, draft: ScreenDraft, id?: string): Promise<Screen>
export function deleteScreen(id: string): Promise<void>
export function startScreen(draft: ScreenDraft, priceSide: string): Promise<{ jobId: string; total: number }>
export function pollScreen(jobId: string): Promise<ScreenJobStatus>
export function cancelScreen(jobId: string): Promise<void>
```

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/screens.test.ts` (same mocking style as `lib/presetScan.test.ts`; open it and copy its `fetch` stub setup if it differs from this):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenSpecError, deleteScreen, listScreens, saveScreen, startScreen } from "./screens";

const draft = { broker: "yfinance", resolution: "DAY", symbols: ["AAPL"], expression: "RSI(14) < 30", columns: [] };

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("screens client", () => {
  it("lists screens", async () => {
    stubFetch(200, { screens: [{ id: "s1", name: "x", ...draft, created_at: 1, updated_at: 1 }] });
    expect((await listScreens())[0].id).toBe("s1");
  });

  it("creates with POST and updates with PUT", async () => {
    const fn = stubFetch(200, { id: "s1" });
    await saveScreen("x", draft);
    expect(String(fn.mock.calls[0][0])).toMatch(/\/api\/screens$/);
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe("POST");
    await saveScreen("x", draft, "s1");
    expect(String(fn.mock.calls[1][0])).toMatch(/\/api\/screens\/s1$/);
    expect((fn.mock.calls[1][1] as RequestInit).method).toBe("PUT");
  });

  it("turns an expression 422 into ScreenSpecError", async () => {
    stubFetch(422, { detail: { code: "unexpected_token", message: "Expected a value here.", start: 14, end: 14, field: "expression", index: 0 } });
    await expect(startScreen(draft, "mid")).rejects.toBeInstanceOf(ScreenSpecError);
  });

  it("delete throws on 404", async () => {
    stubFetch(404, { detail: "no such screen" });
    await expect(deleteScreen("nope")).rejects.toThrow("no such screen");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/screens.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`frontend/src/lib/screens.ts`:

```ts
// Screener HTTP client: saved screens and screen runs (backend
// api/routers/screens.py). A 422 whose detail carries an expression span
// becomes a ScreenSpecError so the panel can underline the right field.
import { API_BASE as BASE, apiFetch, errorDetail } from "./http";

export interface ScreenColumn { name: string; expression: string }
export interface ScreenDraft {
  broker: string;
  resolution: string;
  symbols: string[];
  expression: string;
  columns: ScreenColumn[];
}
export interface Screen extends ScreenDraft {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}
export interface ScreenMatch { epic: string; bar_time: number; columns: Record<string, number | null> }
export interface ScreenResult {
  matches: ScreenMatch[];
  skipped: { epic: string; reason: string }[];
  stats: { symbols: number; matched: number; skipped: number; ms: number };
}
export interface ScreenJobStatus {
  status: "running" | "done" | "cancelled";
  done: number;
  total: number;
  result: ScreenResult | null;
}
export interface ScreenExprError {
  code: string;
  message: string;
  start: number;
  end: number;
  field: "expression" | "columns";
  index: number;
}

export class ScreenSpecError extends Error {
  constructor(public detail: ScreenExprError) {
    super(detail.message);
  }
}

async function failed(res: Response, fallback: string): Promise<never> {
  if (res.status === 422) {
    const body = await res.clone().json().catch(() => null);
    const d = body?.detail;
    if (d && typeof d === "object" && typeof d.code === "string") throw new ScreenSpecError(d as ScreenExprError);
  }
  throw new Error(await errorDetail(res, fallback));
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listScreens(): Promise<Screen[]> {
  const res = await apiFetch(`${BASE}/api/screens`);
  if (!res.ok) await failed(res, `screens failed (${res.status})`);
  return (await res.json()).screens;
}

export async function saveScreen(name: string, draft: ScreenDraft, id?: string): Promise<Screen> {
  const res = await apiFetch(id ? `${BASE}/api/screens/${encodeURIComponent(id)}` : `${BASE}/api/screens`, {
    method: id ? "PUT" : "POST",
    ...json({ name, ...draft }),
  });
  if (!res.ok) await failed(res, `save failed (${res.status})`);
  return res.json();
}

export async function deleteScreen(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/screens/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await failed(res, `delete failed (${res.status})`);
}

export async function startScreen(draft: ScreenDraft, priceSide: string): Promise<{ jobId: string; total: number }> {
  const res = await apiFetch(`${BASE}/api/screens/run`, { method: "POST", ...json({ ...draft, priceSide }) });
  if (!res.ok) await failed(res, `screen failed (${res.status})`);
  return res.json();
}

export async function pollScreen(jobId: string): Promise<ScreenJobStatus> {
  const res = await apiFetch(`${BASE}/api/screens/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) await failed(res, `screen status failed (${res.status})`);
  return res.json();
}

export async function cancelScreen(jobId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/screens/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 404) await failed(res, `cancel failed (${res.status})`);
}
```

Check `errorDetail(res, fallback)` reads `detail` from the JSON body (it does for string details in other callers); if it consumes the body, the `res.clone()` above keeps the 422 path working.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/screens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/screens.ts frontend/src/lib/screens.test.ts
git commit -m "feat(screener): frontend screens client"
```

---

### Task 8: Screener side-panel slot and toolbar toggle

**Files:**
- Modify: `frontend/src/lib/sidePanels.ts` (`SidePanelId`, header comment "six surfaces" becomes "seven")
- Modify: `frontend/src/lib/signals.ts` (new signal near `tradeListPanelOpen` line 141; register + toggle near line 805)
- Modify: `frontend/src/ToolbarControls.tsx` (`PanelId` line 486, `PanelToggles` state and `panels` list ~line 548)
- Modify: `frontend/src/app/usePanelSignals.ts` (`usePanelOpenStates`, return `screenerOpen`)
- Test: `frontend/src/lib/signals.screener.test.ts`

**Interfaces:**
- Produces: `signals.screenerPanelOpen: Signal<boolean>`; `toggleSidePanel` accepts `"screener"`; `usePanelOpenStates(tabs).screenerOpen: boolean`.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/signals.screener.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { endSidePanelRestore } from "./sidePanels";
import { alertsPanelOpen, screenerPanelOpen, toggleSidePanel } from "./signals";

beforeEach(() => {
  endSidePanelRestore();
  alertsPanelOpen.set(false);
  screenerPanelOpen.set(false);
});

describe("screener side panel", () => {
  it("toggles open and closed", () => {
    toggleSidePanel("screener");
    expect(screenerPanelOpen.value).toBe(true);
    toggleSidePanel("screener");
    expect(screenerPanelOpen.value).toBe(false);
  });

  it("claims the dock from another panel and yields it back", () => {
    toggleSidePanel("alerts");
    toggleSidePanel("screener");
    expect(alertsPanelOpen.value).toBe(false);
    expect(screenerPanelOpen.value).toBe(true);
    toggleSidePanel("alerts");
    expect(screenerPanelOpen.value).toBe(false);
  });
});
```

Do not call `resetSidePanelsForTest` here: it clears the closers `signals.ts` registered at import time.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/signals.screener.test.ts`
Expected: FAIL (`screenerPanelOpen` not exported).

- [ ] **Step 3: Implement**

`sidePanels.ts`: add `| "screener"` to `SidePanelId`; update the header comment's list to include the screener.

`signals.ts`, after `tradeListPanelOpen`:

```ts
// True while the Screener panel is open (toolbar toggle; read by App).
export const screenerPanelOpen = new Signal<boolean>(false);
```

After `registerSidePanel("live", ...)`:

```ts
registerSidePanel("screener", () => screenerPanelOpen.set(false));
```

`toggleSidePanel`:

```ts
export function toggleSidePanel(id: "alerts" | "trade" | "tradeList" | "live" | "screener"): void {
  const sig =
    id === "alerts" ? alertsPanelOpen
    : id === "trade" ? tradePanelOpen
    : id === "tradeList" ? tradeListPanelOpen
    : id === "screener" ? screenerPanelOpen
    : livePanelOpen;
  if (sig.value) sig.set(false);
  else openSidePanelSignal(sig, id);
}
```

Update the comment above `openSidePanelSignal` ("These four panels") to five.

`ToolbarControls.tsx`: `type PanelId = "live" | "tradeList" | "alerts" | "trade" | "screener";`. In `PanelToggles`, beside the other `useState`/`subscribe` pairs:

```tsx
  const [screenerOpen, setScreenerOpen] = useState(screenerPanelOpen.value);
  useEffect(() => screenerPanelOpen.subscribe(setScreenerOpen), []);
```

and in `panels`, after the trade-list entry (shown for data-only brokers too, since screening needs no account):

```tsx
    {
      id: "screener" as const, label: "Screener", tip: "Show screener panel",
      icon: <ScreenerIcon />, on: screenerOpen, cls: "screener-toggle",
    },
```

Add `screenerPanelOpen` to the existing `./lib/signals` import, and define `ScreenerIcon` next to `TradeListIcon` in the same file (find `function TradeListIcon` and copy its SVG wrapper attributes exactly):

```tsx
function ScreenerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 3h12l-4.5 5.2V13l-3-1.5V8.2z" strokeLinejoin="round" />
    </svg>
  );
}
```

`usePanelSignals.ts` in `usePanelOpenStates`: add

```ts
  const [screenerOpen, setScreenerOpen] = useState(screenerPanelOpen.value);
  useEffect(() => screenerPanelOpen.subscribe(setScreenerOpen), []);
```

import `screenerPanelOpen`, and add `screenerOpen` to the returned object.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/signals.screener.test.ts src/Toolbar.demo.test.tsx`
Expected: PASS. If a Toolbar test counts panel toggle buttons, update that count by one and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/sidePanels.ts frontend/src/lib/signals.ts frontend/src/ToolbarControls.tsx frontend/src/app/usePanelSignals.ts frontend/src/lib/signals.screener.test.ts
git commit -m "feat(screener): side-panel slot and toolbar toggle"
```

---

### Task 9: Screener panel

**Files:**
- Create: `frontend/src/ScreenerPanel.tsx`
- Modify: `frontend/src/App.tsx` (lazy import beside `TradeListPanel` line 51; render beside the trade-list block ~line 1106; destructure `screenerOpen` from `usePanelOpenStates` ~line 625)
- Modify: `frontend/src/App.css` (after the `.trade-list-panel` block ~line 7172)
- Test: `frontend/src/ScreenerPanel.test.tsx`

**Interfaces:**
- Consumes: everything in Task 7; `RuleExpressionInput` (`components/RuleExpressionInput.tsx`, props `value, onChange, isExit, placeholder`); `SymbolSearchModal` (`onPick(Instrument)`, `onClose`, `brokerId`, `current`); `fetchFavorites(brokerId)` (`lib/feed/instruments.ts:155`); `Tooltip`, `InfoTip`; `isImpersonating()` from `lib/impersonation`; `isDemoMode()` (as App already uses it).
- Produces: `export default function ScreenerPanel(props: { brokerId: string; priceSide: string; onOpen: (epic: string, resolution: string) => void; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

`frontend/src/ScreenerPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/screens", async (orig) => ({
  ...(await orig<typeof import("./lib/screens")>()),
  listScreens: vi.fn(async () => []),
  startScreen: vi.fn(async () => ({ jobId: "j1", total: 2 })),
  pollScreen: vi.fn(async () => ({
    status: "done", done: 2, total: 2,
    result: {
      matches: [{ epic: "AAPL", bar_time: 1_760_000_000_000, columns: { RSI: 28.4 } }],
      skipped: [{ epic: "ZZZ", reason: "no candles" }],
      stats: { symbols: 2, matched: 1, skipped: 1, ms: 40 },
    },
  })),
}));
vi.mock("./components/RuleExpressionInput", () => ({
  default: (p: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Condition" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));

import ScreenerPanel from "./ScreenerPanel";
import { startScreen } from "./lib/screens";

beforeEach(() => vi.clearAllMocks());

function setup() {
  const onOpen = vi.fn();
  render(<ScreenerPanel brokerId="yfinance" priceSide="mid" onOpen={onOpen} onClose={() => {}} />);
  return { onOpen };
}

describe("ScreenerPanel", () => {
  it("runs a screen and lists matches and skipped", async () => {
    const { onOpen } = setup();
    fireEvent.change(screen.getByLabelText("Symbols"), { target: { value: "AAPL, ZZZ" } });
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "RSI(14) < 30" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("AAPL")).toBeTruthy());
    expect(vi.mocked(startScreen).mock.calls[0][0]).toMatchObject({
      broker: "yfinance", symbols: ["AAPL", "ZZZ"], expression: "RSI(14) < 30",
    });
    expect(screen.getByText("28.4")).toBeTruthy();
    expect(screen.getByText("1 skipped")).toBeTruthy();
    fireEvent.click(screen.getByText("AAPL"));
    expect(onOpen).toHaveBeenCalledWith("AAPL", "DAY");
  });

  it("disables Run with no symbols", () => {
    setup();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`frontend/src/ScreenerPanel.tsx`:

```tsx
// Screener: judge one rule expression on the last closed bar of every symbol
// in a list, docked like the trade list. Saved screens live server-side
// (lib/screens.ts); the last run's result lives here only.
import { useEffect, useMemo, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import RuleExpressionInput from "./components/RuleExpressionInput";
import SymbolSearchModal from "./SymbolSearchModal";
import { fetchFavorites } from "./lib/feed/instruments";
import { isImpersonating } from "./lib/impersonation";
import { toast } from "./lib/notify";
import {
  ScreenSpecError,
  cancelScreen,
  deleteScreen,
  listScreens,
  pollScreen,
  saveScreen,
  startScreen,
  type Screen,
  type ScreenColumn,
  type ScreenResult,
} from "./lib/screens";

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: "MINUTE_15", label: "15m" },
  { value: "MINUTE_30", label: "30m" },
  { value: "HOUR", label: "1H" },
  { value: "HOUR_4", label: "4H" },
  { value: "DAY", label: "1D" },
  { value: "WEEK", label: "1W" },
];

const POLL_MS = 500;

function parseSymbols(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "n/a";
  return Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString();
}

interface Props {
  brokerId: string;
  priceSide: string;
  onOpen: (epic: string, resolution: string) => void;
  onClose: () => void;
}

type SortKey = { col: string; desc: boolean };

export default function ScreenerPanel({ brokerId, priceSide, onOpen, onClose }: Props) {
  const [saved, setSaved] = useState<Screen[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [resolution, setResolution] = useState("DAY");
  const [symbolsText, setSymbolsText] = useState("");
  const [expression, setExpression] = useState("");
  const [columns, setColumns] = useState<ScreenColumn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sort, setSort] = useState<SortKey>({ col: "epic", desc: false });
  const jobRef = useRef<string | null>(null);
  const readOnly = isImpersonating();

  const symbols = useMemo(() => parseSymbols(symbolsText), [symbolsText]);
  const draft = { broker: brokerId, resolution, symbols, expression, columns };

  useEffect(() => {
    listScreens()
      .then((all) => setSaved(all.filter((s) => s.broker === brokerId)))
      .catch(() => setSaved([]));
  }, [brokerId]);

  // Stop polling if the panel unmounts mid-run; the server job is cancelled too.
  useEffect(() => () => {
    if (jobRef.current) void cancelScreen(jobRef.current);
    jobRef.current = null;
  }, []);

  const load = (s: Screen | null) => {
    setCurrentId(s?.id ?? null);
    setName(s?.name ?? "");
    setResolution(s?.resolution ?? "DAY");
    setSymbolsText(s ? s.symbols.join(", ") : "");
    setExpression(s?.expression ?? "");
    setColumns(s?.columns ?? []);
    setResult(null);
    setError(null);
  };

  const explain = (e: unknown) => {
    if (e instanceof ScreenSpecError) {
      const where = e.detail.field === "columns" ? `Column ${e.detail.index + 1}: ` : "";
      setError(where + e.detail.message);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    setError(null);
    setResult(null);
    try {
      const { jobId, total } = await startScreen(draft, priceSide);
      jobRef.current = jobId;
      setProgress({ done: 0, total });
      for (;;) {
        const st = await pollScreen(jobId);
        if (jobRef.current !== jobId) return; // cancelled or unmounted
        setProgress({ done: st.done, total: st.total });
        if (st.status !== "running") {
          jobRef.current = null;
          setProgress(null);
          if (st.status === "done") setResult(st.result);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      jobRef.current = null;
      setProgress(null);
      explain(e);
    }
  };

  const cancel = () => {
    const id = jobRef.current;
    jobRef.current = null;
    setProgress(null);
    if (id) void cancelScreen(id);
  };

  const save = async () => {
    try {
      const row = await saveScreen(name.trim() || "Untitled screen", draft, currentId ?? undefined);
      setSaved((all) => [...all.filter((s) => s.id !== row.id), row]);
      setCurrentId(row.id);
      setName(row.name);
      toast("Screen saved");
    } catch (e) {
      explain(e);
    }
  };

  const remove = async () => {
    if (!currentId) return;
    try {
      await deleteScreen(currentId);
      setSaved((all) => all.filter((s) => s.id !== currentId));
      load(null);
    } catch (e) {
      explain(e);
    }
  };

  const addFavorites = async () => {
    try {
      const favs = await fetchFavorites(brokerId);
      if (favs.length === 0) {
        toast("This broker has no favorites");
        return;
      }
      setSymbolsText(parseSymbols([symbolsText, ...favs.map((f) => f.epic)].join(",")).join(", "));
    } catch (e) {
      explain(e);
    }
  };

  const colNames = columns.map((c) => c.name);
  const rows = useMemo(() => {
    const ms = [...(result?.matches ?? [])];
    ms.sort((a, b) => {
      const av = sort.col === "epic" ? a.epic : a.columns[sort.col] ?? -Infinity;
      const bv = sort.col === "epic" ? b.epic : b.columns[sort.col] ?? -Infinity;
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.desc ? -c : c;
    });
    return ms;
  }, [result, sort]);
  const toggleSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: col !== "epic" }));

  const running = progress !== null;
  const canRun = !running && !readOnly && symbols.length > 0 && expression.trim() !== "";

  return (
    <aside className="screener-panel" aria-label="Screener">
      <div className="sc-head">
        <span className="sc-title">Screener</span>
        <InfoTip title="Screener" text={[
          "Checks a condition on each symbol's last closed bar.",
          "Example: RSI(14) < 30 and candle.close > EMA(200)",
          "Recent fires: count(crossAbove(candle.close, EMA(50)), 5) >= 1",
        ]} />
        <Tooltip content="Close">
          <button className="modal-close" aria-label="Close screener" onClick={onClose}>×</button>
        </Tooltip>
      </div>

      {readOnly && <p className="sc-note">Read-only while viewing as another user.</p>}

      <div className="sc-form">
        <div className="sc-row">
          <select
            aria-label="Saved screens"
            value={currentId ?? ""}
            onChange={(e) => load(saved.find((s) => s.id === e.target.value) ?? null)}
          >
            <option value="">New screen</option>
            {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input aria-label="Screen name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="sc-row">
          <select aria-label="Timeframe" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button onClick={() => setPicking(true)}>Add symbol</button>
          <button onClick={addFavorites}>Add favorites</button>
        </div>
        <textarea
          aria-label="Symbols"
          className="sc-symbols"
          placeholder="Symbols, separated by commas"
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.target.value)}
        />
        <RuleExpressionInput
          value={expression}
          onChange={setExpression}
          isExit={false}
          placeholder="RSI(14) < 30 and candle.close > EMA(200)"
        />
        {columns.map((c, i) => (
          <div className="sc-row" key={i}>
            <input
              aria-label={`Column ${i + 1} name`}
              value={c.name}
              onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              aria-label={`Column ${i + 1} expression`}
              className="sc-col-expr"
              value={c.expression}
              onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)))}
            />
            <Tooltip content="Remove column">
              <button aria-label={`Remove column ${i + 1}`} onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))}>×</button>
            </Tooltip>
          </div>
        ))}
        {columns.length < 8 && (
          <button className="sc-add-col" onClick={() => setColumns((cs) => [...cs, { name: `Col ${cs.length + 1}`, expression: "RSI(14)" }])}>
            Add column
          </button>
        )}
        {error && <p className="sc-error" role="alert">{error}</p>}
        <div className="sc-row sc-actions">
          {running ? (
            <>
              <span className="sc-progress">{progress.done} / {progress.total}</span>
              <button onClick={cancel}>Cancel</button>
            </>
          ) : (
            <button className="sc-run" disabled={!canRun} onClick={run}>Run</button>
          )}
          <button disabled={readOnly || !expression.trim()} onClick={save}>Save</button>
          {currentId && <button disabled={readOnly} onClick={remove}>Delete</button>}
        </div>
      </div>

      {result && (
        <div className="sc-results">
          <div className="sc-summary">
            <span>{result.stats.matched} of {result.stats.symbols} match</span>
            {result.skipped.length > 0 && (
              <button className="sc-skipped-toggle" onClick={() => setShowSkipped((v) => !v)}>
                {result.skipped.length} skipped
              </button>
            )}
          </div>
          {showSkipped && (
            <ul className="sc-skipped">
              {result.skipped.map((s) => <li key={s.epic}>{s.epic}: {s.reason}</li>)}
            </ul>
          )}
          <table className="sc-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort("epic")}>Symbol</th>
                {colNames.map((n) => <th key={n} onClick={() => toggleSort(n)}>{n}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.epic} onClick={() => onOpen(m.epic, resolution)}>
                  <td>{m.epic}</td>
                  {colNames.map((n) => <td key={n}>{fmt(m.columns[n])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && (
        <SymbolSearchModal
          current={null}
          brokerId={brokerId}
          onPick={(s) => {
            setSymbolsText(parseSymbols(`${symbolsText},${s.epic}`).join(", "));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </aside>
  );
}
```

Check before relying on them: `toast` is exported from `lib/notify` (PresetScanView imports it that way); `isImpersonating` is exported from `lib/impersonation` (CLAUDE.md names it). If `InfoTip`'s `text` does not accept `string[]`, pass one string.

`App.tsx`:

```tsx
const ScreenerPanel = lazyChunk(() => import("./ScreenerPanel"));
```

Destructure `screenerOpen` from `usePanelOpenStates(tabs)`, add `screenerPanelOpen` to the `./lib/signals` import, add `import { periodByResolution } from "./lib/feed";` if it is not already imported (the feed barrel exports it; see `agent/actions/agentPeriod.ts`), and `import { focusedChart } from "./agent/actions/chart";`. Render after the trade-list block inside `<main>`:

```tsx
          {screenerOpen && !isDemoMode() && (
            <ScreenerPanel
              brokerId={brokerId}
              priceSide={settings.priceSide}
              onOpen={(epic, resolution) => {
                void jumpToEpic(epic, 2).then(() => {
                  // The jumped-to chart becomes the focused one; switch it to
                  // the screen's timeframe. Best effort: a chart that is not
                  // focused yet just keeps its own timeframe.
                  const p = periodByResolution(resolution);
                  if (!p) return;
                  try { focusedChart().setPeriod(p); } catch { /* no focused chart */ }
                });
              }}
              onClose={() => screenerPanelOpen.set(false)}
            />
          )}
```

If importing `focusedChart` from the agent actions pulls DOM-bound imports App does not already load, use the focused cell controller App already holds (`focusedController`, used by `AlertsSidebar`) and its period setter instead; read App around line 1118 to find it.

`App.css`, after the `.trade-list-panel` rules:

```css
.screener-panel {
  /* Docked like .trade-list-panel: a flex sibling of .chart-cells. */
  position: relative; flex: 0 0 auto; width: 380px; height: 100%;
  display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  background: var(--surface); color: var(--text);
  border-left: 1px solid var(--border); font-size: 12px;
}
.sc-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border-bottom: 1px solid var(--border); }
.sc-title { font-weight: 600; }
.sc-head > .tooltip-trigger:has(> .modal-close) { margin-left: auto; }
.sc-note { margin: 6px 8px; color: var(--text-dim); }
.sc-form { display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border-bottom: 1px solid var(--border); }
.sc-row { display: flex; align-items: center; gap: 6px; }
.sc-row > input, .sc-row > select { flex: 1 1 auto; min-width: 0; }
.sc-col-expr { flex: 2 1 auto; }
.sc-symbols { min-height: 44px; resize: vertical; }
.sc-actions { justify-content: flex-end; }
.sc-progress { margin-right: auto; color: var(--text-dim); }
.sc-error { margin: 0; color: var(--danger, #e5534b); }
.sc-results { flex: 1 1 auto; overflow: auto; }
.sc-summary { display: flex; align-items: center; gap: 10px; padding: 6px 8px;
  color: var(--text-dim); }
.sc-skipped-toggle { background: none; border: none; color: var(--text-dim);
  text-decoration: underline; cursor: pointer; padding: 0; }
.sc-skipped { margin: 0 8px 6px; padding-left: 16px; color: var(--text-dim); }
.sc-table { width: 100%; border-collapse: collapse; }
.sc-table th { text-align: left; padding: 4px 8px; cursor: pointer;
  color: var(--text-dim); font-weight: 500; border-bottom: 1px solid var(--border); }
.sc-table td { padding: 4px 8px; }
.sc-table tbody tr { cursor: pointer; }
.sc-table tbody tr:hover { background: var(--hover); }
```

Check `--danger` exists in `index.css`; if a different error-color token is used elsewhere (grep `tl-` or `.error` rules), use that one.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx src/lib/signals.screener.test.ts src/lib/screens.test.ts`
Expected: PASS.

Then ask the user once for permission to run `cd frontend && npx tsc -b && npx eslint src/ScreenerPanel.tsx src/lib/screens.ts src/App.tsx src/ToolbarControls.tsx src/lib/signals.ts src/app/usePanelSignals.ts` (both are CPU-heavy; batch them into one ask). Fix any errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ScreenerPanel.tsx frontend/src/ScreenerPanel.test.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(screener): Screener side panel"
```

---

### Task 10: End-to-end check in the running app

**Files:** none changed unless a defect is found.

- [ ] **Step 1:** Ask the user to confirm the dev servers are running (backend :8000 under `--reload`, frontend :5173). Do not restart them yourself.
- [ ] **Step 2:** In the chartkar MCP: `ui_sessions`, `ui_set_title("Screener check")`, then screenshot after the user opens the Screener from the toolbar (Playwright MCP clicks hit the user's real workspace, so do not click through it; ask the user to run one screen, e.g. yfinance, 1D, `AAPL, MSFT, NVDA`, `RSI(14) < 70`).
- [ ] **Step 3:** Confirm with `ui_screenshot`: the panel docks on the right, the toolbar toggle shows the muted on-state, matches list, clicking a row opens that chart.
- [ ] **Step 4:** Report what was seen. Fix and commit any defect with its own test.
