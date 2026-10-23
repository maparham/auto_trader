# Screener Timeframe Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Screens accept `@tf` pins and pinned chart panes at the screen's timeframe or coarser, fetched per symbol through one shared higher-timeframe candle service that the backtest paths use too.

**Architecture:** A new `api/htf_source.py` owns "what pinned candles do these expression trees need, fetch them, check sufficiency". `expr_exec._ensure_htf` and the evaluate/closeness loops in `routers/expr.py` become callers. `core/screen_eval.py` learns the base resolution, refuses finer pins and the 4th timeframe, and carries the needs; `api/screen_jobs.py` fetches them per symbol and hands them to `judge`. The frontend editor stops dropping coarser pinned panes and labels pins.

**Tech Stack:** Python 3.14, FastAPI, pytest (run with `backend/.venv/bin/python3 -m pytest`); TypeScript, React, vitest (run single files only, never the whole suite).

**Spec:** docs/superpowers/specs/2026-10-23-screener-timeframe-pins-design.md

## Global Constraints

- Commit on `main`; stage by explicit path; never stash, clean or restore.
- No em dashes in code, comments, UI text or commit messages.
- Backend tests: `cd backend && .venv/bin/python3 -m pytest <files> -q`. Frontend: `cd frontend && npx vitest run <files>`, then `npx tsc -b` and `npx eslint <changed files>`.
- Existing test doubles for `deps._fetch_symbol_candles` take exactly 7 positional arguments; the service must call it that way and pass `degraded=` only when given.
- `expr_exec` keeps exporting `_ensure_htf`, `_tf_span`, `_tf_inner_warmup` by name (routers/expr.py and tests import them from there; one test monkeypatches `expr_exec._ensure_htf`).
- Pin spelling is `RSI.bullDiv@W` (output first). RSI panes have no settings pin.
- Error codes: `unsupported_timeframe` (existing), `screen_tf_lower`, `screen_tf_too_many`. Skip reasons: `not enough @W history`, and the existing `broker unavailable, cached bars only`.
- Caps: 3 distinct canonical resolutions per screen.

## Review Focus

1. A screen whose only pinned term is `EMA(50)@W` on DAY must ask for the 300-bar base floor, not 50 weeks of daily bars (Task 3 test `test_pinned_term_costs_no_base_bars`).
2. A same-timeframe pin (`EMA(5)@D` on DAY) must compile and judge the bar itself (Task 3 `test_same_timeframe_pin_accepted`, Task 4 judge test).
3. `1H` and `HOUR` in one screen count as one timeframe for the cap (Task 3 `test_tf_cap_counts_canonical`).
4. A symbol with weekly bars that all close after the judged bar's open must be skipped, not judged with None (Task 4 `test_pinned_shortfall_skips`).
5. The base and pinned fetches of one symbol must each take the per-broker semaphore separately, so one symbol never holds two slots (Task 4 `test_pinned_fetch_takes_the_broker_cap`).

---

### Task 1: `api/htf_source.py`, the shared service

**Files:**
- Create: `backend/auto_trader/api/htf_source.py`
- Test: `backend/tests/test_htf_source.py`

**Interfaces:**
- Consumes: `sweep_apply.referenced_tfs`, `strategy.expr.tfs.tf_resolution`, `strategy.expr.warmup.warmup_bars/PATTERN_WARMUP`, `strategy.expr.registry.PATTERN_FN_NAMES`, `core.candle_aggregate.resolution_seconds`, `deps._fetch_symbol_candles`.
- Produces: `HtfNeed`, `HtfShortfall`, `htf_needs(nodes, instances=None) -> list[HtfNeed]`, `warm_window(need, from_ts, to_ts) -> (from, to, bars)`, `fetch_htf(need, *, broker, epic, side, from_ts, to_ts, bars=None, degraded=None)`, `closed_before(bars, tf_s, cutoff_ts) -> int`, `source_htf(nodes, instances, *, broker, epic, side, from_ts, to_ts, cutoff_ts, shipped) -> dict[str, list[Candle]]`, plus `_pin_owner`, `_tf_span`, `_same_tf`, `_tf_inner_warmup` moved here verbatim from `expr_exec.py` lines 72-152.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_htf_source.py
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.api import deps, htf_source
from auto_trader.api.htf_source import (
    HtfNeed, HtfShortfall, closed_before, fetch_htf, htf_needs, source_htf, warm_window,
)
from auto_trader.core.models import Candle
from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.parser import parse

T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)  # a Monday
WEEK = 7 * 86400


def _weeks(n, start=T0):
    return [Candle(time=start + timedelta(weeks=k), open=1, high=2, low=0, close=1, volume=1)
            for k in range(n)]


def test_needs_from_tokens_across_nodes():
    nodes = [parse("EMA(5)@W > 0"), parse("count(candle.close@W > 0, 3) >= 1")]
    needs = htf_needs(nodes)
    assert [(n.tf, n.res, n.tf_s) for n in needs] == [("W", "WEEK", WEEK)]
    assert needs[0].need == 5 + 1  # deepest inner warm-up across both nodes, plus one


def test_needs_from_a_pane_pin():
    inst = resolve_instances({"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                        "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}})
    needs = htf_needs([parse("SLOPE.5 > 0")], inst)
    assert len(needs) == 1 and needs[0].res == "HOUR" and needs[0].need > 1


