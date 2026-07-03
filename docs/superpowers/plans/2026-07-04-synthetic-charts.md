# Synthetic Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open charts derived from an arithmetic expression over other instruments (e.g. `OIL_CRUDE/DXY`, `(AAPL+MSFT)/2`), combined server-side and rendered like any normal symbol.

**Architecture:** A pure backend module parses an expression, and combines each leg's OHLC candles element-wise over a forward-filled union timeline (with H/L clamping and divide-by-zero gaps). A stateless `/api/candles/synthetic` endpoint fetches each leg via the existing candle path and calls the combiner. On the frontend, a pure parser detects/canonicalizes expressions and mints a stable `SYN_<hash>` id; a localStorage registry maps id→expression; the chart treats the id as an ordinary `epic` and, for synthetic symbols, skips live streaming, market-status polling, trading and alert UI.

**Tech Stack:** Python 3 + FastAPI + pytest (backend); React + TypeScript + Vite + Vitest (frontend). klinecharts for rendering.

## Global Constraints

- **No live streaming, no trading, no alerts** for synthetic symbols in this version (history + scroll-back only).
- **Same broker** for all legs — legs resolve against the chart's active broker.
- **Backend is stateless**: the frontend sends the raw (URL-encoded) expression on every call; the backend never stores or looks up ids.
- **OHLC = element-wise** through the expression, then per-bar clamp `H = max(O,H,L,C)`, `L = min(O,H,L,C)`.
- **Alignment = forward-fill over the union** of leg timestamps, with a **leading-seed drop** (skip leading timestamps until every leg has produced its first bar).
- **Divide-by-zero / non-finite result → drop that bar** (a gap), never emit `±inf`/`NaN`.
- Existing patterns: backend candle type is `auto_trader.core.models.Candle` (`time: datetime, open, high, low, close, volume: float`). API returns `CandleDTO` (`time` is unix **seconds**). Frontend storage tests use `installMemStorage()` from `./testMemStorage`.

---

## File Structure

**Backend**
- Create: `backend/auto_trader/core/synthetic.py` — pure parser + evaluator + aligner. No I/O.
- Create: `backend/tests/test_synthetic.py` — unit tests for the pure module.
- Modify: `backend/auto_trader/api/app.py` — extract a per-leg fetch helper from the `/api/candles` handler; add the `/api/candles/synthetic` endpoint.
- Create: `backend/tests/test_api_synthetic.py` — endpoint integration test.

**Frontend**
- Create: `frontend/src/lib/syntheticExpr.ts` — detect / canonicalize / parse legs / mint id. Pure.
- Create: `frontend/src/lib/syntheticExpr.test.ts`
- Create: `frontend/src/lib/syntheticRegistry.ts` — localStorage id↔expression store + `isSynthetic`.
- Create: `frontend/src/lib/syntheticRegistry.test.ts`
- Modify: `frontend/src/lib/feed.ts` — synthetic-aware `fetchRecent`/`fetchRange`; `openLive` no-op for synthetic.
- Modify: `frontend/src/lib/feed.test.ts` — add synthetic-routing tests.
- Modify: `frontend/src/SymbolSearchModal.tsx` — detect typed expression, validate legs, offer a "Create synthetic" row.
- Modify: `frontend/src/ChartCore.tsx` — synthetic branch: derive precision, skip live + market-meta poll, hide trade lines / axis "+" / bracket.
- Modify: `frontend/src/App.tsx` — hide the order ticket and alerts sidebar for synthetic symbols.

---

## Task 1: Backend pure synthetic module (parse + evaluate + align)

The algorithmic core, fully isolated from I/O so it is exhaustively unit-testable.

**Files:**
- Create: `backend/auto_trader/core/synthetic.py`
- Test: `backend/tests/test_synthetic.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Candle`.
- Produces:
  - `parse(expr: str) -> Node` — raises `SyntheticError` on malformed input.
  - `legs(node: Node) -> list[str]` — distinct leg tokens, in first-seen order.
  - `combine(node: Node, per_leg: dict[str, list[Candle]]) -> list[Candle]` — aligned, element-wise, clamped, gap-guarded synthetic candles (volume `0.0`).
  - `class SyntheticError(ValueError)`.

- [ ] **Step 1: Write failing tests for the tokenizer/parser + legs**

```python
# backend/tests/test_synthetic.py
from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.synthetic import SyntheticError, combine, legs, parse


def _c(ts: int, o: float, h: float, l: float, cl: float) -> Candle:
    return Candle(datetime.fromtimestamp(ts, tz=timezone.utc), o, h, l, cl, 0.0)


def test_legs_distinct_first_seen_order():
    node = parse("(AAPL + MSFT) / AAPL")
    assert legs(node) == ["AAPL", "MSFT"]


def test_precedence_mul_over_add():
    # 2 + 3 * 4 == 14, not 20
    node = parse("2 + 3 * 4")
    assert combine(node, {})[0].close == pytest.approx(14.0)
    # combine with no legs still needs a timeline; see constant-only note below.


def test_unary_minus_and_parens():
    node = parse("-(2 - 5)")
    assert combine(node, {})[0].close == pytest.approx(3.0)


def test_unknown_char_raises():
    with pytest.raises(SyntheticError):
        parse("AAPL % MSFT")


def test_unbalanced_parens_raises():
    with pytest.raises(SyntheticError):
        parse("(AAPL / MSFT")
```

