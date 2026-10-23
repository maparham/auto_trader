# Picked Trendline Operand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart click on a Trendlines line while "pick from chart" is armed freezes that line into the rule as `L1`, `L2`, ...; backtest, live and screener rules evaluate it, and a dashed clone stays on the chart while a rule uses it.

**Architecture:** Each rule holder keeps a `lines` map (`{L1: PickedLine}`) beside its rule text and sends the referenced subset with every request. The backend parses a bare `L<digits>` to `N.LineRef`, and resolves lines into the SAME `instances` dict panes use (key `line:L1`, value `LineInstance`), so every existing `instances` thread (compile, validate, workers rebuilding from `req_dict`) carries them for free. An async pre-pass rebases lines whose anchors fall before the loaded bars. On the frontend a new overlay manager draws one deduped clone per line.

**Tech Stack:** Python 3 / FastAPI / pydantic / pytest (backend), TypeScript / React / klinecharts / vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-23-picked-trendline-operand-design.md`

## Global Constraints

- Line ids match `^L\d+$`. Reserved: no pane may be named or minted as one.
- At most 16 lines per request; finite numbers; `t2 > t1`; known native timeframe; else 422.
- A line's value starts at its 2nd anchor (t2), extends right forever; None before t2.
- Other symbol (epic or broker differs): every value None, no warning.
- Rule timeframe finer than or equal to the line's: allowed (coarser line aligned like an HTF pin). Rule timeframe COARSER than the line's: 422 `line_tf_finer` (screener: `screen_tf_lower`, same as a finer pin).
- UI copy: no em dashes, no `--` (memory: no-em-dashes). Tooltips via `Tooltip`/`InfoTip`, never `title=`.
- Frontend tests: run ONLY the affected files (`cd frontend && npx vitest run <files>`); never the whole suite. Typecheck is `npx tsc -b` (ask the user before running it; it is CPU heavy).
- Backend tests: `cd backend && python3 -m pytest <files> -q`.
- Commit to the current branch (main). Stage files by explicit path; never `git add -A`, never stash.

## Review Focus

1. A pane already saved under the name `L1`: dotted `L1.x` must still resolve to the pane, bare `L1` to the line. Test in Task 2.
2. A line held by the backtest config whose epic is US100, run on GOLD: no values, no 422, no warning. Test in Task 3.
3. A backtest range that ends before t2: all None, no warning (not "could not be placed"). Test in Task 1.
4. The live engine running past 1500 bars: the line still has values (rebase writes back into the armed snapshot). Test in Task 11.
5. Same line picked into the backtest as `L1` and the screener as `L2`: one clone labelled `L1 · L2`. Test in Task 13.

---

### Task 1: Backend line model and value math

**Files:**
- Create: `backend/auto_trader/strategy/expr/lines.py`
- Test: `backend/tests/test_expr_lines.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True, slots=True) class PickedLine: epic: str; broker: str; timeframe: str; t1: int; p1: float; t2: int; p2: float; slope: float; tRef: int; pRef: float`
  - `class LineSpecError(Exception)` with `.code: str`, `.message: str`
  - `LINE_ID_RE = re.compile(r"L\d+")` (use with `fullmatch`)
  - `MAX_LINES = 16`
  - `def parse_lines(raw: dict[str, dict] | None) -> dict[str, PickedLine]` (raises `LineSpecError`)
  - `def line_series(line: PickedLine | None, candles: Sequence[Candle]) -> list[float | None]`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_expr_lines.py
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.types import Candle  # same import test_expr_evaluate.py uses; adjust if it differs there
from auto_trader.strategy.expr.lines import (
    LineSpecError, PickedLine, line_series, parse_lines,
)

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
H = 3600_000


def _candles(n, start_k=0):
    return [Candle(time=BASE + timedelta(hours=start_k + k), open=1, high=1, low=1, close=1, volume=1.0)
            for k in range(n)]


def _ms(k):
    return int((BASE + timedelta(hours=k)).timestamp() * 1000)


def _line(**kw):
    d = dict(epic="US100", broker="capital", timeframe="HOUR", t1=_ms(2), p1=100.0,
             t2=_ms(5), p2=103.0, slope=1.0, tRef=_ms(8), pRef=106.0)
    d.update(kw)
    return PickedLine(**d)


def test_values_start_at_t2_and_extend_right():
    vals = line_series(_line(), _candles(10))
    assert vals[:5] == [None] * 5
    assert vals[5:] == [103.0, 104.0, 105.0, 106.0, 107.0]


def test_t2_bisect_finds_first_bar_at_or_after_t2():
    # t2 half a bar late (a broker's shifted bar times): anchors on bar 6
    vals = line_series(_line(t2=_ms(5) + H // 2), _candles(10))
    assert vals[5] is None and vals[6] == 103.0


def test_falls_back_to_tref_when_t2_before_candles():
    # candles start at k=7: t2 (k=5) is before them, tRef (k=8) is inside
    vals = line_series(_line(), _candles(4, start_k=7))
    assert vals == [105.0, 106.0, 107.0, 108.0]


def test_range_ending_before_t2_is_all_none():
    assert line_series(_line(), _candles(4)) == [None] * 4


def test_none_line_is_all_none():
    assert line_series(None, _candles(3)) == [None] * 3


def test_parse_lines_round_trip_and_caps():
    raw = {"L1": {"epic": "US100", "broker": "capital", "timeframe": "HOUR", "t1": _ms(2), "p1": 1,
                  "t2": _ms(5), "p2": 2, "slope": 0.5, "tRef": _ms(8), "pRef": 3}}
    assert parse_lines(raw)["L1"].p2 == 2.0
    with pytest.raises(LineSpecError):
        parse_lines({"X1": raw["L1"]})
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "t2": _ms(1)}})          # t2 <= t1
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "slope": float("nan")}})
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "timeframe": "SECOND"}})
    with pytest.raises(LineSpecError):
        parse_lines({f"L{i}": raw["L1"] for i in range(17)})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && python3 -m pytest tests/test_expr_lines.py -q`
Expected: FAIL, `ModuleNotFoundError: auto_trader.strategy.expr.lines`

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/strategy/expr/lines.py
"""Picked trendlines: a line the user froze off the chart, referenced in a rule
as a bare L<n>. Geometry is the line alert's (alertLineOf in the frontend's
trendlineMarks.ts): slope is price per bar of the line's OWN timeframe, so the
value is counted in bars, never in wall-clock time."""
from __future__ import annotations

import bisect
import math
import re
from dataclasses import dataclass
from typing import Sequence

from auto_trader.core.candle_aggregate import resolution_seconds

LINE_ID_RE = re.compile(r"L\d+")
MAX_LINES = 16


class LineSpecError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass(frozen=True, slots=True)
class PickedLine:
    epic: str
    broker: str
    timeframe: str
    t1: int
    p1: float
    t2: int
    p2: float
    slope: float
    tRef: int
    pRef: float


def _native(tf: str) -> bool:
    if tf.startswith("SECOND"):
        return False
    try:
        resolution_seconds(tf)
    except ValueError:
        return False
    return True


def parse_lines(raw: dict[str, dict] | None) -> dict[str, PickedLine]:
    raw = raw or {}
    if len(raw) > MAX_LINES:
        raise LineSpecError("too_many_lines", f"A rule set can hold at most {MAX_LINES} picked lines.")
    out: dict[str, PickedLine] = {}
    for lid, d in raw.items():
        if not LINE_ID_RE.fullmatch(lid):
            raise LineSpecError("bad_line_id", f"{lid} is not a picked line id.")
        try:
            line = PickedLine(
                epic=str(d["epic"]), broker=str(d["broker"]), timeframe=str(d["timeframe"]),
                t1=int(d["t1"]), p1=float(d["p1"]), t2=int(d["t2"]), p2=float(d["p2"]),
                slope=float(d["slope"]), tRef=int(d["tRef"]), pRef=float(d["pRef"]),
            )
        except (KeyError, TypeError, ValueError):
            raise LineSpecError("bad_line", f"{lid} is missing part of its geometry.") from None
        if not all(math.isfinite(v) for v in (line.p1, line.p2, line.slope, line.pRef)):
            raise LineSpecError("bad_line", f"{lid} has a non-finite price or slope.")
        if line.t2 <= line.t1:
            raise LineSpecError("bad_line", f"{lid} has its anchors out of order.")
        if not _native(line.timeframe):
            raise LineSpecError("bad_line", f"{lid} is on an unsupported timeframe.")
        out[lid] = line
    return out


def _ms(c) -> int:
    return int(c.time.timestamp() * 1000)


def line_series(line: PickedLine | None, candles: Sequence) -> list[float | None]:
    n = len(candles)
    if line is None or n == 0:
        return [None] * n
    times = [_ms(c) for c in candles]
    start = bisect.bisect_left(times, line.t2)  # first bar at or after t2
    if start >= n:
        return [None] * n                       # range ends before the line exists
    if times[0] <= line.t2:
        j, q = start, line.p2
    else:
        jr = bisect.bisect_left(times, line.tRef)
        if jr >= n or line.tRef < times[0]:
            return [None] * n                   # no anchor inside: the rebase pre-pass failed
        j, q = jr, line.pRef
    return [None if k < start else q + line.slope * (k - j) for k in range(n)]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_expr_lines.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/lines.py backend/tests/test_expr_lines.py