def test_warm_window_adds_two_needs_plus_ten_bars():
    need = HtfNeed("W", "WEEK", WEEK, 6)
    start, end, bars = warm_window(need, 1_000_000_000, 1_000_000_000 + 10 * WEEK)
    assert start == 1_000_000_000 - (2 * 6 + 10) * WEEK
    assert end == 1_000_000_000 + 10 * WEEK
    assert bars == (end - start) // WEEK + 2


def test_closed_before_counts_bars_closed_at_or_before_cutoff():
    bars = _weeks(3)
    cutoff = int((T0 + timedelta(weeks=2)).timestamp())
    assert closed_before(bars, WEEK, cutoff) == 2  # the third opens AT the cutoff, so it is not closed


def test_fetch_htf_calls_the_fetcher_with_seven_positionals(monkeypatch):
    calls = []

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append((broker, epic, resolution, bars, from_ts, to_ts, side))
        return _weeks(2)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    need = HtfNeed("W", "WEEK", WEEK, 2)
    out = asyncio.run(fetch_htf(need, broker="b", epic="E", side="mid", from_ts=0, to_ts=3 * WEEK))
    assert len(out) == 2 and calls == [("b", "E", "WEEK", 5, 0, 3 * WEEK, "mid")]


def test_fetch_htf_passes_degraded_only_when_given(monkeypatch):
    seen = {}

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side, degraded=None):
        seen["degraded"] = degraded
        if degraded is not None:
            degraded["x"] = True
        return _weeks(1)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    need = HtfNeed("W", "WEEK", WEEK, 1)
    d = {}
    asyncio.run(fetch_htf(need, broker="b", epic="E", side="mid", from_ts=0, to_ts=WEEK, degraded=d))
    assert d == {"x": True}


def test_source_htf_skips_shipped_and_checks_sufficiency(monkeypatch):
    fetched = []

    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        fetched.append(resolution)
        return _weeks(10)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    nodes = [parse("EMA(3)@W > 0")]
    cutoff = int((T0 + timedelta(weeks=9)).timestamp())
    kw = dict(broker="b", epic="E", side="mid", from_ts=int(T0.timestamp()), to_ts=cutoff)
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={"WEEK": _weeks(10)}, **kw))
    assert fetched == [] and len(out["WEEK"]) == 10
    with pytest.raises(HtfShortfall) as ei:
        asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={"WEEK": _weeks(2)}, **kw))
    assert (ei.value.tf, ei.value.closed, ei.value.need) == ("W", 2, 4)
    # no cutoff: the short shipped set is accepted as-is
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=None, shipped={"WEEK": _weeks(2)}, **kw))
    assert len(out["WEEK"]) == 2
    # nothing shipped: fetched once, keyed canonically
    out = asyncio.run(source_htf(nodes, None, cutoff_ts=cutoff, shipped={}, **kw))
    assert fetched == ["WEEK"] and "WEEK" in out