Note: a constant-only expression (`2 + 3 * 4`) has no legs and therefore no
timeline. To keep those parser tests simple, `combine` treats an **empty**
`per_leg` (no legs at all) as a single synthetic bar at `time = epoch 0` whose
O/H/L/C all equal the evaluated constant. Real synthetic charts always have ≥1
leg, so this branch only ever serves constant-only unit tests.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_synthetic.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.core.synthetic`.

- [ ] **Step 3: Implement the parser + legs**

```python
# backend/auto_trader/core/synthetic.py
"""Pure parser + evaluator for synthetic (arithmetic-combination) charts.

An expression combines instrument legs and numeric constants with + - * / and
parentheses, e.g. "OIL_CRUDE/DXY" or "(AAPL+MSFT)/2". This module has NO I/O:
`parse` builds an AST, `legs` lists the instruments to fetch, and `combine`
folds each leg's OHLC candles into one synthetic series (element-wise over a
forward-filled union timeline, H/L clamped, divide-by-zero dropped).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from auto_trader.core.models import Candle


class SyntheticError(ValueError):
    """Malformed expression or unresolvable structure. Surfaced to the client."""


# --- AST -------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Leg:
    name: str


@dataclass(frozen=True, slots=True)
class Const:
    value: float


@dataclass(frozen=True, slots=True)
class BinOp:
    op: str  # one of + - * /
    left: "Node"
    right: "Node"


@dataclass(frozen=True, slots=True)
class Neg:
    operand: "Node"


Node = Leg | Const | BinOp | Neg

# A leg token: letters/digits/underscore/dot, not a pure number. Numbers are
# matched first by the tokenizer so "US500" stays a leg but "500" is a Const.
_TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<leg>[A-Za-z_][A-Za-z0-9_.]*)|(?P<op>[()+\-*/]))")


def _tokenize(expr: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i = 0
    while i < len(expr):
        if expr[i].isspace():
            i += 1
            continue
        m = _TOKEN.match(expr, i)
        if not m or m.start() == m.end():
            raise SyntheticError(f"unexpected character at {i!r}: {expr[i:i+8]!r}")
        i = m.end()
        if m.group("num") is not None:
            tokens.append(("num", m.group("num")))
        elif m.group("leg") is not None:
            tokens.append(("leg", m.group("leg").upper()))
        else:
            tokens.append(("op", m.group("op")))
    if not tokens:
        raise SyntheticError("empty expression")
    return tokens


class _Parser:
    """Recursive-descent: expr = term (+|-) term; term = factor (*|/) factor."""

    def __init__(self, tokens: list[tuple[str, str]]):
        self.toks = tokens
        self.pos = 0

    def _peek(self) -> tuple[str, str] | None:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def _next(self) -> tuple[str, str]:
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def parse(self) -> Node:
        node = self._expr()
        if self.pos != len(self.toks):
            raise SyntheticError(f"unexpected token: {self.toks[self.pos]}")
        return node

    def _expr(self) -> Node:
        node = self._term()
        while (t := self._peek()) is not None and t[0] == "op" and t[1] in ("+", "-"):
            op = self._next()[1]
            node = BinOp(op, node, self._term())
        return node

    def _term(self) -> Node:
        node = self._factor()
        while (t := self._peek()) is not None and t[0] == "op" and t[1] in ("*", "/"):
            op = self._next()[1]
            node = BinOp(op, node, self._factor())
        return node

    def _factor(self) -> Node:
        t = self._peek()
        if t is None:
            raise SyntheticError("unexpected end of expression")
        if t == ("op", "-"):
            self._next()
            return Neg(self._factor())
        if t == ("op", "("):
            self._next()
            node = self._expr()
            if self._peek() != ("op", ")"):
                raise SyntheticError("unbalanced parentheses")
            self._next()
            return node
        kind, val = self._next()
        if kind == "num":
            return Const(float(val))
        if kind == "leg":
            return Leg(val)
        raise SyntheticError(f"unexpected token: {(kind, val)}")


def parse(expr: str) -> Node:
    return _Parser(_tokenize(expr)).parse()


def legs(node: Node) -> list[str]:
    out: list[str] = []

    def walk(n: Node) -> None:
        if isinstance(n, Leg):
            if n.name not in out:
                out.append(n.name)
        elif isinstance(n, BinOp):
            walk(n.left)
            walk(n.right)
        elif isinstance(n, Neg):
            walk(n.operand)

    walk(node)
    return out
```

- [ ] **Step 4: Run parser tests, expect PASS (except combine-dependent ones)**

Run: `cd backend && .venv/bin/python -m pytest tests/test_synthetic.py -q`
Expected: parser/legs tests PASS; the three `combine(...)` tests FAIL (`combine` not defined yet).

- [ ] **Step 5: Write failing tests for `combine` (align + element-wise + clamp + gap)**

```python
# append to backend/tests/test_synthetic.py

def test_ratio_element_wise_close():
    # A/B at each aligned ts
    a = [_c(60, 10, 12, 8, 11)]
    b = [_c(60, 2, 4, 1, 2)]
    out = combine(parse("A / B"), {"A": a, "B": b})
    assert out[0].close == pytest.approx(11 / 2)
    assert out[0].open == pytest.approx(10 / 2)


def test_hl_clamp_keeps_bar_well_ordered():
    # Division can invert wicks: A.high/B.high < A.low/B.low. H/L must be re-derived.
    a = [_c(60, 10, 20, 10, 15)]
    b = [_c(60, 1, 4, 1, 2)]   # highs->20/4=5, lows->10/1=10  => raw H(5) < raw L(10)
    out = combine(parse("A / B"), {"A": a, "B": b})
    bar = out[0]
    assert bar.high == max(bar.open, bar.close, 5.0, 10.0)
    assert bar.low == min(bar.open, bar.close, 5.0, 10.0)
    assert bar.high >= bar.low


def test_forward_fill_union_and_leading_seed():
    # B starts one bar later; the first ts (60) has no B -> dropped (leading seed).
    # At ts 180 A is missing -> carry A's ts-120 bar forward.
    a = [_c(60, 1, 1, 1, 1), _c(120, 2, 2, 2, 2)]
    b = [_c(120, 5, 5, 5, 5), _c(180, 7, 7, 7, 7)]
    out = combine(parse("A + B"), {"A": a, "B": b})
    times = [int(c.time.timestamp()) for c in out]
    assert times == [120, 180]           # ts 60 dropped (B not seeded)
    assert out[0].close == pytest.approx(2 + 5)
    assert out[1].close == pytest.approx(2 + 7)  # A carried forward from ts 120


def test_divide_by_zero_drops_bar():
    a = [_c(60, 1, 1, 1, 1), _c(120, 2, 2, 2, 2)]
    b = [_c(60, 0, 0, 0, 0), _c(120, 4, 4, 4, 4)]
    out = combine(parse("A / B"), {"A": a, "B": b})
    times = [int(c.time.timestamp()) for c in out]
    assert times == [120]                # ts 60 division by zero -> gap
```

- [ ] **Step 6: Run, verify the new tests fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_synthetic.py -q`
Expected: FAIL (`combine` not defined).

- [ ] **Step 7: Implement `combine` (align + evaluate + clamp + gap)**

```python
# append to backend/auto_trader/core/synthetic.py

# One aligned frame per leg at a given timestamp: (open, high, low, close).
_Frame = tuple[float, float, float, float]


def _eval_field(node: Node, frame: dict[str, float]) -> float:
    """Evaluate the expression for ONE OHLC field. `frame` maps leg -> that
    field's value at the current timestamp."""
    if isinstance(node, Const):
        return node.value
    if isinstance(node, Leg):
        return frame[node.name]
    if isinstance(node, Neg):
        return -_eval_field(node.operand, frame)
    if isinstance(node, BinOp):
        lhs = _eval_field(node.left, frame)
        rhs = _eval_field(node.right, frame)
        if node.op == "+":
            return lhs + rhs
        if node.op == "-":
            return lhs - rhs
        if node.op == "*":
            return lhs * rhs
        return lhs / rhs  # "/": may raise ZeroDivisionError, caught by caller
    raise SyntheticError(f"bad node: {node!r}")