git commit -m "feat(expr): picked line model and value math"
```

---

### Task 2: Parse and validate `L<n>`

**Files:**
- Modify: `backend/auto_trader/strategy/expr/nodes.py` (add node, add to `Node` union at ~149, walkers)
- Modify: `backend/auto_trader/strategy/expr/parser.py:221` (`parse_primary` NAME branch)
- Modify: `backend/auto_trader/strategy/expr/validate.py` (`_walk`)
- Modify: `backend/auto_trader/strategy/expr/warmup.py:22` (`warmup_bars`), `literals.py` (only if it raises on unknown nodes)
- Modify: `frontend/src/lib/expr/parser.ts:888-901` (lint parity) and `frontend/src/lib/expr/corpus.json`
- Test: `backend/tests/test_expr_parser.py`, `backend/tests/test_expr_validate.py`, `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: `LINE_ID_RE` (Task 1)
- Produces:
  - `@dataclass(frozen=True, slots=True) class LineRef: id: str; start: int; end: int` in nodes.py
  - `LINE_KEY_PREFIX = "line:"` in `lines.py`, and `def line_key(lid: str) -> str: return LINE_KEY_PREFIX + lid`
  - validate error codes `unknown_line_ref` ("L3 is not one of this rule's lines.")
  - frontend `analyze(doc, { isExit, instances, lines?: ReadonlySet<string> })`

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_expr_parser.py
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.parser import parse

def test_bare_line_id_parses_to_lineref():
    row = parse("candle.close > L1")
    cond = row.conditions[0] if hasattr(row, "conditions") else row
    assert any(isinstance(x, N.LineRef) and x.id == "L1" for x in _walk_nodes(cond))

def test_dotted_l1_still_an_indicator_ref():
    row = parse("L1.tl_1 > 0")
    assert any(isinstance(x, N.IndicatorRef) and x.instance == "L1" for x in _walk_nodes(row))

def _walk_nodes(node):
    import dataclasses
    yield node
    if dataclasses.is_dataclass(node):
        for f in dataclasses.fields(node):
            v = getattr(node, f.name)
            for c in (v if isinstance(v, (list, tuple)) else [v]):
                if dataclasses.is_dataclass(c):
                    yield from _walk_nodes(c)
```

```python
# append to backend/tests/test_expr_validate.py
import pytest
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.lines import LineInstance, line_key  # LineInstance lands in Task 3; keep this test skipped until then
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

def test_line_ref_without_instances_is_accepted():
    validate(parse("candle.close > L1"), is_exit=False)            # no instances: lint/corpus mode

def test_unknown_line_ref_with_instances():
    with pytest.raises(ExprError) as e:
        validate(parse("candle.close > L3"), is_exit=False, instances={})
    assert e.value.code == "unknown_line_ref"
    assert e.value.message == "L3 is not one of this rule's lines."
```

```ts
// append to frontend/src/lib/expr/parser.test.ts
import { analyze } from "./parser";
it("accepts a bare picked line id without a lines set", () => {
  expect(analyze("candle.close > L1", { isExit: false }).error).toBeNull();
});
it("flags a line id missing from the holder's lines", () => {
  const { error } = analyze("candle.close > L3", { isExit: false, lines: new Set(["L1"]) });
  expect(error?.code).toBe("unknown_line_ref");
});
```

(If `analyze` is not the exported name, use the function `lint.ts:25` calls.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_expr_parser.py tests/test_expr_validate.py -q -k "line"` and `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: FAIL (`LineRef` missing; `unknown_name` instead of acceptance)

- [ ] **Step 3: Implement**

nodes.py, next to `IndicatorRef`:

```python
@dataclass(frozen=True, slots=True)
class LineRef:
    """A picked trendline, written as a bare L<n>. Its geometry travels on the
    request's `lines` map and is resolved into `instances` under line:L<n>."""
    id: str
    start: int
    end: int
```

Add `LineRef` to the `Node` union. In `contains_series` add `LineRef` to the tuple that returns True. `contains_tf`, `first_tf`, `_constant_value`, `contains_bars_since_entry`, `part_operands` already fall through correctly for a leaf; confirm each returns its leaf default for an unknown leaf and add an explicit `isinstance(node, LineRef)` leaf branch where the default would raise.

parser.py `parse_primary`, immediately before the `("x","X")` check at line 221:

```python
            if LINE_ID_RE.fullmatch(name.value) and self.peek().type != "DOT":
                return N.LineRef(name.value, name.start, name.end)
```

(import `LINE_ID_RE` from `.lines`). A following DOT keeps today's path, so `L1.tl_1` still becomes an `IndicatorRef` in `parse_postfix`.

lines.py:

```python
LINE_KEY_PREFIX = "line:"

def line_key(lid: str) -> str:
    return LINE_KEY_PREFIX + lid
```

validate.py `_walk`, near the top:

```python
    if isinstance(node, N.LineRef):
        if instances is not None and line_key(node.id) not in instances:
            raise ExprError("unknown_line_ref", f"{node.id} is not one of this rule's lines.",
                            node.start, node.end)
        return
```

warmup.py `warmup_bars`: `if isinstance(node, N.LineRef): return 0`.

Frontend parser.ts: the frontend keeps a zero-arg `Call`; in `walk`, right before the `const inst = instances.get(node.name)` block (~888):

```ts
      if (node.args.length === 0 && /^L\d+$/.test(node.name)) {
        if (lines && !lines.has(node.name)) {
          throw new ExprErr("unknown_line_ref", `${node.name} is not one of this rule's lines.`, node.start, node.end);
        }
        return;
      }
```

Thread `lines?: ReadonlySet<string>` from the `analyze` opts (~1157) into `walk` the same way `instances` is threaded. Lint (`lint.ts:22-25`) gains an optional `lines` param passed through.

corpus.json: append

```json
  { "expr": "candle.close > L1", "isExit": false, "error": null, "literals": [] },
```

(Match the exact entry shape of neighbours; if `literals` for a no-literal row is spelled differently, copy that.)

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_expr_parser.py tests/test_expr_validate.py tests/test_expr_parser_corpus.py tests/test_expr_nodes.py tests/test_expr_warmup.py -q` and `cd frontend && npx vitest run src/lib/expr/parser.test.ts src/lib/expr/corpus.test.ts`
Expected: PASS (the `LineInstance` import in test_expr_validate: mark that test module-level import inside the test or defer the import until Task 3 if collection fails)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/nodes.py backend/auto_trader/strategy/expr/parser.py backend/auto_trader/strategy/expr/validate.py backend/auto_trader/strategy/expr/warmup.py backend/auto_trader/strategy/expr/lines.py backend/tests/test_expr_parser.py backend/tests/test_expr_validate.py frontend/src/lib/expr/parser.ts frontend/src/lib/expr/lint.ts frontend/src/lib/expr/corpus.json frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): parse bare L<n> as a picked line ref"
```

---

### Task 3: Resolve lines into instances and evaluate them

**Files:**
- Modify: `backend/auto_trader/strategy/expr/lines.py` (add `LineInstance`, `line_instances`)
- Modify: `backend/auto_trader/api/sweep_apply.py:110-153` (`request_instances`, `referenced_tfs`)
- Modify: `backend/auto_trader/api/htf_source.py:52-55` (`_pin_owner` must skip lines)
- Modify: `backend/auto_trader/strategy/expr/evaluate.py:331` (`series_of`)
- Modify: `backend/auto_trader/api/schemas.py` (`PickedLineDTO`; `lines` on BacktestRequest 339, EvaluateRequest 729, ExprBacktestRequest 832, ExprSeriesRequest 883, ExprClosenessRequest 904)
- Test: `backend/tests/test_expr_lines.py`, `backend/tests/test_expr_instances_threading.py`

**Interfaces:**
- Consumes: Task 1 `PickedLine`, `parse_lines`, `line_series`; Task 2 `LineRef`, `line_key`
- Produces:
  - `class LineInstance: type = "LINE"; line: PickedLine; active: bool; spec = _NO_PIN_SPEC` where `_NO_PIN_SPEC.timeframe(cfg) -> None` and `.config = None` (so `_pin_owner` and any `inst.spec.timeframe(inst.config)` call stay safe). `active` is False for another symbol's line.
  - `def line_instances(lines: dict[str, PickedLine], *, epic: str, broker: str, resolution: str) -> dict[str, LineInstance]` (raises `LineSpecError("line_tf_finer", ...)`)
  - `class PickedLineDTO(BaseModel)` with the ten PickedLine fields; `lines: dict[str, PickedLineDTO] = {}` on the five requests
  - `request_instances(req)` now returns panes PLUS lines

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_expr_lines.py
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.lines import LineInstance, line_instances, line_key
from auto_trader.strategy.expr.parser import parse


def test_other_symbol_line_is_all_none():
    inst = line_instances({"L1": _line()}, epic="GOLD", broker="capital", resolution="HOUR")
    assert inst[line_key("L1")].active is False
    row = compile_row(parse("candle.close < L1"), _candles(10), "HOUR", {}, inst)
    assert [row.evaluate(i, None) for i in range(10)] == [False] * 10


def test_same_symbol_line_evaluates():
    inst = line_instances({"L1": _line()}, epic="US100", broker="capital", resolution="HOUR")
    row = compile_row(parse("candle.close < L1"), _candles(10), "HOUR", {}, inst)
    assert [row.evaluate(i, None) for i in range(10)] == [False] * 5 + [True] * 5


def test_rule_coarser_than_line_refused():
    with pytest.raises(LineSpecError) as e:
        line_instances({"L1": _line(timeframe="MINUTE_15")}, epic="US100", broker="capital", resolution="HOUR")
    assert e.value.code == "line_tf_finer"


def test_coarser_line_is_aligned_from_htf_candles():
    line = _line(timeframe="HOUR_4", t1=_ms(0), t2=_ms(4), p2=10.0, slope=1.0, tRef=_ms(8), pRef=11.0)
    inst = line_instances({"L1": line}, epic="US100", broker="capital", resolution="HOUR")
    h4 = [Candle(time=BASE + timedelta(hours=4 * k), open=1, high=1, low=1, close=1, volume=1.0) for k in range(4)]
    from auto_trader.strategy.expr.evaluate import series_of
    from auto_trader.strategy.expr import nodes as N
    vals = series_of(N.LineRef("L1", 0, 2), _candles(16), "HOUR", {"HOUR_4": h4}, inst)
    assert vals[0] is None and vals[-1] is not None
```