def test_source_htf_empty_fetch_is_a_shortfall_with_no_bars(monkeypatch):
    async def fake(broker, epic, resolution, bars, from_ts, to_ts, side):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake)
    with pytest.raises(HtfShortfall) as ei:
        asyncio.run(source_htf([parse("EMA(3)@W > 0")], None, broker="b", epic="E", side="mid",
                               from_ts=0, to_ts=WEEK, cutoff_ts=WEEK, shipped={}))
    assert ei.value.bars == 0
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_htf_source.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.api.htf_source`

- [ ] **Step 3: Create the module**

Move `_pin_owner`, `_tf_span`, `_same_tf`, `_tf_inner_warmup` from `expr_exec.py` (lines 72-152, verbatim, docstrings included) into the new file, then add:

```python
# backend/auto_trader/api/htf_source.py
"""Higher-timeframe candles for expression trees, in one place.

A rule or screen that references a timeframe (an @tf token, or a chart pane
pinned in its own settings) needs that timeframe's candles before compile_row
can precompute its series. Every surface that runs expressions used to carry
its own copy of "collect the timeframes, work out how many closed bars each
needs, fetch, check": the backtest pipeline, the evaluate and closeness
routes, the screener. They all call here now.

The shape is three small pieces so callers keep their own windows and error
wording: `htf_needs` (pure), `fetch_htf` (one window fetch through
deps._fetch_symbol_candles), `closed_before` (the sufficiency count), and
`source_htf` tying them together for callers that want the backtest's
"fetch what was not shipped, then verify" behaviour.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import PATTERN_FN_NAMES
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.warmup import PATTERN_WARMUP, warmup_bars

from . import deps
from .sweep_apply import referenced_tfs as _referenced_tfs


@dataclass(frozen=True, slots=True)
class HtfNeed:
    """One referenced timeframe and how much of it a set of nodes needs."""
    tf: str      # as referenced: "W", "1H", or a pane's own pin
    res: str     # canonical resolution ("WEEK"), the htf dict key
    tf_s: int    # nominal bar seconds
    need: int    # closed bars required before the cutoff: deepest inner warm-up + 1


class HtfShortfall(Exception):
    """Fewer closed bars of `tf` before the cutoff than the nodes need.
    `bars` is how many bars there were at all (0: the fetch was empty)."""

    def __init__(self, tf: str, closed: int, need: int, bars: int) -> None:
        super().__init__(f"not enough @{tf} history: {closed} of {need} closed bars")
        self.tf, self.closed, self.need, self.bars = tf, closed, need, bars


# ... _pin_owner, _tf_span, _same_tf, _tf_inner_warmup moved here unchanged ...


def htf_needs(nodes: list[N.Node], instances=None) -> list[HtfNeed]:
    """Every timeframe the nodes reference, sorted by name, each with the
    deepest warm-up any node needs in that timeframe's own bars, plus one:
    the closed bar whose value the first judged or traded bar reads."""
    tfs: set[str] = set()
    for node in nodes:
        tfs |= _referenced_tfs(node, instances)
    out: list[HtfNeed] = []
    for tf in sorted(tfs):
        tf_s, res = _tf_span(tf, instances)
        need = max((_tf_inner_warmup(n, tf, instances) for n in nodes), default=0) + 1
        out.append(HtfNeed(tf, res, tf_s, need))
    return out


def warm_window(need: HtfNeed, from_ts: int, to_ts: int) -> tuple[int, int, int]:
    """(from, to, bars) reaching 2x the need plus 10 bars before from_ts: a bar
    count only maps to a span while the market is open, and a weekend or
    holiday can eat most of an exact ask."""
    start = from_ts - (need.need * 2 + 10) * need.tf_s
    return start, to_ts, max(1, (to_ts - start) // need.tf_s + 2)


async def fetch_htf(need: HtfNeed, *, broker: str, epic: str, side: str,
                    from_ts: int, to_ts: int, bars: int | None = None,
                    degraded: dict | None = None) -> list[Candle]:
    """One window fetch of `need.res`. Positional arguments only, matching the
    seven-argument fetch doubles in the tests; `degraded` rides along only when
    the caller wants the cache's degraded flag."""
    if bars is None:
        bars = max(1, (to_ts - from_ts) // need.tf_s + 2)
    if degraded is None:
        return await deps._fetch_symbol_candles(broker, epic, need.res, bars, from_ts, to_ts, side)
    return await deps._fetch_symbol_candles(broker, epic, need.res, bars, from_ts, to_ts, side,
                                            degraded=degraded)


def closed_before(bars: list[Candle], tf_s: int, cutoff_ts: int) -> int:
    """Bars whose nominal close (open + tf_s) is at or before the cutoff."""
    return sum(1 for c in bars if int(c.time.timestamp()) + tf_s <= cutoff_ts)


async def source_htf(nodes: list[N.Node], instances, *, broker: str, epic: str, side: str,
                     from_ts: int, to_ts: int, cutoff_ts: int | None,
                     shipped: dict[str, list[Candle]]) -> dict[str, list[Candle]]:
    """The shipped map plus a warm-window fetch for every need it lacks, every
    entry checked for `need` closed bars before `cutoff_ts` (None: no check).
    Keys are canonical; a shipped alias key ("1H") is honoured on read."""
    out: dict[str, list[Candle]] = dict(shipped)
    for need in htf_needs(nodes, instances):
        bars = out.get(need.res) or out.get(need.tf)
        if not bars:
            start, end, n = warm_window(need, from_ts, to_ts)
            bars = await fetch_htf(need, broker=broker, epic=epic, side=side,
                                   from_ts=start, to_ts=end, bars=n)
            if not bars:
                raise HtfShortfall(need.tf, 0, need.need, 0)
            out[need.res] = bars
        if cutoff_ts is not None:
            closed = closed_before(bars, need.tf_s, cutoff_ts)
            if closed < need.need:
                raise HtfShortfall(need.tf, closed, need.need, len(bars))
    return out
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_htf_source.py -q`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/htf_source.py backend/tests/test_htf_source.py
git commit -m "feat(api): htf_source, one service for pinned-timeframe candles"
```

---

### Task 2: Move the backtest, evaluate and closeness paths onto the service

**Files:**
- Modify: `backend/auto_trader/api/expr_exec.py` (lines 72-213: the four helpers and `_ensure_htf`)
- Modify: `backend/auto_trader/api/routers/expr.py` (imports at 42-47; evaluate loop ~413-423; closeness loop ~460-470)
- Test: existing `backend/tests/test_expr_instances_route.py`, `test_api_expr.py`, `test_expr_closeness_router.py`, `test_api_backtest_remote_htf.py`, `test_api_backtest_cancel.py`

**Interfaces:**
- Consumes: Task 1.
- Produces: `expr_exec._ensure_htf` unchanged in name and signature; `expr_exec._tf_span`, `expr_exec._tf_inner_warmup` re-exported.

- [ ] **Step 1: Replace the helpers in `expr_exec.py`**

Delete `_pin_owner`, `_tf_span`, `_same_tf`, `_tf_inner_warmup` and the body of `_ensure_htf`. Drop the now-unused imports (`resolution_seconds`, `tf_resolution`, `PATTERN_FN_NAMES`, `PATTERN_WARMUP`; keep `warmup_bars` only if still used elsewhere in the file, otherwise drop it). Add:

```python
from .htf_source import HtfShortfall, _tf_inner_warmup, _tf_span, source_htf  # noqa: F401  re-exported for routers/expr.py and tests


async def _ensure_htf(
    nodes: list[N.Node], req: ExprBacktestRequest, htf: dict[str, list[Candle]],
    instances=None,
) -> None:
    """Fetch every @tf timeframe the rows reference that the request didn't ship,
    then verify each one is SUFFICIENT to warm its deepest pin before the
    trading window (htf_source.source_htf). Shipped htfCandles win: a
    compute-only host must never reach a broker. `htf` is updated in place
    because every caller keeps using the dict it passed."""
    try:
        htf.update(await source_htf(
            nodes, instances, broker=req.broker, epic=req.epic, side=req.priceSide,
            from_ts=req.candles[0].time, to_ts=req.candles[-1].time,
            cutoff_ts=req.tradeFromTime, shipped=htf,
        ))
    except HtfShortfall as e:
        if e.bars == 0:
            raise HTTPException(422, f"no candles for timeframe '{e.tf}'")
        raise HTTPException(
            422,
            f"not enough history for timeframe '{e.tf}': {e.closed} of {e.need} "
            f"closed bars before the trading window. Indicators pinned to "
            f"@{e.tf} can't be computed correctly here - start the range "
            f"later or shorten the pinned indicator.",
        )
```

Keep the original wording's exact text for the long message (copy it from the current file; it contains an em dash today, replace that one character with a comma: "...correctly here, start the range later...").

- [ ] **Step 2: Replace the two loops in `routers/expr.py`**

Imports: replace `_tf_inner_warmup, _tf_span` in the `from ..expr_exec import (...)` block with nothing, and add `from ..htf_source import fetch_htf, htf_needs`. Keep `_ensure_htf` and `compiled_run` there.

Evaluate (the loop under "An @tf term needs its higher-timeframe candles"):

```python
    htf: dict[str, list[Candle]] = {}
    for need in htf_needs([top], instances):
        tf_from = req.fromTime - need.need * need.tf_s
        htf[need.res] = await fetch_htf(
            need, broker=req.broker, epic=req.epic, side=req.priceSide,
            from_ts=tf_from, to_ts=req.toTime,
        )
```

Closeness (the loop under `tfs: set[str] = set()`):

```python
    htf: dict[str, list[Candle]] = {}
    for need in htf_needs(nodes, instances):
        # canonical key ('1H' -> 'HOUR'); an instance's own pin is alias-checked
        # by htf_needs because validate() never saw it.
        htf[need.res] = await fetch_htf(
            need, broker=req.broker, epic=req.epic, side=req.priceSide,
            from_ts=req.fromTime, to_ts=req.toTime,
        )
```

`fetch_htf`'s default `bars` is `max(1, (to - from) // tf_s + 2)`, the same as both loops computed. Remove the now-unused `_referenced_tfs` import from `routers/expr.py` only if nothing else in the file uses it (test_api_expr.py imports `_referenced_tfs` from `routers.expr`, so keep the name importable: leave the import in place).

- [ ] **Step 3: Run the affected backend tests**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_htf_source.py tests/test_expr_instances_route.py tests/test_api_expr.py tests/test_expr_closeness_router.py tests/test_api_backtest_remote_htf.py tests/test_api_backtest_cancel.py -q`
Expected: all pass, no failures. If `test_api_expr.py::...684` (the `("HOUR", 0 - 19 * 3600) in calls` assertion) fails, the evaluate window changed: fix the window, not the test.

- [ ] **Step 4: Commit**

```bash
git add backend/auto_trader/api/expr_exec.py backend/auto_trader/api/routers/expr.py
git commit -m "refactor(api): backtest, evaluate and closeness source pinned candles via htf_source"
```

---

### Task 3: `screen_eval` learns the base resolution and pins

**Files:**
- Modify: `backend/auto_trader/core/screen_eval.py`
- Modify: `backend/auto_trader/api/routers/screens.py` (`_compile`)
- Test: `backend/tests/test_screen_eval.py`

**Interfaces:**
- Consumes: Task 1 (`htf_needs`, `HtfNeed`), `strategy.expr.tfs.tf_resolution`, `TF_RESOLUTIONS`.
- Produces: `compile_screen(expression, columns, indicators=None, resolution="DAY")`, `CompiledScreen.htf: list[HtfNeed]`, `judge(cs, bars, resolution, htf=None)`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_screen_eval.py`; replace `test_tf_pin_rejected`)