def combine(node: Node, per_leg: dict[str, list[Candle]]) -> list[Candle]:
    names = legs(node)
    if not names:
        # Constant-only expression: single bar at epoch 0 (unit-test convenience).
        v = _eval_field(node, {})
        t = datetime.fromtimestamp(0, tz=timezone.utc)
        return [Candle(t, v, v, v, v, 0.0)]

    # Index each leg by timestamp (unix seconds) for O(1) lookup + forward-fill.
    indexed: dict[str, dict[int, Candle]] = {}
    for name in names:
        bars = per_leg.get(name, [])
        indexed[name] = {int(c.time.timestamp()): c for c in bars}

    # Union of all timestamps, ascending.
    all_ts = sorted({ts for idx in indexed.values() for ts in idx})

    last: dict[str, Candle] = {}     # most recent bar per leg (forward-fill state)
    out: list[Candle] = []
    for ts in all_ts:
        for name in names:
            bar = indexed[name].get(ts)
            if bar is not None:
                last[name] = bar
        # Leading-seed: skip until EVERY leg has produced a bar at//before ts.
        if len(last) < len(names):
            continue
        opens = {n: last[n].open for n in names}
        highs = {n: last[n].high for n in names}
        lows = {n: last[n].low for n in names}
        closes = {n: last[n].close for n in names}
        try:
            o = _eval_field(node, opens)
            h = _eval_field(node, highs)
            lo = _eval_field(node, lows)
            c = _eval_field(node, closes)
        except ZeroDivisionError:
            continue  # divide-by-zero -> gap
        if not all(math.isfinite(x) for x in (o, h, lo, c)):
            continue  # non-finite -> gap
        hi = max(o, h, lo, c)
        lolo = min(o, h, lo, c)
        out.append(
            Candle(datetime.fromtimestamp(ts, tz=timezone.utc), o, hi, lolo, c, 0.0)
        )
    return out
```

- [ ] **Step 8: Run the full module test, expect PASS**

Run: `cd backend && .venv/bin/python -m pytest tests/test_synthetic.py -q`
Expected: PASS (all tests).

- [ ] **Step 9: Lint + commit**

```bash
cd backend && .venv/bin/ruff check auto_trader/core/synthetic.py tests/test_synthetic.py
git add backend/auto_trader/core/synthetic.py backend/tests/test_synthetic.py
git commit -m "feat(synthetic): pure expression parser + OHLC combiner"
```

---

## Task 2: Backend `/api/candles/synthetic` endpoint

Fetch each leg via the existing candle path, then combine. Stateless — takes the
raw expression as a query param.

**Files:**
- Modify: `backend/auto_trader/api/app.py` (candles handler region ~882-1006; add new endpoint after it)
- Test: `backend/tests/test_api_synthetic.py`

**Interfaces:**
- Consumes: `parse`, `legs`, `combine`, `SyntheticError` from Task 1; existing `_candle_dto`, `CandleDTO`, `SECONDS_INTERVALS`, `is_derived`, `CANDLE_CACHE`, `get_data`, `guarded`, `_parse_resolution`, `DERIVED`, folding helpers.
- Produces: `GET /api/candles/synthetic` returning `list[CandleDTO]`; and a reusable
  `async def _fetch_leg_candles(broker_id, epic, resolution, bars, from_ts, to_ts, price_side) -> list[Candle]` extracted from the existing handler.

- [ ] **Step 1: Extract `_fetch_leg_candles` from the `candles` handler**

Refactor: move the body of `candles()` (the seconds / derived / native branches
that produce a `list[Candle]`, everything up to the final `_candle_dto`
mapping) into a new helper that returns `list[Candle]` and raises `HTTPException`
exactly as today. `candles()` becomes:

```python
@app.get("/api/candles", response_model=list[CandleDTO])
async def candles(
    epic: str = Query("EURUSD"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None),
    to_ts: int | None = Query(None),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
) -> list[CandleDTO]:
    loaded = await _fetch_leg_candles(
        broker_id, epic, resolution, bars, from_ts, to_ts, price_side
    )
    if not loaded and from_ts is None:
        raise HTTPException(404, f"no data for epic '{epic}' (unknown epic or no history)")
    return [_candle_dto(c) for c in loaded]