```python
# append to backend/tests/test_expr_instances_threading.py
def test_request_instances_includes_lines():
    from types import SimpleNamespace
    from auto_trader.api.sweep_apply import request_instances
    from auto_trader.strategy.expr.lines import line_key
    req = SimpleNamespace(indicators={}, epic="US100", broker="capital", resolution="HOUR", lines={
        "L1": SimpleNamespace(model_dump=lambda: dict(epic="US100", broker="capital", timeframe="HOUR",
            t1=1, p1=1.0, t2=2, p2=1.0, slope=0.0, tRef=2, pRef=1.0))})
    assert line_key("L1") in request_instances(req)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_expr_lines.py tests/test_expr_instances_threading.py -q`
Expected: FAIL (`ImportError: LineInstance`)

- [ ] **Step 3: Implement**

lines.py:

```python
class _NoPinSpec:
    @staticmethod
    def timeframe(_cfg) -> None:
        return None

    @staticmethod
    def outputs(_cfg) -> list[str]:
        return []


_NO_PIN_SPEC = _NoPinSpec()


class LineInstance:
    """A picked line riding in the `instances` dict under line:L<n>. `active`
    is False when the line belongs to another symbol: the operand is then
    absent on every bar, which is not an error (a global backtest config run
    elsewhere). The geometry stays either way, so a screen compiled before it
    knows its symbols still fetches the line's timeframe."""
    type = "LINE"
    config = None
    spec = _NO_PIN_SPEC

    def __init__(self, line: PickedLine, active: bool = True):
        self.line = line
        self.active = active


def line_instances(lines: dict[str, PickedLine], *, epic: str, broker: str,
                   resolution: str) -> dict[str, LineInstance]:
    rule_s = resolution_seconds(resolution)
    out: dict[str, LineInstance] = {}
    for lid, line in lines.items():
        if resolution_seconds(line.timeframe) < rule_s:
            raise LineSpecError(
                "line_tf_finer",
                f"{lid} was picked on {line.timeframe}; run this rule on {line.timeframe} or a finer timeframe.")
        same = line.epic == epic and (not broker or not line.broker or line.broker == broker)
        out[line_key(lid)] = LineInstance(line, active=same)
    return out
```

sweep_apply.py `request_instances`:

```python
def request_instances(req) -> dict:
    out = resolve_instances({k: v.model_dump() for k, v in (req.indicators or {}).items()})
    raw_lines = {k: v.model_dump() for k, v in (getattr(req, "lines", None) or {}).items()}
    if raw_lines:
        resolution = getattr(req, "resolution", None) or getattr(req, "baseResolution")
        out.update(line_instances(parse_lines(raw_lines), epic=req.epic,
                                  broker=getattr(req, "broker", "") or "", resolution=resolution))
    return out
```

`LineSpecError` must surface as 422. Wrap at the one place that catches request errors per handler: in each handler that calls `request_instances` (expr_exec.py:145, routers/expr.py:286/340/375/437, routers/strategy.py:161, sweep_apply.py:216/305), change to:

```python
    try:
        instances = request_instances(req)
    except LineSpecError as e:
        raise HTTPException(422, {"code": e.code, "message": e.message, "start": 0, "end": 0})
```

(`sweep_apply.py` raises `SweepValidationError(422, e.message)` instead, matching its own style.)

`referenced_tfs` in sweep_apply.py:

```python
    if isinstance(node, N.LineRef):
        inst = (instances or {}).get(line_key(node.id))
        return {inst.line.timeframe} if inst is not None and inst.active else set()
```

The HTF fetch then treats a line's timeframe like a pin. If the line's timeframe equals the rule's, the existing code must not fetch it as HTF: check how `_ensure_htf` handles `tf == resolution` and, if it would fetch, filter `tf != req.resolution` at the `referenced_tfs` call site for lines only.

htf_source.py `_pin_owner`: no change needed once `LineInstance.spec.timeframe` returns None; add a test-free assertion by reading it.

evaluate.py `series_of`, before the `IndicatorRef` branch:

```python
    if isinstance(node, N.LineRef):
        inst = (instances or {}).get(line_key(node.id))
        if inst is None or not inst.active:
            return [None] * n
        line = inst.line
        if resolution_seconds(line.timeframe) == resolution_seconds(resolution):
            return line_series(line, candles)
        tf_candles = htf.get(line.timeframe) or []
        if not tf_candles:
            return [None] * n
        tf_vals = line_series(line, tf_candles)
        base_ms = [int(c.time.timestamp() * 1000) for c in candles]
        return align_htf_to_base(base_ms, tf_candles, tf_vals, resolution_seconds(line.timeframe) * 1000,
                                 base_interval_ms=base_interval_ms_of(resolution),
                                 htf_resolution=line.timeframe)
```

(Use the same `n`, `resolution_seconds`, `align_htf_to_base`, `base_interval_ms_of` names the `Tf` branch at 274-292 already uses.)

schemas.py:

```python
class PickedLineDTO(BaseModel):
    epic: str
    broker: str = ""
    timeframe: str
    t1: int
    p1: float
    t2: int
    p2: float
    slope: float
    tRef: int
    pRef: float
```

and `lines: dict[str, PickedLineDTO] = {}` on BacktestRequest, EvaluateRequest, ExprBacktestRequest, ExprSeriesRequest, ExprClosenessRequest (beside each `indicators`). ExprClosenessRequest has `baseResolution`, which `request_instances` reads.

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_expr_lines.py tests/test_expr_instances_threading.py tests/test_expr_evaluate.py tests/test_api_expr.py tests/test_expr_evaluate_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/lines.py backend/auto_trader/strategy/expr/evaluate.py backend/auto_trader/api/sweep_apply.py backend/auto_trader/api/schemas.py backend/auto_trader/api/expr_exec.py backend/auto_trader/api/routers/expr.py backend/auto_trader/api/routers/strategy.py backend/tests/test_expr_lines.py backend/tests/test_expr_instances_threading.py
git commit -m "feat(expr): evaluate picked lines through the instances map"
```

---

### Task 4: Server rebase pre-pass and warnings

**Files:**
- Create: `backend/auto_trader/api/line_rebase.py`
- Modify: `backend/auto_trader/api/expr_exec.py` (before compile), `backend/auto_trader/api/routers/expr.py` (series 375, closeness 437, sweep 286, wfo 340), `backend/auto_trader/api/routers/strategy.py:161`
- Modify: `backend/auto_trader/api/schemas.py`: `warnings: list[str] = []` on `BacktestResponse` (182) and `EvaluateResponse` (768); series route dict gains `"warnings"`
- Test: `backend/tests/test_line_rebase.py`

**Interfaces:**
- Consumes: `PickedLineDTO`, `parse_lines`, `resolution_seconds`, `deps.load_alert_bars(broker_id, epic, resolution, side, count) -> tuple[list[Candle], bool]`
- Produces:
  - `REBASE_MAX_BARS = 5000`
  - `async def rebase_lines(lines: dict[str, PickedLineDTO], *, first_ms: int, side: str, loader) -> list[str]` mutates each DTO's `tRef`/`pRef` in place and returns warnings like `"L1 could not be placed on the loaded bars."`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_line_rebase.py
import asyncio
from datetime import datetime, timedelta, timezone

from auto_trader.api.line_rebase import rebase_lines
from auto_trader.api.schemas import PickedLineDTO
from auto_trader.core.types import Candle  # same Candle import as Task 1

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _ms(k):
    return int((BASE + timedelta(hours=k)).timestamp() * 1000)


def _bars(n):
    return [Candle(time=BASE + timedelta(hours=k), open=1, high=1, low=1, close=1, volume=1.0) for k in range(n)]


def _dto(**kw):
    d = dict(epic="US100", broker="capital", timeframe="HOUR", t1=_ms(0), p1=1.0, t2=_ms(2), p2=2.0,
             slope=0.5, tRef=_ms(10), pRef=6.0)
    d.update(kw)
    return PickedLineDTO(**d)


def test_rebases_to_first_loaded_bar():
    lines = {"L1": _dto()}
    async def loader(broker, epic, res, side, count):
        return _bars(100), False
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), side="mid", loader=loader))
    assert warns == []
    assert lines["L1"].tRef == _ms(50) and lines["L1"].pRef == 6.0 + 0.5 * 40


def test_anchor_inside_range_is_untouched():
    lines = {"L1": _dto()}
    async def loader(*a):
        raise AssertionError("must not fetch")
    assert asyncio.run(rebase_lines(lines, first_ms=_ms(5), side="mid", loader=loader)) == []
    assert lines["L1"].tRef == _ms(10)


def test_fetch_failure_warns():
    lines = {"L1": _dto()}
    async def loader(*a):
        return [], True
    warns = asyncio.run(rebase_lines(lines, first_ms=_ms(50), side="mid", loader=loader))
    assert warns == ["L1 could not be placed on the loaded bars."]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_line_rebase.py -q`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/api/line_rebase.py