```python
SLOPE_1H = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                      "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}}
SLOPE_W = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "W"}}}}


def test_coarser_pin_compiles_with_one_need():
    cs = compile_screen("EMA(5)@W > 0", [], resolution="DAY")
    assert [(n.tf, n.res, n.need) for n in cs.htf] == [("W", "WEEK", 6)]


def test_pinned_term_costs_no_base_bars():
    assert bars_needed(compile_screen("EMA(50)@W > 0", [], resolution="DAY")) == 300


def test_same_timeframe_pin_accepted():
    cs = compile_screen("EMA(5)@D > 0", [], resolution="DAY")
    assert cs.htf[0].res == "DAY"


def test_finer_pin_refused_with_the_token_span():
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("candle.close > EMA(9)@4H", [], resolution="DAY")
    e = ei.value.err
    assert e.code == "screen_tf_lower"
    assert "@4H is a lower timeframe than this screen's 1D" in e.message
    assert "Run the screen on 4H" in e.message
    assert (e.start, e.end) == (15, 24)  # the pinned operand EMA(9)@4H


def test_finer_pin_in_column_names_its_index():
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("candle.close > 0", [{"name": "x", "expression": "EMA(9)@1H"}], resolution="DAY")
    assert ei.value.field == "columns" and ei.value.index == 0


def test_pane_pin_above_base_accepted_below_refused():
    cs = compile_screen("SLOPE.5 > 0", [], SLOPE_W, resolution="DAY")
    assert cs.htf[0].res == "WEEK"
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("SLOPE.5 > 0", [], SLOPE_1H, resolution="DAY")
    assert ei.value.err.code == "screen_tf_lower"
    assert "SLOPE is pinned to 1H in its settings, lower than this screen's 1D" in ei.value.err.message


def test_unresolvable_pane_pin_is_422_not_500():
    bad = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "SECOND_5"}}}}
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("SLOPE.5 > 0", [], bad, resolution="DAY")
    assert ei.value.err.code == "unsupported_timeframe"


def test_tf_cap_counts_canonical():
    compile_screen("EMA(5)@1H > 0 and EMA(5)@HOUR > 0 and EMA(5)@4H > 0 and EMA(5)@W > 0", [], resolution="MINUTE_15")
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("EMA(5)@1H > 0 and EMA(5)@4H > 0 and EMA(5)@D > 0", [{"name": "w", "expression": "EMA(5)@W"}],
                       resolution="MINUTE_15")
    assert ei.value.err.code == "screen_tf_too_many"


def test_judge_reads_the_pinned_series():
    # Daily bars closing 1..10 from a Monday; weekly bars closing 100 and 200.
    bars = _bars(list(range(1, 11)), step_s=86400)
    monday = bars[0].time
    weeks = [Candle(time=monday + timedelta(weeks=k), open=v, high=v, low=v, close=v, volume=1)
             for k, v in enumerate([100, 200])]
    cs = compile_screen("candle.close@W > 150", [{"name": "w", "expression": "candle.close@W"}], resolution="DAY")
    j = judge(cs, bars, "DAY", {"WEEK": weeks})
    # The judged bar (day 10, the second Wednesday) reads the week that closed before it: close 100.
    assert not j.matched
    j = judge(cs, bars[:8], "DAY", {"WEEK": weeks})  # day 8, the second Monday, still reads week 1
    assert not j.matched
    bars3 = _bars(list(range(1, 16)), step_s=86400)  # day 15: the third Monday, week 2 has closed
    j = judge(cs, bars3, "DAY", {"WEEK": weeks})
    assert j.matched and j.columns == {"w": 200.0}
```