```

Where `_fetch_leg_candles` holds the three branches (seconds via `TICK_STORE`,
derived via fold, native via cache) and returns the raw `list[Candle]` **without**
the 404 (the caller decides). Keep every existing `HTTPException`/`guarded` call
inside it unchanged. Do not alter behavior — this is a pure extraction.

- [ ] **Step 2: Run the existing candle tests to prove the extraction is behavior-preserving**

Run: `cd backend && .venv/bin/python -m pytest tests/test_candles_derived.py tests/test_candle_cache.py -q`
Expected: PASS (unchanged).

- [ ] **Step 3: Write a failing endpoint test**

```python
# backend/tests/test_api_synthetic.py
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient

import auto_trader.api.app as app_mod
from auto_trader.api.app import app
from auto_trader.core.models import Candle


def _c(ts, v):
    return Candle(datetime.fromtimestamp(ts, tz=timezone.utc), v, v, v, v, 0.0)


@pytest.mark.asyncio
async def test_synthetic_ratio(monkeypatch):
    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        if epic == "A":
            return [_c(60, 10), _c(120, 20)]
        if epic == "B":
            return [_c(60, 2), _c(120, 4)]
        return []

    monkeypatch.setattr(app_mod, "_fetch_leg_candles", fake_fetch)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.get("/api/candles/synthetic", params={"expr": "A / B", "resolution": "MINUTE"})
    assert r.status_code == 200
    body = r.json()
    assert [row["close"] for row in body] == [5.0, 5.0]


@pytest.mark.asyncio
async def test_synthetic_bad_expr_422():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.get("/api/candles/synthetic", params={"expr": "A % B", "resolution": "MINUTE"})
    assert r.status_code == 422
```

(Match the async-test style already used in `backend/tests/` — if the suite uses
`asyncio_mode=auto`, drop the `@pytest.mark.asyncio` decorators; check
`backend/pyproject.toml`/`pytest.ini` and follow the existing pattern in
`test_api_backtest.py`.)

- [ ] **Step 4: Run, verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_synthetic.py -q`
Expected: FAIL (404 — route not defined).

- [ ] **Step 5: Add the endpoint**

```python
# backend/auto_trader/api/app.py  (after the candles handler; import at top:
#   from auto_trader.core.synthetic import SyntheticError, combine, legs, parse)

@app.get("/api/candles/synthetic", response_model=list[CandleDTO])
async def candles_synthetic(
    expr: str = Query(..., description="arithmetic expression, e.g. OIL_CRUDE/DXY"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None),
    to_ts: int | None = Query(None),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
) -> list[CandleDTO]:
    """Candles for a synthetic (arithmetic-combination) chart. Stateless: the raw
    expression is parsed here, each leg is fetched via the shared candle path
    against the same broker, and the legs are combined element-wise."""
    try:
        node = parse(expr)
    except SyntheticError as e:
        raise HTTPException(422, f"bad expression: {e}") from e
    names = legs(node)
    if not names:
        raise HTTPException(422, "expression has no instruments")

    per_leg: dict[str, list[Candle]] = {}
    for name in names:
        # Reuse the native/derived/cache path per leg; a leg-level HTTPException
        # (unknown broker, IG-derived block) propagates unchanged.
        per_leg[name] = await _fetch_leg_candles(
            broker_id, name, resolution, bars, from_ts, to_ts, price_side
        )

    result = combine(node, per_leg)
    if not result and from_ts is None:
        raise HTTPException(
            404, f"no data for synthetic '{expr}' (unknown leg or no overlapping history)"
        )
    return [_candle_dto(c) for c in result]
```

- [ ] **Step 6: Run the endpoint test, expect PASS**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_synthetic.py -q`
Expected: PASS.

- [ ] **Step 7: Lint + commit**

```bash
cd backend && .venv/bin/ruff check auto_trader/api/app.py tests/test_api_synthetic.py
git add backend/auto_trader/api/app.py backend/tests/test_api_synthetic.py
git commit -m "feat(synthetic): stateless /api/candles/synthetic endpoint"
```

---

## Task 3: Frontend expression module (detect / canonicalize / parse legs / mint id)

Pure module: no chart or storage state. Mirrors the backend grammar for
detection + leg extraction + a stable id. It does NOT evaluate candles (the
backend does).

**Files:**
- Create: `frontend/src/lib/syntheticExpr.ts`
- Test: `frontend/src/lib/syntheticExpr.test.ts`

**Interfaces:**
- Produces:
  - `isSyntheticExpr(input: string): boolean` — true if the string is an expression, not a plain epic.
  - `canonicalize(expr: string): string` — trimmed, single-spaced, upper-cased legs.
  - `parseLegs(expr: string): string[]` — distinct leg tokens; throws `Error` on malformed input.
  - `syntheticId(expr: string): string` — `SYN_<hash8>` from the canonical form; stable across sessions.

- [ ] **Step 1: Write failing tests**

```ts
// frontend/src/lib/syntheticExpr.test.ts
import { describe, it, expect } from "vitest";
import { canonicalize, isSyntheticExpr, parseLegs, syntheticId } from "./syntheticExpr";

describe("isSyntheticExpr", () => {
  it("plain epics are not synthetic", () => {
    for (const e of ["OIL_CRUDE", "US500", "EURUSD", "CS.D.EURUSD.CFD.IP"])
      expect(isSyntheticExpr(e)).toBe(false);
  });
  it("operators mark an expression", () => {
    for (const e of ["OIL_CRUDE/DXY", "(AAPL+MSFT)/2", "A*B", "A - B"])
      expect(isSyntheticExpr(e)).toBe(true);
  });
});