"""Move a picked line's reference bar up to the first loaded bar when both of
its anchors sit before the loaded range (a screen or backtest run long after
the pick). Counting bars needs the line's own timeframe history, so this is an
async pre-pass in the handler, before the sync compile."""
from __future__ import annotations

import bisect
import time

from auto_trader.core.candle_aggregate import resolution_seconds

REBASE_MAX_BARS = 5000


def _ms(c) -> int:
    return int(c.time.timestamp() * 1000)


async def rebase_lines(lines, *, first_ms: int, side: str, loader) -> list[str]:
    warnings: list[str] = []
    for lid, ln in lines.items():
        if ln.t2 >= first_ms or ln.tRef >= first_ms:
            continue  # an anchor is inside (or the line starts after) the range
        period_ms = resolution_seconds(ln.timeframe) * 1000
        count = min(REBASE_MAX_BARS, (int(time.time() * 1000) - ln.tRef) // period_ms + 50)
        try:
            bars, degraded = await loader(ln.broker, ln.epic, ln.timeframe, side, count)
        except Exception:
            bars, degraded = [], True
        times = [_ms(c) for c in bars]
        i_ref = bisect.bisect_left(times, ln.tRef)
        i_first = bisect.bisect_left(times, first_ms)
        if degraded or not times or times[0] > ln.tRef or i_first >= len(times):
            warnings.append(f"{lid} could not be placed on the loaded bars.")
            continue
        ln.pRef = ln.pRef + ln.slope * (i_first - i_ref)
        ln.tRef = times[i_first]
    return warnings
```

Wire into each handler BEFORE `request_instances(req)` (so the rebased DTOs are what workers re-read from `req_dict`). `first_ms` is the first candle the rule is evaluated on, on the request's own resolution: for `/api/expr/backtest` (expr_exec.py) the first element of the candles it compiles on; for routes that fetch candles themselves (series, closeness), the first fetched candle; for `/api/strategy` evaluate, `req.candles[0]`. Only lines matching the request's epic are rebased (`{k: v for k, v in req.lines.items() if v.epic == req.epic}`).

```python
    warnings = await rebase_lines(
        {k: v for k, v in req.lines.items() if v.epic == req.epic},
        first_ms=first_ms, side=req.priceSide or "mid", loader=deps.load_alert_bars)
```

Return `warnings` on the response: `BacktestResponse(..., warnings=warnings)`, `EvaluateResponse(actions=..., warnings=warnings)`, series dict `"warnings": warnings`. Closeness drops them (a heatmap has nowhere to show one).

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_line_rebase.py tests/test_api_expr.py tests/test_expr_evaluate_api.py tests/test_expr_sweep*.py tests/test_expr_wfo.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/line_rebase.py backend/auto_trader/api/expr_exec.py backend/auto_trader/api/routers/expr.py backend/auto_trader/api/routers/strategy.py backend/auto_trader/api/schemas.py backend/tests/test_line_rebase.py
git commit -m "feat(expr): rebase picked lines onto the loaded bars"
```

---

### Task 5: Screener backend

The screener already fetches pinned timeframes per symbol (`api/htf_source.py`, `htf_needs` over `sweep_apply.referenced_tfs`, which Task 3 taught about `LineRef`). A line therefore behaves like a pin: its timeframe at the screen's or coarser is fetched and aligned; finer is refused with `screen_tf_lower`. Re-read `core/screen_eval.py` and `api/screen_jobs.py` before starting; both changed on 2026-10-23.

**Files:**
- Modify: `backend/auto_trader/core/screen_eval.py` (`compile_screen` 131, `_check_pins` 90, `judge` 177)
- Modify: `backend/auto_trader/api/screen_jobs.py` (the per-symbol `_one`: rebase, pass epic/broker to `judge`)
- Modify: `backend/auto_trader/api/routers/screens.py` (`ScreenRunBody` gains `lines`, `_compile`, `_data`)
- Modify: `backend/auto_trader/core/screen_store.py` (DDL, ALTER loop, `_row`, `create`, `update`)
- Test: `backend/tests/test_screen_eval.py`, `backend/tests/test_screen_store.py`

**Interfaces:**
- Consumes: `parse_lines`, `line_instances`, `LineInstance`, `line_key`, `rebase_lines`, `LineSpecError`
- Produces:
  - `compile_screen(expression, columns, indicators=None, resolution="DAY", lines=None) -> CompiledScreen`; `CompiledScreen.lines: dict[str, PickedLine]`; its `instances` include every line as ACTIVE (so `htf_needs` fetches line timeframes for every symbol)
  - `judge(cs, bars, resolution, htf=None, *, epic: str = "", broker: str = "") -> Judgement` rebuilds line instances for that symbol
  - saved screen column `lines TEXT NOT NULL DEFAULT '{}'`

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_screen_eval.py
_LINE = {"L1": {"epic": "AAA", "broker": "b", "timeframe": "HOUR", "t1": 0, "p1": 0.0,
                "t2": int(T0.timestamp() * 1000), "p2": 10.0, "slope": 0.0,
                "tRef": int(T0.timestamp() * 1000), "pRef": 10.0}}

def test_line_matches_only_its_own_symbol():
    cs = compile_screen("candle.close > L1", [], resolution="HOUR", lines=_LINE)
    assert judge(cs, _bars([5, 5, 11]), "HOUR", epic="AAA", broker="b").matched
    assert not judge(cs, _bars([5, 5, 11]), "HOUR", epic="BBB", broker="b").matched

def test_line_finer_than_screen_refused():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > L1", [], resolution="DAY", lines=_LINE)
    assert e.value.error.code == "screen_tf_lower"   # use the attribute ScreenSpecError actually exposes
    assert "L1 was picked on" in e.value.error.message

def test_unknown_line_in_screen():
    with pytest.raises(ScreenSpecError):
        compile_screen("candle.close > L2", [], resolution="HOUR", lines=_LINE)
```

Add a store round-trip to `test_screen_store.py` mirroring that file's existing `indicators` round-trip test, with `lines=_LINE`-shaped data.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_screen_eval.py tests/test_screen_store.py -q`
Expected: FAIL (unexpected kwarg `lines`)

- [ ] **Step 3: Implement**

screen_eval.py `compile_screen(..., lines=None)`:

```python
    try:
        parsed_lines = parse_lines(lines)
    except LineSpecError as e:
        raise ScreenSpecError("expression", 0, ExprError(e.code, e.message, 0, len(expression))) from e
    instances = {**resolve_instances(indicators or {}),
                 **{line_key(k): LineInstance(v) for k, v in parsed_lines.items()}}
```

and store `parsed_lines` on `CompiledScreen.lines`. Columns compile with the same `instances`.

`_check_pins`: before the pinned-pane loop, check lines with their own wording, then exclude their timeframes from the generic loop so it never says "An indicator is pinned":

```python
    line_tfs: set[str] = set()
    for n in _walk(node):
        if isinstance(n, N.LineRef) and (inst := instances.get(line_key(n.id))) is not None:
            tf = inst.line.timeframe
            if resolution_seconds(tf) < base_s:
                raise ExprError("screen_tf_lower",
                                f"{n.id} was picked on {tf}, lower than this screen's {_label(resolution)}. "
                                f"Run the screen on {tf}.", n.start, n.end)
            line_tfs.add(tf)
    for tf in sorted(referenced_tfs(node, instances) - {n.tf for n in tokens} - line_tfs):
```

`judge(cs, bars, resolution, htf=None, *, epic="", broker="")`:

```python
    instances = {**cs.instances, **line_instances(cs.lines, epic=epic, broker=broker, resolution=resolution)}
    compiled = compile_row(cs.row, bars, resolution, htf, instances, source=cs.source)
```

(Columns compile with the same `instances`.) `line_instances` cannot raise `line_tf_finer` here: `_check_pins` refused that at compile.

screen_jobs.py per-symbol `_one`: if `cs.lines` holds lines for this `epic`, build `PickedLineDTO(**dataclasses.asdict(l))` copies, `warns = await rebase_lines(dtos, first_ms=int(bars[0].time.timestamp()*1000), side=side, loader=self._loader)`; on a warning append `{"epic": epic, "reason": warns[0]}` to skipped and do not judge; otherwise judge with a `cs` whose `lines` are the rebased ones (`dataclasses.replace(cs, lines={k: PickedLine(**d.model_dump()) ...})`, or pass them through a `lines=` override on `judge` if `CompiledScreen` is not a dataclass). Pass `epic=epic, broker=broker` to `judge`.

screens.py: `lines: dict[str, dict] = Field(default_factory=dict)` on `ScreenRunBody`; `_compile` passes `lines=body.lines`; `_data` includes `"lines": body.lines`.

screen_store.py: `lines TEXT NOT NULL DEFAULT '{}'` in the DDL, `("lines", "TEXT NOT NULL DEFAULT '{}'")` in the ALTER loop, `json.loads` in `_row`, `json.dumps` in `create`/`update`, exactly as `indicators` is handled.

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_screen_eval.py tests/test_screen_store.py tests/test_screen_jobs.py tests/test_api_screens.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/screen_eval.py backend/auto_trader/api/screen_jobs.py backend/auto_trader/api/routers/screens.py backend/auto_trader/core/screen_store.py backend/tests/test_screen_eval.py backend/tests/test_screen_store.py
git commit -m "feat(screener): picked lines in screens"
```

---

### Task 6: Frontend line model helpers

**Files:**
- Create: `frontend/src/lib/pickedLines.ts`
- Test: `frontend/src/lib/pickedLines.test.ts`

**Interfaces:**
- Consumes: `TrendlineSegment` (`lib/indicators/trendlineMarks.ts:123`), `alertTimeframeOf` (`lib/indicatorAlertInstance`), `isNativeTf`, `parseTf` (`lib/timeframe`)
- Produces:
  - `interface PickedLine { epic; broker; timeframe: string; t1; p1; t2; p2; slope; tRef; pRef: number }`
  - `type Lines = Record<string, PickedLine>`
  - `LINE_ID_RE = /^L\d+$/`
  - `referencedLineIds(rows: readonly string[]): Set<string>`
  - `mintLineId(lines: Lines | undefined): string`
  - `trimLines(lines: Lines | undefined, rows: readonly string[]): Lines | undefined` (undefined when empty)
  - `lineGeoKey(l: PickedLine): string`
  - `pickedLineFromSeg(args: { seg: TrendlineSegment; ext: Record<string, unknown> | undefined; resolution: string; epic: string; broker: string }): { line: PickedLine } | { reason: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/pickedLines.test.ts
import { describe, expect, it } from "vitest";
import { lineGeoKey, mintLineId, pickedLineFromSeg, referencedLineIds, trimLines, type PickedLine } from "./pickedLines";

const L: PickedLine = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };

describe("pickedLines", () => {
  it("finds bare ids, not dotted pane refs or calls", () => {
    expect([...referencedLineIds(["candle.close > L1", "L2.tl_1 > 0", "L3(1)", "xL4 > L12"])].sort()).toEqual(["L1", "L12"]);
  });
  it("mints the lowest free id", () => {
    expect(mintLineId(undefined)).toBe("L1");
    expect(mintLineId({ L1: L, L3: L })).toBe("L2");
  });
  it("trims to referenced ids", () => {
    expect(trimLines({ L1: L, L2: L }, ["close > L2"])).toEqual({ L2: L });
    expect(trimLines({ L1: L }, ["close > 1"])).toBeUndefined();
  });
  it("geo key ignores the moving reference", () => {
    expect(lineGeoKey(L)).toBe(lineGeoKey({ ...L, tRef: 99, pRef: 99 }));
  });
  it("refuses seconds and lines without geometry", () => {
    const seg = { key: "k", x0: 0, y0: 0, x1: 0, y1: 0, clone: () => null, alertLine: () => ({ slope: 1, tRef: 3, pRef: 3, t1: 1, p1: 1, t2: 2, p2: 2 }) };
    expect(pickedLineFromSeg({ seg, ext: undefined, resolution: "SECOND_30", epic: "US100", broker: "capital" })).toHaveProperty("reason");
    expect(pickedLineFromSeg({ seg: { ...seg, alertLine: () => null }, ext: undefined, resolution: "HOUR", epic: "US100", broker: "capital" })).toHaveProperty("reason");
    expect(pickedLineFromSeg({ seg, ext: undefined, resolution: "HOUR", epic: "US100", broker: "capital" })).toEqual({ line: L });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/pickedLines.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```ts
// frontend/src/lib/pickedLines.ts
// Picked trendlines: a Trendlines line frozen into a rule as a bare L<n>. Each
// rule holder (backtest config, armed live snapshot, screener) keeps a Lines
// map beside its text; requests send only the ids the text references. The
// geometry is the line alert's (alertLineOf), so the backend counts it in bars
// of the line's own timeframe.
import type { TrendlineSegment } from "./indicators/trendlineMarks";
import { alertTimeframeOf } from "./indicatorAlertInstance";
import { isNativeTf, parseTf } from "./timeframe";

export interface PickedLine {
  epic: string;
  broker: string;
  timeframe: string;
  t1: number; p1: number;
  t2: number; p2: number;
  slope: number;
  tRef: number; pRef: number;
}
export type Lines = Record<string, PickedLine>;

export const LINE_ID_RE = /^L\d+$/;
// A bare id: not preceded by a word char or ".", not followed by "." or "(".
const BARE_RE = /(?<![\w.#])L\d+\b(?!\s*[.(])/g;

export function referencedLineIds(rows: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const m of r.matchAll(BARE_RE)) out.add(m[0]);
  return out;
}

export function mintLineId(lines: Lines | undefined): string {
  for (let n = 1; ; n++) if (!lines || !(`L${n}` in lines)) return `L${n}`;
}

export function trimLines(lines: Lines | undefined, rows: readonly string[]): Lines | undefined {
  if (!lines) return undefined;
  const used = referencedLineIds(rows);
  const out: Lines = {};
  for (const [id, l] of Object.entries(lines)) if (used.has(id)) out[id] = l;
  return Object.keys(out).length ? out : undefined;
}

export function lineGeoKey(l: PickedLine): string {
  return [l.epic, l.broker, l.timeframe, l.t1, l.p1, l.t2, l.p2, l.slope].join("|");
}

export function pickedLineFromSeg(args: {
  seg: TrendlineSegment;
  ext: Record<string, unknown> | undefined;
  resolution: string;
  epic: string;
  broker: string;
}): { line: PickedLine } | { reason: string } {
  const timeframe = alertTimeframeOf(args.ext, args.resolution);
  try {
    if (parseTf(timeframe).unit === "SECOND") return { reason: "Lines can't be picked on seconds charts" };
  } catch {
    return { reason: "Lines can't be picked on this timeframe" };
  }
  if (!isNativeTf(timeframe)) return { reason: "Lines can't be picked on this timeframe yet" };
  const g = args.seg.alertLine?.() ?? null;
  if (!g) return { reason: "This line can't be picked yet" };
  return { line: { epic: args.epic, broker: args.broker, timeframe, ...g } };
}
```

(Check `alertTimeframeOf`'s parameter types against `chart/lineAlertDraft.ts` and match them.)

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/pickedLines.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/pickedLines.ts frontend/src/lib/pickedLines.test.ts
git commit -m "feat(lines): frontend picked line helpers"
```

---

### Task 7: Reserve `L<n>` pane names

**Files:**
- Modify: `frontend/src/lib/indicators.ts:378-440` (`mintInstanceId`, `validateInstanceName`)
- Modify: the rename UI copy for `"reserved"` only if it names the reason generically (check where `RenameInstanceError` is rendered; if it says "reserved name", no change)
- Test: `frontend/src/lib/indicators.test.ts`

**Interfaces:**
- Consumes: `LINE_ID_RE` (Task 6)
- Produces: `validateInstanceName(chart, "L1", id) === "reserved"`

- [ ] **Step 1: Write the failing test**

```ts
// append to frontend/src/lib/indicators.test.ts, reusing the chart stub the file's existing validateInstanceName tests use
it("reserves picked line ids", () => {
  expect(validateInstanceName(chart, "L1", "RSI")).toBe("reserved");
  expect(validateInstanceName(chart, "L12", "RSI")).toBe("reserved");
  expect(validateInstanceName(chart, "LR", "RSI")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/indicators.test.ts`
Expected: FAIL (`null` instead of `"reserved"`)

- [ ] **Step 3: Implement**

In `validateInstanceName`, in the `"reserved"` check: `if (RESERVED_REF_NAMES.has(candidate) || LINE_ID_RE.test(candidate) || ...) return "reserved";`. In `mintInstanceId`, add `|| LINE_ID_RE.test(candidate)` to the taken test inside the loop (no type mints `L<n>` today; this keeps it that way).

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators.ts frontend/src/lib/indicators.test.ts
git commit -m "feat(indicators): reserve L<n> for picked lines"
```

---

### Task 8: Pick a line from the chart

**Files:**
- Modify: `frontend/src/lib/chartController.ts:25-37` (`SelectedIndicator.line?`, `.lineRefusal?`)
- Modify: `frontend/src/ChartCore.tsx:2165-2192` (publish the hit line)
- Modify: `frontend/src/lib/useIndicatorPick.ts` (optional `onLine`)
- Test: `frontend/src/lib/useIndicatorPick.test.tsx`

**Interfaces:**
- Consumes: `pickedLineFromSeg` (Task 6)
- Produces:
  - `SelectedIndicator { paneId; name; lineIndex?; figureKey?; line?: PickedLine; lineRefusal?: string }`
  - `useIndicatorPick<T>(controller, onToken: (target: T, token: string) => void, onLine?: (target: T, line: PickedLine) => void)`

- [ ] **Step 1: Write the failing test**

```tsx
// append to frontend/src/lib/useIndicatorPick.test.tsx, using the file's existing controller stub + renderHook setup
it("hands a picked line to onLine instead of inserting a token", () => {
  const onToken = vi.fn();
  const onLine = vi.fn();
  const { result } = renderHook(() => useIndicatorPick<string>(controller, onToken, onLine));
  act(() => result.current!.arm("t"));
  const line = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };
  act(() => controller.indicatorPickResult.set({ paneId: "candle_pane", name: "TRENDLINES", line }));
  expect(onLine).toHaveBeenCalledWith("t", line);
  expect(onToken).not.toHaveBeenCalled();
});
it("toasts a line refusal and inserts nothing", () => {
  const onToken = vi.fn();
  const onLine = vi.fn();
  const { result } = renderHook(() => useIndicatorPick<string>(controller, onToken, onLine));
  act(() => result.current!.arm("t"));
  act(() => controller.indicatorPickResult.set({ paneId: "candle_pane", name: "TRENDLINES", lineRefusal: "nope" }));
  expect(onLine).not.toHaveBeenCalled();
  expect(onToken).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/useIndicatorPick.test.tsx`
Expected: FAIL (`onToken` called with `TRENDLINES.tl_1`)

- [ ] **Step 3: Implement**

chartController.ts `SelectedIndicator`: add `line?: PickedLine; lineRefusal?: string;`.

useIndicatorPick.ts: keep `onLineRef` like `onTokenRef`. In the subscriber, after clearing the armed state and before computing the token:

```ts
      if (sel.lineRefusal && onLineRef.current) { toast(sel.lineRefusal); return; }
      if (sel.line && onLineRef.current) { onLineRef.current(target, sel.line); return; }
```

A holder that passes no `onLine` (any future consumer) keeps today's token behaviour.

ChartCore.tsx at 2179, when `tlHit` produced the hit:

```ts
  if (hit && controller.indicatorPickArmed.value) {
    const lineMatch = /^slope(\d+)$/.exec(hit.figKey);
    let lineFields: { line?: PickedLine; lineRefusal?: string } = {};
    if (tlHit) {
      const inst = getIndicatorById(c, tlHit.name);   // the same lookup useTrendlineMenu uses for buildLineAlertDraft
      const r = pickedLineFromSeg({ seg: tlHit.seg, ext: inst?.extendData as Record<string, unknown> | undefined,
        resolution: periodRef.current.resolution, epic: symbolRef.current.epic, broker: brokerIdRef.current });
      lineFields = "line" in r ? { line: r.line } : { lineRefusal: r.reason };
    }
    controller.indicatorPickResult.set({ paneId: hit.paneId, name: hit.name,
      ...(lineMatch ? { lineIndex: Number(lineMatch[1]) } : {}), ...lineFields });
    return;
  }
```

Use whatever refs `useTrendlineMenu.tsx:340-354` reads for resolution, epic, broker and the instance's extendData; copy that access exactly.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/useIndicatorPick.test.tsx src/lib/exprPick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/chartController.ts frontend/src/ChartCore.tsx frontend/src/lib/useIndicatorPick.ts frontend/src/lib/useIndicatorPick.test.tsx
git commit -m "feat(pick): a chart click on a trendline picks that line"
```

---

### Task 9: Backtest holder, requests and autocomplete

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (`BacktestConfig.lines?: Lines`; `normalizeBacktestConfig` 242 keeps it; `backtestConfigEquals` 285 compares it with `JSON.stringify`)
- Modify: `frontend/src/backtestSettings/useExprPick.ts` (pass `onLine`)
- Modify: `frontend/src/BacktestButton.tsx` (565-652: send `lines`; toast `result.warnings`)
- Modify: `frontend/src/api.ts` (`lines?: Lines` on `BacktestRequest` 333, `ExprBacktestRequest` 381, `ClosenessRequest` 448; `warnings?: string[]` on the backtest response type)
- Modify: `frontend/src/chart/useProximityHeatmap.ts:118` (send `lines`)
- Modify: `frontend/src/lib/expr/complete.ts` (`CompleteOptions.lines?: Lines`, "Picked lines" section) and the backtest editor call sites that build `CompleteOptions` and lint opts (grep `cmCompletionSource(` and `lint(` in `backtestSettings/`)
- Test: `frontend/src/lib/expr/complete.test.ts`, `frontend/src/backtestSettings/useExprPick.test.ts` (create if absent)

**Interfaces:**
- Consumes: Tasks 6 and 8
- Produces: `BacktestConfig.lines?: Lines`; `completionsFor(doc, pos, { instances, lines })`

- [ ] **Step 1: Write the failing tests**

```ts
// append to frontend/src/lib/expr/complete.test.ts
it("offers picked lines in their own section", () => {
  const lines = { L1: { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 } };
  const out = completionsFor("candle.close > L", 16, { lines });
  const c = out.find((x) => x.label === "L1");
  expect(c?.detail).toBe("line · US100 · 1h");
  expect(c?.section).toEqual({ name: "Picked lines", rank: 3 });
});
```

(The `1h` label comes from the app's timeframe-label helper; use whichever function the `@tf` branch of `complete.ts` uses to show aliases, and assert its output for `HOUR`.)

```ts
// frontend/src/backtestSettings/useExprPick.test.ts
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { useExprPick } from "./useExprPick";
import { makeTestController } from "../lib/useIndicatorPick.test-helpers"; // or the stub the useIndicatorPick test builds inline; copy it here if not exported
import { DEFAULT_BACKTEST_CONFIG } from "../lib/backtestConfig";           // use the file's real default export name

it("a picked line appends L1 and stores the line", () => {
  const controller = makeTestController();
  const { result } = renderHook(() => {
    const [cfg, setCfg] = useState(DEFAULT_BACKTEST_CONFIG);
    return { cfg, pick: useExprPick(controller, setCfg) };
  });
  act(() => result.current.pick!.arm("longEntry", 0));
  const line = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };
  act(() => controller.indicatorPickResult.set({ paneId: "candle_pane", name: "TRENDLINES", line }));
  expect(result.current.cfg.longEntry.rules[0].expr).toMatch(/L1$/);
  expect(result.current.cfg.lines).toEqual({ L1: line });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/expr/complete.test.ts src/backtestSettings/useExprPick.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

useExprPick.ts: pass a third argument to `useIndicatorPick`:

```ts
    (target, line) =>
      setCfg((c) => {
        const id = Object.entries(c.lines ?? {}).find(([, l]) => lineGeoKey(l) === lineGeoKey(line))?.[0] ?? mintLineId(c.lines);
        const g = c[target.group];
        const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + id } : r));
        return { ...c, [target.group]: { ...g, rules }, lines: { ...(c.lines ?? {}), [id]: line } };
      }),
```

(Re-picking the same line reuses its id.)

backtestConfig.ts: `lines?: Lines` on `BacktestConfig`; `normalizeBacktestConfig` passes `lines` through; `backtestConfigEquals` adds `JSON.stringify(a.lines ?? {}) === JSON.stringify(b.lines ?? {})`. Saving the config (`saveBacktestLastUsed`) does NOT trim, so a rule temporarily cleared while editing keeps its line until Run.

BacktestButton.tsx: `const runLines = trimLines(effCfg.lines, runRows);` next to `exprIndicators` (565) and `lines: runLines` on both request bodies (593, 629-652). After a successful run: `for (const w of result.warnings ?? []) toast(w);`.

useProximityHeatmap.ts:118: `lines: trimLines(currentConfig().lines, req.rows)`.

complete.ts: `CompleteOptions.lines?: Lines`; `const LINE_SECTION = { name: "Picked lines", rank: 3 };` In the bare-word branch, append

```ts
  const lineRefs = Object.entries(opts?.lines ?? {})
    .filter(([id]) => id.toLowerCase().startsWith(lower))
    .map(([id, l]) => ({ label: id, type: "variable", detail: `line · ${l.epic} · ${tfLabel(l.timeframe)}`, section: LINE_SECTION, boost: CHART_BOOST }));
```

to the returned list. Pass `lines: cfg.lines` wherever the backtest editor builds `CompleteOptions`, and `lines: new Set(Object.keys(cfg.lines ?? {}))` to its lint call.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/expr/complete.test.ts src/backtestSettings/useExprPick.test.ts src/lib/backtestConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/backtestSettings/useExprPick.ts frontend/src/backtestSettings/useExprPick.test.ts frontend/src/BacktestButton.tsx frontend/src/api.ts frontend/src/chart/useProximityHeatmap.ts frontend/src/lib/expr/complete.ts frontend/src/lib/expr/complete.test.ts
git add frontend/src/backtestSettings   # ONLY the editor files you changed for CompleteOptions/lint; list them explicitly instead of the directory
git commit -m "feat(backtest): picked lines in backtest rules"
```

---

### Task 10: Screener holder

**Files:**
- Modify: `frontend/src/ScreenerPanel.tsx` (state 117-121, pick 361-365, draft 159/183, run 264, save 314, load 208-226, completion + lint opts)
- Modify: `frontend/src/lib/screens.ts` (`ScreenDraft.lines?: Lines`, `Screen.lines?`)
- Modify: `frontend/src/lib/screenerDraft.ts` (`ScreenerDraftState.lines?`)
- Test: `frontend/src/ScreenerPanel.test.tsx`

**Interfaces:**
- Consumes: Tasks 6 and 8
- Produces: `getScreenerDraft(brokerId).lines` (read by Task 12)

- [ ] **Step 1: Write the failing test**

```tsx
// append to frontend/src/ScreenerPanel.test.tsx, using its existing render helper and startScreen mock
it("sends only the referenced picked lines on Run", async () => {
  // Arrange: render with a draft whose expression is "candle.close > L1" and lines {L1, L2}
  // Act: click Run
  // Assert: the startScreen mock received body.lines === { L1 } (not L2)
});
```

Write it concretely against the file's existing helpers: seed via `setScreenerDraft(brokerId, {...draft, expression: "candle.close > L1", lines: { L1: line, L2: line2 }})` before render, click the Run button by its role/name the file already uses, and `expect(startScreenMock.mock.calls[0][0].lines).toEqual({ L1: line })`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx`
Expected: FAIL (`lines` undefined)

- [ ] **Step 3: Implement**

- `const [lines, setLines] = useState<Lines | undefined>(initial.lines);`
- pick: `useIndicatorPick<PickTarget>(controller, onToken, (t, line) => { const id = existingIdFor(lines, line) ?? mintLineId(lines); setLines((ls) => ({ ...(ls ?? {}), [id]: line })); insertToken(t, id); })` where `insertToken` is the body of the current `onToken` extracted to a local function, and `existingIdFor` finds an id with the same `lineGeoKey`.
- draft mirror (183) includes `lines`.
- Run (264) and Save (314): `lines: trimLines(lines, [expression, ...columns.map((c) => c.expression)])`; after the server accepts, `setLines(sent)` (same "adopt only after accept" rule as indicators).
- load (208-226): `setLines(s.lines)`.
- completion opts `lines`, lint opts `lines: new Set(Object.keys(lines ?? {}))`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx src/lib/screenerIndicators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ScreenerPanel.tsx frontend/src/ScreenerPanel.test.tsx frontend/src/lib/screens.ts frontend/src/lib/screenerDraft.ts
git commit -m "feat(screener): picked lines in screens"
```

---

### Task 11: Live trading: send and rebase

**Files:**
- Modify: `frontend/src/lib/liveTypes.ts:45-67` (`EvaluateRequest.lines?`), response `warnings?`
- Modify: `frontend/src/lib/liveEngine.ts` (request 132-173, new `rebaseLines`, write-back)
- Test: `frontend/src/lib/liveEngine.test.ts`

**Interfaces:**
- Consumes: `trimLines` (Task 6); `ArmedSnapshot.cfg.lines` (Task 9, frozen by `armSnapshot`'s `structuredClone`)
- Produces:
  - `export function rebaseLines(lines: Lines | undefined, bars: readonly { timestamp: number }[], resolution: string): Lines | null` (null: nothing moved)
  - `REBASE_AGE_BARS = 500`

- [ ] **Step 1: Write the failing tests**

```ts
// append to frontend/src/lib/liveEngine.test.ts
import { rebaseLines } from "./liveEngine";
const H = 3_600_000;
const bars = Array.from({ length: 1500 }, (_, k) => ({ timestamp: k * H }));
const line = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 0, p1: 0, t2: H, p2: 1, slope: 1, tRef: 2 * H, pRef: 2 };

it("moves an old tRef to the newest bar", () => {
  const out = rebaseLines({ L1: line }, bars, "HOUR")!;
  expect(out.L1.tRef).toBe(1499 * H);
  expect(out.L1.pRef).toBe(2 + 1497);
});
it("leaves a recent tRef and other-timeframe lines alone", () => {
  expect(rebaseLines({ L1: { ...line, tRef: 1400 * H } }, bars, "HOUR")).toBeNull();
  expect(rebaseLines({ L1: { ...line, timeframe: "HOUR_4" } }, bars, "HOUR")).toBeNull();
});
it("sends trimmed lines with the evaluate request", async () => {
  // Reuse the existing runOneCycle test harness (the one asserting req.exprLongEntry at ~line 94):
  // give the snapshot cfg lines {L1, L2} and a long entry rule "candle.close > L1",
  // then assert the captured request has lines === { L1: line }.
});
```

Write the third test concretely with the file's harness (its `deps.evaluateStrategy` mock captures `req`).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts`
Expected: FAIL (`rebaseLines` not exported)

- [ ] **Step 3: Implement**

```ts
export const REBASE_AGE_BARS = 500;

/** Keep each picked line's reference bar inside the rolling window: once tRef
 * is more than REBASE_AGE_BARS old, move it to the newest bar. Only lines on
 * the engine's own timeframe; a higher-timeframe line is placed by the server
 * rebase. Null when nothing moved, so the caller skips the write. */
export function rebaseLines(lines: Lines | undefined, bars: readonly { timestamp: number }[], resolution: string): Lines | null {
  if (!lines || !bars.length) return null;
  const times = bars.map((b) => b.timestamp);
  const last = times.length - 1;
  let out: Lines | null = null;
  for (const [id, l] of Object.entries(lines)) {
    if (l.timeframe !== resolution) continue;
    const j = times.indexOf(l.tRef);
    if (j < 0 || last - j <= REBASE_AGE_BARS) continue;
    out ??= { ...lines };
    out[id] = { ...l, tRef: times[last], pRef: l.pRef + l.slope * (last - j) };
  }
  return out;
}
```

In `runOneCycle`, after `const snap = activeRules(reconciled)`:

```ts
  const moved = rebaseLines(snap.cfg.lines, bars, resolution);
  if (moved) {
    const patch = (s: ArmedSnapshot | null) => (s ? { ...s, cfg: { ...s.cfg, lines: moved } } : s);
    reconciled = { ...reconciled, snapshot: patch(reconciled.snapshot), positionVintage: patch(reconciled.positionVintage) };
    if (reconciled.snapshot) saveArmed(epic, reconciled.snapshot.account, reconciled.snapshot);
  }
```

(Recompute `snap` from the patched state.) Request: `lines: trimLines(cfg.lines, [...all enabled row exprs])` next to `indicators: snap.indicators` (172). Log each `warnings` entry from the evaluate response with `appendLog`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts src/lib/liveController.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/liveEngine.ts frontend/src/lib/liveTypes.ts frontend/src/lib/liveEngine.test.ts
git commit -m "feat(live): send and rebase picked lines"
```

---

### Task 12: Clone overlay

**Files:**
- Create: `frontend/src/lib/overlays/pickedLineClones.ts`
- Modify: `frontend/src/lib/overlays/indicatorAlerts.ts` (export `loadedLinePoints` and `toLastBar` if not exported; no behaviour change)
- Modify: `frontend/src/lib/signals.ts` (`pickedLinesChanged = new Signal(0)`), bumped by `saveBacktestLastUsed`, `saveArmed`, `setScreenerDraft` when `lines` change (bump unconditionally in those three writers; it is cheap)
- Modify: `frontend/src/lib/chartController.ts:67` (instantiate), `frontend/src/chart/useLiveMarketData.ts:444` (attach + reconcile), `frontend/src/chart/useChartPaint.ts:868` (refresh), `frontend/src/ChartCore.tsx:5023` (subscribe `pickedLinesChanged`)
- Test: `frontend/src/lib/overlays/pickedLineClones.test.ts`

**Interfaces:**
- Consumes: `loadBacktestLastUsed`, `loadArmed`/`loadArmedAccount` (liveEngine.ts 232/335), `getScreenerDraft` (screenerDraft.ts 46), `lineGeoKey`, `loadedLinePoints`, `toLastBar`, `alertLineStyles`
- Produces:
  - `export function wantedClones(epic: string, broker: string, sources: Array<{ lines?: Lines }>): Map<string, { line: PickedLine; label: string }>` (pure; key = `lineGeoKey`)
  - `class PickedLineClones { attach(chart, broker, epic): void; reconcile(): void; refresh(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/overlays/pickedLineClones.test.ts
import { expect, it } from "vitest";
import { wantedClones } from "./pickedLineClones";

const L = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };

it("dedupes the same line across holders and joins labels", () => {
  const w = wantedClones("US100", "capital", [{ lines: { L1: L } }, { lines: { L2: { ...L, tRef: 9, pRef: 9 } } }]);
  expect([...w.values()].map((x) => x.label)).toEqual(["L1 · L2"]);
});
it("skips other symbols and brokers", () => {
  expect(wantedClones("GOLD", "capital", [{ lines: { L1: L } }]).size).toBe(0);
  expect(wantedClones("US100", "ig", [{ lines: { L1: L } }]).size).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/overlays/pickedLineClones.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```ts
// frontend/src/lib/overlays/pickedLineClones.ts
// Dashed clones of picked trendlines. A clone stays while any live rule holder
// (the backtest config, an armed live snapshot, the open screener draft) keeps
// that line, the way a line alert's dashed line outlives its trendline. One
// clone per geometry, labelled with every id that holds it.
import type { Chart, KLineData } from "klinecharts";
import { lineGeoKey, type Lines, type PickedLine } from "../pickedLines";
import { loadBacktestLastUsed } from "../persist/defaults";
import { loadArmed, loadArmedAccount } from "../liveEngine";
import { getScreenerDraft } from "../screenerDraft";
import { loadedLinePoints, toLastBar } from "./indicatorAlerts";
import { alertLineStyles } from "./alertLine";

export function wantedClones(epic: string, broker: string, sources: Array<{ lines?: Lines }>) {
  const out = new Map<string, { line: PickedLine; label: string }>();
  for (const s of sources) {
    for (const [id, l] of Object.entries(s.lines ?? {})) {
      if (l.epic !== epic || (l.broker && broker && l.broker !== broker)) continue;
      const k = lineGeoKey(l);
      const cur = out.get(k);
      if (!cur) out.set(k, { line: l, label: id });
      else if (!cur.label.split(" · ").includes(id)) cur.label = `${cur.label} · ${id}`;
    }
  }
  return out;
}

const ovId = (k: string) => `pickline:${k}`;

export class PickedLineClones {
  private chart: Chart | null = null;
  private broker = "";
  private epic = "";
  private drawn = new Map<string, string>(); // geoKey -> last points signature

  attach(chart: Chart, broker: string, epic: string): void {
    if (chart !== this.chart || epic !== this.epic || broker !== this.broker) {
      for (const k of this.drawn.keys()) this.chart?.removeOverlay({ id: ovId(k) });
      this.drawn.clear();
    }
    this.chart = chart;
    this.broker = broker;
    this.epic = epic;
  }

  private sources(): Array<{ lines?: Lines }> {
    const account = loadArmedAccount(this.epic);
    return [
      { lines: loadBacktestLastUsed()?.lines },
      { lines: account ? loadArmed(this.epic, account)?.cfg.lines : undefined },
      { lines: getScreenerDraft(this.broker).lines },
    ];
  }

  reconcile(): void { this.refresh(); }

  refresh(): void {
    const c = this.chart;
    if (!c) return;
    const dataList = c.getDataList() as KLineData[];
    const times = dataList.map((d) => d.timestamp);
    const want = wantedClones(this.epic, this.broker, this.sources());
    for (const k of [...this.drawn.keys()]) {
      if (!want.has(k)) { c.removeOverlay({ id: ovId(k) }); this.drawn.delete(k); }
    }
    for (const [k, w] of want) {
      const l = w.line;
      const raw = loadedLinePoints({ tRef: l.tRef, pRef: l.pRef, slope: l.slope, anchors: { t1: l.t1, p1: l.p1, t2: l.t2, p2: l.p2 } }, times, dataList)
        ?? [{ timestamp: l.t1, value: l.p1 }, { timestamp: l.t2, value: l.p2 }];
      const points = toLastBar(raw, dataList);
      const sig = `${JSON.stringify(points)}|${w.label}`;
      if (this.drawn.get(k) === sig) continue;
      const base = alertLineStyles(false);
      const styles = { ...base, line: { ...base.line, style: "dashed", dashedValue: [2, 4] } };
      if (this.drawn.has(k)) c.overrideOverlay({ id: ovId(k), points, extendData: w.label } as never);
      else c.createOverlay({ id: ovId(k), name: "segment", points, styles, extendData: w.label, mode: "normal",
        needDefaultXAxisFigure: false, needDefaultYAxisFigure: false, lock: true,
        onRightClick: (e: { preventDefault?: () => void }) => { e.preventDefault?.(); return true; } } as never);
      this.drawn.set(k, sig);
    }
  }
}
```

Label at the right end: the `segment` overlay draws no text. Draw the label in `useChartPaint.ts` beside the line-alert bells (875-911): for each clone, read its overlay points via a new `PickedLineClones.labels(): Array<{ points; label }>` method returning the last `want` computed in `refresh`, project the right point with the same pixel helpers the bells use, and `fillText(label)` in the chart's muted text color, 4px right of the end. Add that method and the paint code in this step. `loadedLinePoints` takes `times` and `dataList` exactly as `indicatorAlerts.ts:44` does; `toLastBar` is the helper at `indicatorAlerts.ts:232`. If the clone must be distinguishable from alert lines in a different way than dash pattern, keep the dash and use a 50% alpha of the alert color.

Wiring: `controller.pickedLineClones = new PickedLineClones()` (chartController.ts:67 neighbour); `useLiveMarketData.ts:444`: `controller.pickedLineClones.attach(chart, brokerId, symbol.epic); controller.pickedLineClones.reconcile();`; `useChartPaint.ts:868`: `controller.pickedLineClones.refresh();` every paint (not gated by alerts-hidden); `ChartCore.tsx:5023`: `pickedLinesChanged.subscribe(() => { controller.pickedLineClones.reconcile(); handle.redrawRef.current(); })`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/overlays/pickedLineClones.test.ts src/lib/overlays/indicatorAlerts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/overlays/pickedLineClones.ts frontend/src/lib/overlays/pickedLineClones.test.ts frontend/src/lib/overlays/indicatorAlerts.ts frontend/src/lib/signals.ts frontend/src/lib/chartController.ts frontend/src/chart/useLiveMarketData.ts frontend/src/chart/useChartPaint.ts frontend/src/ChartCore.tsx frontend/src/lib/persist/defaults.ts frontend/src/lib/liveEngine.ts frontend/src/lib/screenerDraft.ts
git commit -m "feat(lines): dashed clones of picked lines on the chart"
```

---

### Task 13: Docs, typecheck and a live check

**Files:**
- Modify: `CLAUDE.md` (new "Picked lines" subsection under Screener / after "Chart indicators in screens")
- Modify: `docs/superpowers/specs/2026-10-23-picked-trendline-operand-design.md` (Rebasing section: "a pinned (finer-timeframe) line" becomes "a higher-timeframe line"; Backend Timeframe bullet: the screener now accepts a line at its timeframe or coarser, like a pin, and refuses finer with `screen_tf_lower`)

- [ ] **Step 1: Write the docs**

CLAUDE.md, 6-10 lines: what `L<n>` is (frozen Trendlines line, bare id, reserved name), where the `lines` map lives (backtest config, armed snapshot, screener draft and saved screens), that requests send only referenced ids, that the backend resolves them into `instances` under `line:L<n>` (`strategy/expr/lines.py`), the server rebase (`api/line_rebase.py`) and live rebase (`liveEngine.rebaseLines`), the clone overlay (`lib/overlays/pickedLineClones.ts`), and the spec path. No em dashes.

- [ ] **Step 2: Typecheck and lint (ask the user first; CPU heavy)**

Run: `cd frontend && npx tsc -b && npx eslint src/lib/pickedLines.ts src/lib/overlays/pickedLineClones.ts src/lib/liveEngine.ts src/ScreenerPanel.tsx src/ChartCore.tsx src/lib/useIndicatorPick.ts src/backtestSettings/useExprPick.ts src/lib/expr/complete.ts src/lib/expr/parser.ts`
Expected: zero errors

- [ ] **Step 3: Live check in the running app (Chartkar bridge, read-only gestures only)**

Per memory, never drive gestures through Playwright on the user's tab. Ask the user to: open a chart with a Trendlines pane, arm "pick from chart" in a backtest rule, click a line, confirm `L1` is inserted and a dashed clone labelled `L1` appears; run the backtest and confirm trades. Then verify with `ui_screenshot` on a tab the agent named itself.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-23-picked-trendline-operand-design.md
git commit -m "docs: picked trendline operand"
```