Fix `_bars` in that file so `T0` is a Monday if it is not (2026-01-01 is a Thursday): change `T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)` and confirm the existing tests still pass (they only use relative offsets).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_screen_eval.py -q`
Expected: the new tests FAIL (`TypeError: unexpected keyword 'resolution'`, `screen_tf_unsupported`); old ones pass.

- [ ] **Step 3: Implement**

In `screen_eval.py`: replace the module docstring's last paragraph with "Screens accept pins at their own timeframe or coarser (`@W` on a daily screen, or a pane pinned in its settings); finer pins and a fourth timeframe are refused at compile time. The runner fetches the pinned candles per symbol and hands them to `judge`."; replace `_refuse_unsupported`; add `resolution` to `compile_screen`; add `htf` to `CompiledScreen` and `judge`.

```python
from dataclasses import fields as _dc_fields

from auto_trader.api.htf_source import HtfNeed, htf_needs, _pin_owner
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.strategy.expr.tfs import TF_RESOLUTIONS, tf_resolution

_MAX_TFS = 3
_TF_LABELS = {v: k for k, v in TF_RESOLUTIONS.items()}  # "DAY" -> "D"


def _label(res: str) -> str:
    """The screen's timeframe as the panel shows it: 1D, 4H, 15m."""
    alias = _TF_LABELS.get(res, res)
    return f"1{alias}" if alias in ("D", "W") else alias


def _walk(node):
    """Every node in the tree, parents first."""
    yield node
    for f in _dc_fields(node):
        v = getattr(node, f.name)
        for child in (v if isinstance(v, (list, tuple)) else (v,)):
            if hasattr(child, "__dataclass_fields__"):
                yield from _walk(child)


def _check_pins(node: N.Node, src: str, instances: dict[str, ResolvedInstance],
                resolution: str) -> None:
    """Every referenced timeframe must resolve and be the base or coarser."""
    base_s = resolution_seconds(resolution)
    for n in _walk(node):
        if isinstance(n, N.Tf):
            res = tf_resolution(n.tf)
            if res is None:
                raise ExprError("unsupported_timeframe",
                                f"Timeframe '{n.tf}' is not supported.", n.start, n.end)
            if resolution_seconds(res) < base_s:
                raise ExprError("screen_tf_lower",
                                f"@{n.tf} is a lower timeframe than this screen's {_label(resolution)}. "
                                f"Run the screen on {n.tf} and pin the higher timeframe instead.",
                                n.start, n.end)
    for tf in referenced_tfs(node, instances) - {n.tf for n in _walk(node) if isinstance(n, N.Tf)}:
        owner = _pin_owner(tf, instances) or "An indicator"
        res = tf_resolution(tf)
        if res is None:
            raise ExprError("unsupported_timeframe",
                            f"{owner} is pinned to timeframe '{tf}', which screens cannot compute. "
                            "Change that indicator's timeframe or unpin it.", 0, len(src))
        if resolution_seconds(res) < base_s:
            raise ExprError("screen_tf_lower",
                            f"{owner} is pinned to {tf} in its settings, lower than this screen's "
                            f"{_label(resolution)}. Run the screen on {tf}, or unpin it on the chart.",
                            0, len(src))