describe("parseLegs", () => {
  it("returns distinct legs in order, upper-cased", () => {
    expect(parseLegs("(aapl + msft) / aapl")).toEqual(["AAPL", "MSFT"]);
  });
  it("ignores numeric constants", () => {
    expect(parseLegs("OIL_CRUDE / DXY * 100")).toEqual(["OIL_CRUDE", "DXY"]);
  });
  it("throws on unbalanced parens", () => {
    expect(() => parseLegs("(A / B")).toThrow();
  });
});

describe("canonicalize + syntheticId", () => {
  it("canonicalizes whitespace and case", () => {
    expect(canonicalize(" oil_crude/dxy ")).toBe("OIL_CRUDE / DXY");
  });
  it("same expression -> same id, different -> different", () => {
    expect(syntheticId("OIL_CRUDE/DXY")).toBe(syntheticId(" oil_crude / dxy "));
    expect(syntheticId("A/B")).not.toBe(syntheticId("B/A"));
  });
  it("id has the SYN_ prefix", () => {
    expect(syntheticId("A/B")).toMatch(/^SYN_[0-9a-z]+$/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/lib/syntheticExpr.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

```ts
// frontend/src/lib/syntheticExpr.ts
// Pure expression helpers for synthetic charts. Detection + leg extraction +
// a stable id. Evaluation of candles happens server-side (see /api/candles/synthetic).

// A string is synthetic if it carries an operator/paren that a plain epic never
// does. Bare "-" is treated as part of a token (epics like CS.D... use dots, and
// we don't want a hyphen inside a symbol to misfire), so subtraction must be
// SPACED (" - "). "* / ( ) +" always mark an expression.
export function isSyntheticExpr(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (/[*/()+]/.test(s)) return true;
  if (/\s-\s/.test(s)) return true;
  return false;
}

interface Tok {
  kind: "num" | "leg" | "op";
  value: string;
}

// Numbers first so "US500" is a leg but "500" is a constant.
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|([()+\-*/]))/y;

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(expr);
    if (!m || m.index !== i) throw new Error(`unexpected character: ${expr.slice(i, i + 8)}`);
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) toks.push({ kind: "num", value: m[1] });
    else if (m[2] !== undefined) toks.push({ kind: "leg", value: m[2].toUpperCase() });
    else toks.push({ kind: "op", value: m[3] });
  }
  if (toks.length === 0) throw new Error("empty expression");
  return toks;
}

// Validate structure by walking the same grammar as the backend, collecting legs.
// Recursive descent: expr = term ((+|-) term)*; term = factor ((*|/) factor)*;
// factor = '-' factor | '(' expr ')' | num | leg.
function parseTokens(toks: Tok[]): string[] {
  let pos = 0;
  const legs: string[] = [];
  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  function expr(): void {
    term();
    while (peek() && peek().kind === "op" && (peek().value === "+" || peek().value === "-")) {
      eat();
      term();
    }
  }
  function term(): void {
    factor();
    while (peek() && peek().kind === "op" && (peek().value === "*" || peek().value === "/")) {
      eat();
      factor();
    }
  }
  function factor(): void {
    const t = peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.kind === "op" && t.value === "-") {
      eat();
      factor();
      return;
    }
    if (t.kind === "op" && t.value === "(") {
      eat();
      expr();
      if (!peek() || peek().value !== ")") throw new Error("unbalanced parentheses");
      eat();
      return;
    }
    const tok = eat();
    if (tok.kind === "num") return;
    if (tok.kind === "leg") {
      if (!legs.includes(tok.value)) legs.push(tok.value);
      return;
    }
    throw new Error(`unexpected token: ${tok.value}`);
  }

  expr();
  if (pos !== toks.length) throw new Error(`unexpected token: ${toks[pos].value}`);
  return legs;
}

export function parseLegs(expr: string): string[] {
  return parseTokens(tokenize(expr));
}

// Textual canonical form: single-spaced, legs upper-cased, no algebraic rewriting
// (A/B stays distinct from B/A). Deterministic so the id is stable.
export function canonicalize(expr: string): string {
  const toks = tokenize(expr);
  const parts: string[] = [];
  for (const t of toks) {
    if (t.kind === "op" && (t.value === "(" )) parts.push("(");
    else parts.push(t.value);
  }
  // Space every token, then tidy spaces just inside parentheses.
  return parts.join(" ").replace(/\(\s+/g, "( ").replace(/\s+\)/g, " )").trim();
}

// Stable 32-bit FNV-1a hash of the canonical form, base36 -> SYN_<hash>.
export function syntheticId(expr: string): string {
  const s = canonicalize(expr);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "SYN_" + (h >>> 0).toString(36);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/lib/syntheticExpr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/syntheticExpr.ts frontend/src/lib/syntheticExpr.test.ts
git commit -m "feat(synthetic): frontend expression parser + stable id"
```

---

## Task 4: Frontend synthetic registry (id ↔ expression)

localStorage store so a synthetic id survives reload and every per-epic
persistence path (drawings, indicators, templates) treats it as an ordinary epic.

**Files:**
- Create: `frontend/src/lib/syntheticRegistry.ts`
- Test: `frontend/src/lib/syntheticRegistry.test.ts`

**Interfaces:**
- Consumes: `syntheticId`, `canonicalize`, `parseLegs` from Task 3.
- Produces:
  - `interface SyntheticEntry { id: string; expression: string; canonical: string; brokerId: string; legs: string[]; precision: number | null }`
  - `registerSynthetic(expression: string, brokerId: string): SyntheticEntry` — mints id, persists, returns entry (idempotent on same canonical form + broker).
  - `getSynthetic(id: string): SyntheticEntry | null`
  - `isSynthetic(epic: string): boolean` — true iff `epic` is a registered synthetic id (fast: `epic.startsWith("SYN_") && getSynthetic(epic) != null`).
  - `setSyntheticPrecision(id: string, precision: number): void`

- [ ] **Step 1: Write failing tests**

```ts
// frontend/src/lib/syntheticRegistry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const {
  registerSynthetic,
  getSynthetic,
  isSynthetic,
  setSyntheticPrecision,
} = await import("./syntheticRegistry");

beforeEach(() => localStorage.clear());

describe("syntheticRegistry", () => {
  it("registers and reads back an entry", () => {
    const e = registerSynthetic("OIL_CRUDE/DXY", "capital");
    expect(e.id).toMatch(/^SYN_/);
    expect(e.legs).toEqual(["OIL_CRUDE", "DXY"]);
    expect(getSynthetic(e.id)?.expression).toBe("OIL_CRUDE/DXY");
  });
  it("is idempotent on the same canonical form", () => {
    const a = registerSynthetic("OIL_CRUDE/DXY", "capital");
    const b = registerSynthetic(" oil_crude / dxy ", "capital");
    expect(a.id).toBe(b.id);
  });
  it("isSynthetic only true for registered ids", () => {
    const e = registerSynthetic("A/B", "capital");
    expect(isSynthetic(e.id)).toBe(true);
    expect(isSynthetic("OIL_CRUDE")).toBe(false);
    expect(isSynthetic("SYN_deadbeef")).toBe(false); // not registered
  });
  it("persists precision", () => {
    const e = registerSynthetic("A/B", "capital");
    setSyntheticPrecision(e.id, 4);
    expect(getSynthetic(e.id)?.precision).toBe(4);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/lib/syntheticRegistry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the registry**

```ts
// frontend/src/lib/syntheticRegistry.ts
// localStorage-backed map of synthetic id -> expression, so a synthetic chart's
// id (used everywhere as an ordinary `epic`) resolves back to the expression the
// backend needs. Frontend is the source of truth; the backend stays stateless.

import { canonicalize, parseLegs, syntheticId } from "./syntheticExpr";

export interface SyntheticEntry {
  id: string;
  expression: string;
  canonical: string;
  brokerId: string;
  legs: string[];
  precision: number | null;
}

const KEY = "synthetic.registry.v1";

function load(): Record<string, SyntheticEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, SyntheticEntry>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, SyntheticEntry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — synthetic is session-usable regardless */
  }
}

export function registerSynthetic(expression: string, brokerId: string): SyntheticEntry {
  const canonical = canonicalize(expression);
  const id = syntheticId(expression);
  const map = load();
  const existing = map[id];
  if (existing) return existing;
  const entry: SyntheticEntry = {
    id,
    expression: expression.trim(),
    canonical,
    brokerId,
    legs: parseLegs(expression),
    precision: null,
  };
  map[id] = entry;
  save(map);
  return entry;
}

export function getSynthetic(id: string): SyntheticEntry | null {
  return load()[id] ?? null;
}

export function isSynthetic(epic: string): boolean {
  return epic.startsWith("SYN_") && getSynthetic(epic) !== null;
}

export function setSyntheticPrecision(id: string, precision: number): void {
  const map = load();
  const e = map[id];
  if (!e) return;
  e.precision = precision;
  save(map);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/lib/syntheticRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/syntheticRegistry.ts frontend/src/lib/syntheticRegistry.test.ts
git commit -m "feat(synthetic): localStorage id<->expression registry"
```

---

## Task 5: Frontend feed — synthetic-aware fetch + no-op live

Route synthetic symbols to the new endpoint; make `openLive` a no-op for them.

**Files:**
- Modify: `frontend/src/lib/feed.ts`
- Modify: `frontend/src/lib/feed.test.ts`

**Interfaces:**
- Consumes: `getSynthetic`, `isSynthetic` from Task 4.
- Produces: `fetchRecent`/`fetchRange` transparently call `/api/candles/synthetic?expr=…`
  when `epic` is a synthetic id; `openLive` returns an inert handle (status stays
  `"down"`/never live) for synthetic ids.

- [ ] **Step 1: Write a failing test (global fetch stubbed)**

```ts
// append to frontend/src/lib/feed.test.ts  (follow the file's existing setup)
import { registerSynthetic } from "./syntheticRegistry";

it("fetchRecent routes a synthetic id to /api/candles/synthetic with expr", async () => {
  const e = registerSynthetic("A/B", "capital");
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("[]", { status: 200 }),
  );
  await fetchRecent(e.id, "MINUTE", 500, "mid", "capital");
  const url = String(spy.mock.calls[0][0]);
  expect(url).toContain("/api/candles/synthetic");
  expect(url).toContain("expr=A+%2F+B"); // canonical "A / B", url-encoded
  spy.mockRestore();
});

it("openLive is inert for a synthetic id", () => {
  const e = registerSynthetic("A/B", "capital");
  const onCandle = vi.fn();
  const h = openLive(e.id, "MINUTE", onCandle, undefined, "mid", "capital");
  expect(onCandle).not.toHaveBeenCalled();
  h.close(); // must not throw
});
```

(Match `feed.test.ts`'s existing import block and `installMemStorage()` usage; if
it doesn't yet install mem storage, add it at the top since `syntheticRegistry`
reads localStorage.)

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && npx vitest run src/lib/feed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement synthetic routing in `feed.ts`**

At the top of `feed.ts` add:

```ts
import { getSynthetic, isSynthetic } from "./syntheticRegistry";
```

In `fetchRecent`, before building the normal query string:

```ts
  const syn = getSynthetic(epic);
  if (syn) {
    const qs = new URLSearchParams({
      expr: syn.canonical,
      resolution,
      bars: String(bars),
      priceSide,
      broker: brokerId,
    });
    const res = await fetchWithTimeout(`${BASE}/api/candles/synthetic?${qs}`);
    if (res.ok) return ((await res.json()) as RawCandle[]).map(toKLine);
    if (res.status === 404) return [];
    throw new Error(await errorDetail(res));
  }
```

In `fetchRange`, before the normal query string:

```ts
  const syn = getSynthetic(epic);
  if (syn) {
    const qs = new URLSearchParams({
      expr: syn.canonical,
      resolution,
      from_ts: String(fromSec),
      to_ts: String(toSec),
      priceSide,
      broker: brokerId,
    });
    const res = await fetch(`${BASE}/api/candles/synthetic?${qs}`);
    if (!res.ok) return [];
    return ((await res.json()) as RawCandle[]).map(toKLine);
  }
```

In `openLive`, at the very top of the function body:

```ts
  if (isSynthetic(epic)) {
    // Synthetic charts are history-only (no tick stream). Return an inert handle
    // so callers can treat them uniformly; status stays non-live.
    onStatus?.("down");
    return { close: () => {} };
  }
```

- [ ] **Step 4: Run feed tests, expect PASS**

Run: `cd frontend && npx vitest run src/lib/feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/feed.ts frontend/src/lib/feed.test.ts
git commit -m "feat(synthetic): route synthetic ids to the synthetic endpoint; inert live"
```

---

## Task 6: Symbol search — create a synthetic from a typed expression

When the typed query is an expression whose legs all resolve against the loaded
catalogue, offer a "Create synthetic" row that registers it and opens the chart.

**Files:**
- Modify: `frontend/src/SymbolSearchModal.tsx`

**Interfaces:**
- Consumes: `isSyntheticExpr`, `parseLegs` (Task 3); `registerSynthetic` (Task 4);
  the existing `onPick(s: Instrument)` prop and the cached `all: Instrument[]` list.
- Produces: picking the synthetic row calls `onPick` with an `Instrument` whose
  `epic` is the synthetic id, `name` is the expression, `type` is `"SYNTHETIC"`,
  `status` is `"TRADEABLE"` (so it isn't badged closed), `pricePrecision` undefined.

- [ ] **Step 1: Add the synthetic-candidate computation**

Below the `shown` memo (line ~162), add a memo that validates the typed query:

```tsx
  // A typed arithmetic expression (e.g. OIL_CRUDE/DXY) whose legs all exist in
  // the catalogue becomes a "Create synthetic" row above the results. null when
  // the query isn't an expression, is malformed, or names an unknown leg.
  const syntheticCandidate = useMemo(() => {
    const q = query.trim();
    if (!q || !isSyntheticExpr(q) || all.length === 0) return null;
    let legList: string[];
    try {
      legList = parseLegs(q);
    } catch {
      return null;
    }
    if (legList.length === 0) return null;
    const byEpic = new Set(all.map((m) => m.epic.toUpperCase()));
    const missing = legList.filter((l) => !byEpic.has(l.toUpperCase()));
    return { expr: q, legs: legList, missing };
  }, [query, all]);
```

Add imports at the top:

```tsx
import { isSyntheticExpr, parseLegs } from "./lib/syntheticExpr";
import { registerSynthetic } from "./lib/syntheticRegistry";
```

- [ ] **Step 2: Add the pick handler for a synthetic**

Next to `pick(s)` (line ~166):

```tsx
  function pickSynthetic(expr: string) {
    const entry = registerSynthetic(expr, brokerId);
    pushRecentSymbol(entry.id);
    setRecentEpics(loadRecentSymbols());
    onPick({
      epic: entry.id,
      name: entry.expression,
      status: "TRADEABLE",
      type: "SYNTHETIC",
    });
    onClose();
  }
```

- [ ] **Step 3: Render the synthetic row**

Directly above `<ul className="symsearch-results">` (line ~218), add:

```tsx
        {syntheticCandidate && (
          <div className="symsearch-synthetic">
            {syntheticCandidate.missing.length === 0 ? (
              <button
                className="symsearch-synthetic-row"
                onClick={() => pickSynthetic(syntheticCandidate.expr)}
              >
                <span className="ss-epic">= {syntheticCandidate.expr}</span>
                <span className="ss-name">
                  Synthetic · {syntheticCandidate.legs.join(", ")}
                </span>
              </button>
            ) : (
              <div className="symsearch-empty">
                Unknown instrument{syntheticCandidate.missing.length > 1 ? "s" : ""}:{" "}
                {syntheticCandidate.missing.join(", ")}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 4: Manual verify in the running app**

Run the dev app; open symbol search; type `OIL_CRUDE/DXY`. Expected: a
"= OIL_CRUDE/DXY · Synthetic · OIL_CRUDE, DXY" row appears; clicking it opens a
chart titled `OIL_CRUDE/DXY`. Type `OIL_CRUDE/NOPE` → "Unknown instrument: NOPE".

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/SymbolSearchModal.tsx
git commit -m "feat(synthetic): create synthetic charts from the symbol search"
```

---

## Task 7: Chart + App integration (precision, no live/meta, hide trading & alerts)

Make a synthetic symbol render cleanly: derive precision from the data, skip the
market-status poll and live indicator, and hide trading + alert UI.

**Files:**
- Modify: `frontend/src/ChartCore.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `isSynthetic` (Task 4), `setSyntheticPrecision`/`getSynthetic` (Task 4).
- Produces: no new exports; behavior gated on `isSynthetic(symbol.epic)`.

- [ ] **Step 1: Gate the market-meta poll and live dot in ChartCore**

Add `import { getSynthetic, isSynthetic, setSyntheticPrecision } from "./lib/syntheticRegistry";`
near the other lib imports.

Find the effect that calls `fetchMarketMeta` (the open/closed + precision poll)
and short-circuit it for synthetic symbols:

```tsx
    if (isSynthetic(symbol.epic)) {
      setMarketClosed(false);      // synthetic never "closed"
      return;                      // no meta poll, no live-hours logic
    }
```

The `openLive` call (line ~2934) already becomes inert via Task 5's `feed.ts`
guard — no change needed here, but set the status so the UI shows no live dot:
right before `wsRef.current = openLive(...)`, add:

```tsx
      if (isSynthetic(symbol.epic)) setStatus("down");
```

- [ ] **Step 2: Derive + persist precision from the loaded data**

The chart's display precision is driven by the `fetchedPrecision` state
(`ChartCore.tsx:1232`): `effPrecision = fetchedPrecision ?? symbol.pricePrecision ?? 2`
flows into `precisionRef` and `overlays.setPricePrecision(effPrecision)`. The
normal path sets it from `fetchMarketMeta`; since Task 7 Step 1 short-circuits
that poll for synthetic symbols, set it from the loaded data instead via the same
`setFetchedPrecision` setter. Add a helper near the top of `ChartCore.tsx`:

```tsx
// Decimals needed to show ~5 significant figures for a synthetic ratio/spread,
// whose magnitude is unknown (0.0007 vs 1400). Clamped to a sane 0..8.
function synthPrecision(sampleClose: number): number {
  const v = Math.abs(sampleClose);
  if (!Number.isFinite(v) || v === 0) return 2;
  const digitsLeft = Math.floor(Math.log10(v)) + 1; // integer digits
  return Math.min(8, Math.max(0, 5 - digitsLeft));
}
```

After candles load for a synthetic symbol (use the last close of the loaded
list, whatever local variable the effect names the applied `KLineData[]`), call
the existing `setFetchedPrecision` setter and persist the value:

```tsx
      if (isSynthetic(symbol.epic) && data.length > 0) {
        const p = synthPrecision(data[data.length - 1].close);
        setFetchedPrecision(p);                 // same setter the meta poll uses
        setSyntheticPrecision(symbol.epic, p);  // cache for future seeding
      }
```

`setFetchedPrecision` already exists (paired with the `fetchedPrecision` state at
`ChartCore.tsx:1232`) — do not add a new precision API.

- [ ] **Step 3: Hide on-chart trade lines, axis "+", and bracket for synthetic**

At the trade-line redraw (the `tradeLineSpecs(...)` call sites ~1452/2455) and
the position-bracket draw, guard the whole block:

```tsx
      if (isSynthetic(symbol.epic)) return; // analysis-only: no trade lines/bracket
```

For the price-axis "+" affordance (`className="axis-plus"`, line ~4883), gate its
render:

```tsx
      {!isSynthetic(symbol.epic) && (
        <div className="axis-plus" ...>
          ...
        </div>
      )}
```

- [ ] **Step 4: Hide the order ticket + alerts sidebar in App.tsx**

At the order-ticket render (App.tsx:1575):

```tsx
        {tradeOpen && symbol && !isSynthetic(symbol.epic) && (
          <aside className="trade-sidebar">
            <OrderTicket ... />
          </aside>
        )}
```

At the alerts sidebar render (App.tsx:1561):

```tsx
        {panelOpen && symbol && !isSynthetic(symbol.epic) && (
          <AlertsSidebar ... />
        )}
```

Add `import { isSynthetic } from "./lib/syntheticRegistry";` to App.tsx.
For the precision passed to the order ticket / positions when synthetic, the
existing `symbol.pricePrecision ?? 2` fallback is fine (order UI is hidden
anyway); no change needed.

- [ ] **Step 5: Manual verify**

Run the dev app. Open `OIL_CRUDE/DXY`:
- Candles render; price axis shows sensible decimals.
- No live dot / "connecting" spinner stuck; status is calm (down/idle).
- Trade sidebar (bell/trade toggles) shows nothing tradeable; no axis "+" on hover;
  no trade lines or bracket.
- Indicators + drawings still work (add an EMA, draw a trendline; reload — they persist).
- Scroll back — older bars load via the windowed synthetic path.
Switch back to a normal symbol (e.g. `US100`): live dot, trading, alerts all return.

- [ ] **Step 6: Typecheck, run the frontend unit suite, commit**

```bash
cd frontend && npx tsc --noEmit && npx vitest run
git add frontend/src/ChartCore.tsx frontend/src/App.tsx
git commit -m "feat(synthetic): analysis-only chart integration (no live/trading/alerts)"
```

---

## Self-Review Notes (coverage against the spec)

- **Full expressions** → Tasks 1 & 3 (backend + frontend parsers with parens, precedence, unary minus, constants).
- **Backend compute** → Task 2 endpoint + Task 1 `combine`.
- **Element-wise + H/L clamp** → Task 1 Step 7 (`test_hl_clamp_keeps_bar_well_ordered`).
- **Forward-fill union + leading seed** → Task 1 (`test_forward_fill_union_and_leading_seed`).
- **Divide-by-zero / non-finite → gap** → Task 1 (`test_divide_by_zero_drops_bar`).
- **Stable id + registry** → Tasks 3 & 4.
- **Stateless backend / raw expression per call** → Task 2 (`expr` query param); Task 5 (feed sends `syn.canonical`).
- **History-only (no live)** → Task 5 inert `openLive` + Task 7 Step 1.
- **Analysis-only (no trading)** → Task 7 Steps 3-4.
- **Alerts hidden** → Task 7 Step 4.
- **Same broker** → Task 2 (single `broker_id` for all legs); Task 4 stores `brokerId`.
- **Typed entry, detection charset** → Task 6 + Task 3 `isSyntheticExpr`.
- **Precision auto-derived** → Task 7 Step 2.

**Naming consistency check:** `isSynthetic` (registry, epic→bool) vs
`isSyntheticExpr` (expr module, string→bool) are intentionally distinct and used
consistently. `registerSynthetic` / `getSynthetic` / `setSyntheticPrecision` /
`syntheticId` / `canonicalize` / `parseLegs` are referenced with the same
signatures across Tasks 3-7. Backend `parse` / `legs` / `combine` / `SyntheticError`
consistent across Tasks 1-2.
```