def compile_screen(expression: str, columns: list[dict],
                   indicators: dict[str, dict] | None = None,
                   resolution: str = "DAY") -> CompiledScreen:
    instances = resolve_instances(indicators or {})
    try:
        row = parse(expression)
        validate(row, is_exit=False, instances=instances)
        _check_pins(row, expression, instances, resolution)
    except ExprError as e:
        raise ScreenSpecError("expression", 0, _screen_wording(e, expression)) from e
    cols: list[tuple[str, N.Node]] = []
    for idx, col in enumerate(columns):
        src = col["expression"]
        try:
            node = parse_value(src)
            validate_value(node, instances)
            _check_pins(node, src, instances, resolution)
        except ExprError as e:
            raise ScreenSpecError("columns", idx, _screen_wording(e, src)) from e
        cols.append((col["name"], node))
    nodes = [row] + [n for _, n in cols]
    # Each timeframe is one fetch per symbol: cap them, counted canonically.
    htf = htf_needs(nodes, instances)
    if len({n.res for n in htf}) > _MAX_TFS:
        raise ScreenSpecError("expression", 0, ExprError(
            "screen_tf_too_many", f"A screen can pin at most {_MAX_TFS} timeframes.", 0, len(expression)))
    # With the base resolution a pinned term costs 0 base bars: it is computed
    # from its own candles, which the runner fetches separately.
    warm = max(warmup_bars(n, resolution, instances) for n in nodes)
    return CompiledScreen(row, expression, cols, warm, instances, htf)
```

`CompiledScreen` gains `htf: list[HtfNeed]` as its last field. `judge`:

```python
def judge(cs: CompiledScreen, bars: list[Candle], resolution: str,
          htf: dict[str, list[Candle]] | None = None) -> Judgement:
    htf = htf or {}
    ...compile_row(cs.row, bars, resolution, htf, cs.instances, source=cs.source)
    ...series_of(node, bars, resolution, htf, cs.instances)[last]
```

`htf_needs` can raise `HTTPException` from `_tf_span` only for timeframes `_check_pins` already refused, so no mapping is needed. Note the import direction: `core/screen_eval.py` importing `api/htf_source.py` mirrors its existing `api.sweep_apply` import.

In `routers/screens.py` `_compile`: `compile_screen(body.expression, [...], _indicators(body), body.resolution.value)`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_screen_eval.py tests/test_api_screens.py -q`
Expected: all pass. The old `test_tf_pin_rejected` must be gone (replaced by `test_finer_pin_refused_with_the_token_span`; `EMA(9)@D` on the default DAY base is now a same-timeframe pin and compiles).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/screen_eval.py backend/auto_trader/api/routers/screens.py backend/tests/test_screen_eval.py
git commit -m "feat(screener): accept pins at the screen's timeframe or coarser"
```

---

### Task 4: `screen_jobs` fetches the pinned candles per symbol

**Files:**
- Modify: `backend/auto_trader/api/screen_jobs.py`
- Test: `backend/tests/test_screen_jobs.py`

**Interfaces:**
- Consumes: Task 1 (`fetch_htf`, `warm_window`, `closed_before`, `HtfNeed`), Task 3 (`CompiledScreen.htf`, `judge(..., htf)`).
- Produces: `ScreenJobs(loader=None, htf_loader=None, ...)`, `HtfLoader = Callable[[str, str, HtfNeed, str, int, int], Awaitable[tuple[list[Candle], bool]]]`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_screen_jobs.py`)

```python
from auto_trader.api.htf_source import HtfNeed

MONDAY = datetime(2026, 1, 5, tzinfo=timezone.utc)


def _days(n, start=MONDAY):
    return [Candle(time=start + timedelta(days=k), open=1, high=1, low=1, close=1, volume=1.0)
            for k in range(n)]


def _weeks(vals, start=MONDAY):
    return [Candle(time=start + timedelta(weeks=k), open=v, high=v, low=v, close=v, volume=1.0)
            for k, v in enumerate(vals)]


def _htf_loader(table, calls=None, degraded=False):
    async def load(broker, epic, need, side, from_ts, to_ts):
        if calls is not None:
            calls.append((epic, need.res, from_ts, to_ts))
        v = table[epic]
        if isinstance(v, Exception):
            raise v
        return v, degraded
    return load


def _pinned(symbols, expr="candle.close@W > 150"):
    return dict(broker="yfinance", resolution="DAY", side="mid", symbols=symbols,
                cs=compile_screen(expr, [], resolution="DAY"))


def test_pinned_series_reaches_the_judge():
    async def run():
        calls = []
        # Day 15 is the third Monday, so week 2 (close 200) has closed before it.
        base = {"A": _days(15), "B": _days(15)}
        wk = {"A": _weeks([100, 200]), "B": _weeks([100, 100])}
        jobs = ScreenJobs(loader=_loader(base), htf_loader=_htf_loader(wk, calls), clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A", "B"])))
        assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
        a = next(c for c in calls if c[0] == "A")
        assert a[1] == "WEEK" and a[2] == int(MONDAY.timestamp()) and a[3] == NOW
    asyncio.run(run())


def test_pinned_shortfall_skips():
    async def run():
        # Weekly bars that open on the judged day and later: none closed before it.
        late = _weeks([100, 200], start=MONDAY + timedelta(days=14))
        jobs = ScreenJobs(loader=_loader({"A": _days(15)}), htf_loader=_htf_loader({"A": late}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A"])))
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "not enough @W history"}]
    asyncio.run(run())


def test_pinned_degraded_and_error_skip():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _days(15), "B": _days(15)}),
                          htf_loader=_htf_loader({"A": _weeks([100, 200]), "B": RuntimeError("boom")}, degraded=True),
                          clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A", "B"])))
        reasons = {s["epic"]: s["reason"] for s in st["result"]["skipped"]}
        assert reasons == {"A": "broker unavailable, cached bars only", "B": "boom"}
    asyncio.run(run())


def test_pinned_fetch_takes_the_broker_cap():
    async def run():
        gate = asyncio.Event()
        held = []

        async def base(broker, epic, resolution, side, count):
            return _days(15), False

        async def htf(broker, epic, need, side, from_ts, to_ts):
            held.append(epic)
            await gate.wait()
            return _weeks([100, 200]), False

        jobs = ScreenJobs(loader=base, htf_loader=htf, per_broker=1, clock=lambda: NOW)
        jid = jobs.start("u1", **_pinned(["A", "B"]))
        await asyncio.sleep(0.05)
        assert held == ["A"]  # B's pinned fetch waits for the one slot
        gate.set()
        st = await _finish(jobs, "u1", jid)
        assert st["result"]["stats"]["matched"] == 2
    asyncio.run(run())
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_screen_jobs.py -q`
Expected: new tests FAIL with `TypeError: unexpected keyword 'htf_loader'`.

- [ ] **Step 3: Implement**

```python
from auto_trader.api.htf_source import HtfNeed, closed_before, fetch_htf, warm_window

Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]
HtfLoader = Callable[[str, str, HtfNeed, str, int, int], Awaitable[tuple[list[Candle], bool]]]


async def _load_htf(broker: str, epic: str, need: HtfNeed, side: str,
                    from_ts: int, to_ts: int) -> tuple[list[Candle], bool]:
    """Default pinned-candle loader: a warm window through the candle cache,
    reporting the cache's degraded flag like load_alert_bars does."""
    degraded: dict = {}
    start, end, n = warm_window(need, from_ts, to_ts)
    bars = await fetch_htf(need, broker=broker, epic=epic, side=side,
                           from_ts=start, to_ts=end, bars=n, degraded=degraded)
    return bars, bool(degraded)
```

`ScreenJobs.__init__` gains `htf_loader: HtfLoader | None = None` after `loader`, stored as `self._htf_loader = htf_loader or _load_htf`. In `_one`, after `bars = closed_bars(...)` and before the compute semaphore:

```python
            # Pinned timeframes: one fetch each, each taking the broker slot on
            # its own (never one hold across several awaits). Sufficiency is
            # judged at the judged bar's open, the same rule as a backtest's
            # tradeFromTime; the forming pinned bar closes after now, so the
            # alignment gate never reads it and it needs no trimming.
            htf: dict[str, list[Candle]] = {}
            cutoff = int(bars[-1].time.timestamp())
            for need in cs.htf:
                async with self._sems[broker]:
                    pinned, pinned_degraded = await self._htf_loader(
                        broker, epic, need, side, int(bars[0].time.timestamp()), int(self._clock()))
                if pinned_degraded:
                    return None, {"epic": epic, "reason": "broker unavailable, cached bars only"}
                if closed_before(pinned, need.tf_s, cutoff) < need.need:
                    return None, {"epic": epic, "reason": f"not enough @{need.tf} history"}
                htf[need.res] = pinned
            async with self._compute:
                j = await asyncio.to_thread(judge, cs, bars, resolution, htf)
```

Move the `if not bars` check so `bars[-1]` is safe (it already precedes `closed_bars`; add a second `if not bars: return None, {"epic": epic, "reason": "no candles"}` after `closed_bars`, since dropping the forming bar can empty a one-bar list). Update the module docstring's first paragraph: "fetch each symbol's candles, and the candles of every timeframe the screen pins, through the shared candle cache".

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/python3 -m pytest tests/test_screen_jobs.py tests/test_api_screens.py tests/test_screen_eval.py tests/test_htf_source.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/screen_jobs.py backend/tests/test_screen_jobs.py
git commit -m "feat(screener): fetch pinned timeframes per symbol and judge with them"
```

---

### Task 5: Frontend: editor keeps coarser pinned panes, labels show the pin

**Files:**
- Modify: `frontend/src/lib/screenerIndicators.ts`
- Modify: `frontend/src/ScreenerPanel.tsx` (line 172 `editorInstances` call; Condition InfoTip lines 514-520)
- Test: `frontend/src/lib/screenerIndicators.test.ts`, `frontend/src/ScreenerPanel.test.tsx`

**Interfaces:**
- Consumes: `tfSeconds` from `lib/expr/catalog.ts`, `tfSecondsOf` from `lib/timeframe.ts`, `ExprInstance.timeframe`.
- Produces: `editorInstances(copy, chart, resolution)`.

- [ ] **Step 1: Write the failing tests**

In `screenerIndicators.test.ts`, replace the "pinned panes dropped" test and add a label test:

```ts
  it("editor list: copy first, chart adds missing ids, finer pins dropped, coarser kept", () => {
    const chart = [
      { id: "RSI", outputs: ["value"], timeframe: null },
      { id: "ATR", outputs: ["14"], timeframe: null },
      { id: "SLOPE", outputs: ["5"], timeframe: "1H" },
      { id: "FVG", outputs: ["bull_top"], timeframe: "W" },
      { id: "LR", outputs: ["line"], timeframe: "nonsense" },
    ];
    const ids = editorInstances({ RSI: rsi(14) }, chart, "DAY").map((i) => i.id);
    expect(ids).toEqual(["RSI", "ATR", "FVG"]);
    expect(editorInstances({}, chart, "HOUR").map((i) => i.id)).toEqual(["RSI", "ATR", "SLOPE", "FVG"]);
  });

  it("label shows a pane's pin", () => {
    const fvg = { type: "FVG", calcParams: [0.25, 500, 10], extendData: { mtf: { timeframe: "W" } } };
    expect(paneLabels({ FVG: fvg })[0]).toMatch(/^FVG @W · /);
  });
```

In `ScreenerPanel.test.tsx`, where `chartPanes.editor` / `chartPanes.live` are set up, add:

```ts
  it("offers a coarser pinned pane and sends its settings on Run", async () => {
    chartPanes.editor = [{ id: "FVG", outputs: ["bull_top"], timeframe: "W", detail: "" }];
    chartPanes.live = [{ id: "FVG", type: "FVG", calcParams: [0.25, 500, 10], extendData: { mtf: { timeframe: "W" } } }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fillAndRun("AAPL", "FVG.bull_top > 0");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators.FVG.extendData).toEqual({ mtf: { timeframe: "W" } });
  });
```

(Use the existing `fillAndRun` and `chartPanes` helpers in that file; the default timeframe select is DAY.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/screenerIndicators.test.ts src/ScreenerPanel.test.tsx`
Expected: the new tests FAIL (SLOPE/FVG dropped; label has no `@W`).

- [ ] **Step 3: Implement**

`screenerIndicators.ts`:

```ts
import { tfSeconds } from "./expr/catalog";
import { tfSecondsOf } from "./timeframe";

/** The editor's list: the copy's panes, then chart panes the copy lacks.
 * A pane pinned in its settings stays only when its pin is the screen's
 * timeframe or coarser: screens refuse finer pins, so the editor should
 * flag such a ref as unknown instead of accepting it and failing on Run.
 * A pin tfSeconds cannot read is dropped for the same reason. */
export function editorInstances(copy: PaneCopy, chart: readonly ExprInstance[], resolution: string): ExprInstance[] {
  const own = exprInstancesFor(copyAsLive(copy));
  const ids = new Set(own.map((i) => i.id));
  const baseS = tfSecondsOf(resolution);
  const ok = (i: ExprInstance) => {
    if (i.timeframe == null) return true;
    const s = tfSeconds(i.timeframe);
    return s != null && s >= baseS;
  };
  return [...own, ...chart.filter((i) => !ids.has(i.id))].filter(ok);
}
```

`paneLabels`: build the map from `exprInstancesFor` as `[i.id, i]` and label `` `${id}${i.timeframe ? ` @${i.timeframe}` : ""} · ${i.detail}` `` when `i.detail` is set (keep the no-detail fallback). Check `tfSecondsOf`'s signature in `lib/timeframe.ts` (it takes a canonical resolution and returns a number); if it throws on unknown input, wrap in try/catch and treat as 0.

`ScreenerPanel.tsx`: `editorInstances(indicators, chartEditor, resolution)` with `resolution` in the memo deps. InfoTip text: replace `"The timeframe sets which bars are used."` with the two lines `"The timeframe sets which bars are used. @W pins a higher one: the value is its last closed bar."` and `"Pins must be the screen's timeframe or higher."`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd frontend && npx vitest run src/lib/screenerIndicators.test.ts src/ScreenerPanel.test.tsx && npx tsc -b && npx eslint src/lib/screenerIndicators.ts src/ScreenerPanel.tsx src/lib/screenerIndicators.test.ts src/ScreenerPanel.test.tsx`
Expected: tests pass, no tsc or eslint output.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/screenerIndicators.ts frontend/src/lib/screenerIndicators.test.ts frontend/src/ScreenerPanel.tsx frontend/src/ScreenerPanel.test.tsx
git commit -m "feat(screener): editor offers coarser pinned panes and labels the pin"
```

---

### Task 6: Docs and a live API check

**Files:**
- Modify: `CLAUDE.md` (Screener section, "Timeframe-pinned panes and `@tf` pins are refused..." sentence)
- Modify: `docs/superpowers/specs/2026-10-22-screener-chart-indicators-design.md` (Out of scope: remove the pins line, point to the new spec)

- [ ] **Step 1: Update CLAUDE.md**

Replace the sentence starting "Timeframe-pinned panes and `@tf` pins are refused" with:

"Pins at the screen's timeframe or coarser (`EMA(50)@W`, a pane pinned in its settings) are fetched per symbol through `api/htf_source.py`, the one service that also feeds the backtest, sweep, WFO, evaluate and closeness paths (`htf_needs` + `fetch_htf` + `closed_before`; `source_htf` for shipped-or-fetched with a sufficiency cutoff). Finer pins 422 with `screen_tf_lower` (run the screen on that timeframe and pin the coarser one instead); more than 3 canonical timeframes 422 with `screen_tf_too_many`; a symbol with too few closed pinned bars before the judged bar is skipped with `not enough @W history`. A pinned term costs no base bars (`warmup_bars` gets the base resolution)."

- [ ] **Step 2: Live check against the running backend** (no browser tab)

```bash
curl -s -X POST localhost:8000/api/screens/run -H 'Content-Type: application/json' -d '{"broker":"capital","resolution":"DAY","symbols":["US100","GOLD","EURUSD"],"expression":"candle.close@W > 0","columns":[{"name":"w","expression":"candle.close@W"}]}'
```

Poll `/api/screens/jobs/<jobId>` until done; expect 3 matches with a `w` column equal to each symbol's previous weekly close. Then:

```bash
curl -s -X POST localhost:8000/api/screens/run -H 'Content-Type: application/json' -d '{"broker":"capital","resolution":"DAY","symbols":["US100"],"expression":"EMA(9)@4H > 0"}'
```

Expect 422 with code `screen_tf_lower`. Report both results in the final message.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-22-screener-chart-indicators-design.md
git commit -m "docs: screener timeframe pins and the shared htf_source service"
```
