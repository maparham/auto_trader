# Baseline Comparison (Excess-over-Baseline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every expression backtest and expression walk-forward run automatically computes Null (`1==1` entries, same structure) and Hold (enter-and-hold, no brackets) baseline runs and reports the strategy's excess over the Null baseline, display-only.

**Architecture:** A backend `baselines` module synthesizes variant request models from a validated `ExprBacktestRequest`. The expr backtest route runs the variants after the main run and embeds their metrics in the response. The WFO job runs the variants per fold test window inside the existing worker pool (period-gated flat-start runs, same mechanism as `run_test`), threads per-fold baseline metrics through `_aggregate`, and adds two aggregate fields. The frontend always requests baselines and renders a Baselines section on the backtest overview and an Excess % column + two scorecard tiles on WFO results.

**Tech Stack:** FastAPI + Pydantic v2 (backend), pytest, React + TypeScript + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-08-13-baseline-comparison-design.md`

## Global Constraints

- Baselines apply to **expression** runs only (`/api/expr/backtest`, `/api/expr/walkforward/jobs`). The structured `BacktestRequest` has no entry expressions (coded strategies own their entries), so coded/structured runs ignore the feature. This is a deliberate narrowing of the spec's "structured route" line; note it in the spec if asked.
- End-user copy: no em dashes (use colons/parentheses); tooltip phrasing must not start with "How"/"Which" (declarative noun phrases).
- Tooltips use the shared `Tooltip` / `InfoTip` components (`frontend/src/components/`).
- Frontend test baseline on main has 5-7 known failures (order-sensitive); do not "fix" them, only keep the files you touch green.
- Backend tests run from `backend/`: `python -m pytest tests/<file> -q`. Frontend from `frontend/`: `npx vitest run <file>`.
- The robustness **score** formula (`engine/stability.py`) is unchanged.
- Commits end with the Co-Authored-By / Claude-Session trailer used by this session.

---

### Task 1: Baseline request synthesis (`baselines.py`)

**Files:**
- Create: `backend/auto_trader/api/baselines.py`
- Test: `backend/tests/test_baselines.py`

**Interfaces:**
- Consumes: `auto_trader.api.schemas.ExprBacktestRequest`, `ExprRowDTO`.
- Produces: `null_request(req: ExprBacktestRequest) -> ExprBacktestRequest` and `hold_request(req: ExprBacktestRequest) -> ExprBacktestRequest`. Both return NEW model instances (deep copy); the input is never mutated. Tasks 3 and 5 call these.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_baselines.py
"""null_request / hold_request: synthesize baseline variants of an expr
backtest request. Null keeps everything but the entry signal; Hold strips
exits, risk, scaling, and the session mask so one position rides per side."""
from auto_trader.api.baselines import hold_request, null_request
from auto_trader.api.schemas import ExprBacktestRequest


def _req(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": 3600 * k, "open": 1.0, "high": 1.0, "low": 1.0,
                     "close": 1.0, "volume": 1.0} for k in range(3)],
        "longEntry": [{"expr": "EMA(9) x> EMA(21)"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [{"expr": "EMA(9) x< EMA(21)"}],
        "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": {"stop": {"kind": "pct", "value": 1.0},
                     "takeProfit": {"kind": "pct", "value": 1.0}},
        "mask": {"enabled": True, "session": "NYSE"},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0,
        "sweep": {"combos": [{"lit:long.entry.0.0": 9}]},
    }
    d.update(over)
    return ExprBacktestRequest.model_validate(d)


def test_null_replaces_enabled_entries_keeps_the_rest():
    req = _req()
    out = null_request(req)
    assert [r.expr for r in out.longEntry] == ["1==1"]
    # Disabled side's entries left alone (it never trades anyway).
    assert [r.expr for r in out.shortEntry] == ["EMA(9) x< EMA(21)"]
    # Exit rules, risk, mask survive.
    assert [r.expr for r in out.longExit] == ["candle.close < entry"]
    assert out.longRisk is not None
    assert out.mask is not None
    # Sweep/WFO stripped: a baseline is a single run.
    assert out.sweep is None and out.walkforward is None


def test_null_both_sides_when_both_enabled():
    out = null_request(_req(shortEnabled=True))
    assert [r.expr for r in out.longEntry] == ["1==1"]
    assert [r.expr for r in out.shortEntry] == ["1==1"]


def test_hold_strips_exits_risk_scaling_mask():
    out = hold_request(_req())
    assert [r.expr for r in out.longEntry] == ["1==1"]
    assert out.longExit == [] and out.shortExit == []
    assert out.longRisk is None and out.shortRisk is None
    assert out.longScaling is None and out.shortScaling is None
    assert out.mask is None
    assert out.sweep is None and out.walkforward is None


def test_input_not_mutated():
    req = _req()
    null_request(req)
    hold_request(req)
    assert [r.expr for r in req.longEntry] == ["EMA(9) x> EMA(21)"]
    assert req.longRisk is not None and req.mask is not None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_baselines.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.api.baselines`

- [ ] **Step 3: Implement the module**

```python
# backend/auto_trader/api/baselines.py
"""Baseline variants of an expression backtest request.

Null: entry rules replaced by `1==1` on each ENABLED side; everything else
(exits, risk, scaling, session mask, costs, sides) identical. Isolates what
the entry signal contributes over "always in".

Hold: `1==1` entries with exits, risk, scaling, and mask stripped, so each
enabled side enters once and the engine's hold-until-window-end behavior
carries the position to the end. Measures the raw market through the same
cost model.

Both strip sweep/walkforward sub-objects: a baseline is always a single run.
"""
from __future__ import annotations

from auto_trader.api.schemas import ExprBacktestRequest, ExprRowDTO

_ALWAYS = [ExprRowDTO(expr="1==1", enabled=True)]


def null_request(req: ExprBacktestRequest) -> ExprBacktestRequest:
    up: dict = {"sweep": None, "walkforward": None, "progressId": None}
    if req.longEnabled:
        up["longEntry"] = list(_ALWAYS)
    if req.shortEnabled:
        up["shortEntry"] = list(_ALWAYS)
    return req.model_copy(deep=True, update=up)


def hold_request(req: ExprBacktestRequest) -> ExprBacktestRequest:
    up: dict = {
        "sweep": None, "walkforward": None, "progressId": None,
        "longExit": [], "shortExit": [],
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "mask": None,
    }
    if req.longEnabled:
        up["longEntry"] = list(_ALWAYS)
    if req.shortEnabled:
        up["shortEntry"] = list(_ALWAYS)
    return req.model_copy(deep=True, update=up)
```

Note: if `model_copy(deep=True, update=...)` on this Pydantic version applies
`update` before the deep copy in a way that shares the `_ALWAYS` rows, the
`list(_ALWAYS)` wrappers still give each call its own list; `ExprRowDTO` is
immutable in practice (never mutated downstream), so sharing row instances is
acceptable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_baselines.py -q`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/baselines.py backend/tests/test_baselines.py
git commit -m "feat(baselines): null/hold request synthesis for expr backtests"
```

---

### Task 2: `1==1` engine behavior regression test

**Files:**
- Test: `backend/tests/test_baselines_engine.py`

**Interfaces:**
- Consumes: Task 1's `null_request`/`hold_request`; the existing
  `POST /api/expr/backtest` route.
- Produces: the pinned engine guarantees later tasks rely on: `1==1` parses,
  enters on the first tradeable bar with no warmup, and a no-exit no-risk
  no-mask run holds one position per side to the end.

This is the spec's verification step, kept as a regression test. If any
assertion fails, STOP: the fallback is a dedicated `always` node in the
expression engine, which upgrades the plan (report back instead of improvising).

- [ ] **Step 1: Write the tests**

```python
# backend/tests/test_baselines_engine.py
"""Engine guarantees the baseline feature rests on: `1==1` parses, enters on
the first tradeable bar (no indicator warmup), and a Hold-shaped request
(no exits, no risk, no mask) opens exactly one position per side and carries
it to the end of the window."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.baselines import hold_request, null_request
from auto_trader.api.schemas import ExprBacktestRequest

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c,
             "volume": 100.0} for k, c in enumerate(closes)]


def _req(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": _candles([100 + i for i in range(30)]),  # steady rise
        "longEntry": [{"expr": "EMA(3) x> EMA(5)"}],
        "longExit": [], "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None,
    }
    d.update(over)
    return ExprBacktestRequest.model_validate(d)


def _post(model: ExprBacktestRequest):
    r = client.post("/api/expr/backtest",
                    json=model.model_dump(mode="json", exclude_none=True))
    assert r.status_code == 200, r.text
    return r.json()


def test_always_true_hold_opens_once_and_holds_to_end():
    body = _post(hold_request(_req()))
    trades = body["trades"]
    assert len(trades) == 1  # one entry, force-closed at range end
    # Entry on the FIRST tradeable bar: no indicator warmup for a constant.
    assert trades[0]["entry_time"] == 0 or trades[0]["entry_time"] == 3600
    # Rising market, long hold: profitable.
    assert body["summary"]["net_pnl"] > 0


def test_always_true_null_keeps_brackets():
    req = _req(longRisk={"stop": {"kind": "pct", "value": 1.0},
                         "takeProfit": {"kind": "pct", "value": 1.0}})
    body = _post(null_request(req))
    # With 1% brackets on a steady rise, the run re-enters repeatedly:
    # strictly more trades than the single hold position.
    assert len(body["trades"]) > 1


def test_always_true_short_side():
    body = _post(hold_request(_req(longEnabled=False, shortEnabled=True,
                                   shortEntry=[{"expr": "EMA(3) x< EMA(5)"}])))
    trades = body["trades"]
    assert len(trades) == 1
    assert trades[0]["side"] == "short"
```

- [ ] **Step 2: Run the tests**

Run: `cd backend && python -m pytest tests/test_baselines_engine.py -q`
Expected: 3 passed. The first assertion's two accepted entry times cover
whether the engine fills on the signal bar or the next open; whichever the
engine does, lock the test to that single value once observed and re-run.
If anything else fails (parse error on `1==1`, multiple hold positions),
STOP and report: fallback is an `always` engine node, plan upgrade required.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_baselines_engine.py
git commit -m "test(baselines): pin 1==1 entry and hold-to-end engine behavior"
```

---

### Task 3: Baselines on the expr backtest route

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (ExprBacktestRequest + BacktestResponse)
- Modify: `backend/auto_trader/api/routers/expr.py` (route `expr_backtest`, line ~219)
- Test: `backend/tests/test_api_expr_baselines.py`

**Interfaces:**
- Consumes: Task 1's `null_request`/`hold_request`.
- Produces: request field `baselines: list[Literal["null", "hold"]] | None = None`
  on `ExprBacktestRequest`; response field `baselines: dict | None` on
  `BacktestResponse` with shape `{"null": <metrics dict|None>, "hold": <metrics dict|None>}`
  (a plain dict field, not a nested model: metrics are already served as a
  dict elsewhere in the response). Task 8 reads `result.baselines.null.net_pnl`
  etc. on the frontend.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_api_expr_baselines.py
"""POST /api/expr/backtest with baselines=["null","hold"]: the response embeds
each baseline's full metrics dict; omitting the field keeps the response
unchanged (None)."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c,
             "volume": 100.0} for k, c in enumerate(closes)]


def _base_req(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": _candles([100 + i for i in range(30)]),
        "longEntry": [{"expr": "EMA(3) x> EMA(5)"}],
        "longExit": [], "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None,
    }
    req.update(over)
    return req


def test_baselines_absent_by_default():
    r = client.post("/api/expr/backtest", json=_base_req())
    assert r.status_code == 200
    assert r.json()["baselines"] is None


def test_baselines_null_and_hold_returned():
    r = client.post("/api/expr/backtest",
                    json=_base_req(baselines=["null", "hold"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    for kind in ("null", "hold"):
        m = b[kind]
        assert m is not None
        assert "net_pnl" in m and "return_pct" in m and "sharpe" in m
    # Rising market: the hold baseline is profitable.
    assert b["hold"]["net_pnl"] > 0


def test_baselines_null_only():
    r = client.post("/api/expr/backtest", json=_base_req(baselines=["null"]))
    b = r.json()["baselines"]
    assert b["null"] is not None and b["hold"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_expr_baselines.py -q`
Expected: FAIL (422 on the unknown `baselines` field, or KeyError on the
response field, depending on model strictness).

- [ ] **Step 3: Add the schema fields**

In `backend/auto_trader/api/schemas.py`:

On `ExprBacktestRequest` (next to `progressId`):

```python
    # Baseline companion runs (expr runs only). "null" = entries replaced by
    # 1==1, everything else identical; "hold" = 1==1 entries with exits, risk,
    # scaling, and mask stripped (enter once, hold to window end). The response
    # carries each requested baseline's metrics in `baselines`.
    baselines: list[Literal["null", "hold"]] | None = None
```

On `BacktestResponse`:

```python
    # {"null": metrics|None, "hold": metrics|None} when the request asked for
    # baselines; None otherwise. Metrics are compute_metrics dicts.
    baselines: dict | None = None
```

- [ ] **Step 4: Refactor the route and run the baselines**

In `backend/auto_trader/api/routers/expr.py`, the body of `expr_backtest`
from "groups = [" through the `engine.run(...)`/response return currently
builds parsed groups, the strategy, the engine, and the response inline.
Extract the per-request compile-and-run into a local async helper so the
baselines reuse it verbatim:

```python
async def _compiled_run(r):
    """Parse r's rule groups, compile, and run the engine over r's candles.
    Returns (BacktestResult, metrics dict). Mirrors the main-path code; the
    main path now calls this too so the two can never drift."""
```

The helper's body is the existing group-parse/compile/`ExprRuleStrategy`/
`BacktestEngine` code moved verbatim, parameterized on `r` instead of `req`,
ending with `result = engine.run(candles)` (match the actual run call in the
file) and `metrics = compute_metrics(result.trades, result.equity,
result.net_pnl, r.costs.startingCash, resolution_seconds(r.resolution),
financing_total=result.financing_total)`. Candles/HTF conversion and the ATR
risk series build move inside the helper (they depend on `r`'s risk config).
The progress-registration block stays main-path-only (baseline runs report no
progress).

After the main run's response is assembled (the `_result_to_response(...)`
call), add:

```python
    baselines_out = None
    if req.baselines:
        from auto_trader.api.baselines import hold_request, null_request
        synth = {"null": null_request, "hold": hold_request}
        baselines_out = {"null": None, "hold": None}
        for kind in req.baselines:
            try:
                _res, m = await _compiled_run(synth[kind](req))
                baselines_out[kind] = m
            except Exception:  # noqa: BLE001  a baseline must never fail the run
                baselines_out[kind] = None
    response.baselines = baselines_out
```

(If the route returns `_result_to_response(...)` directly, bind it to
`response` first, set `.baselines`, then return it.)

- [ ] **Step 5: Run the new tests and the existing expr route suite**

Run: `cd backend && python -m pytest tests/test_api_expr_baselines.py tests/test_api_expr.py -q`
Expected: all pass (the refactor must not change existing route behavior).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/expr.py backend/tests/test_api_expr_baselines.py
git commit -m "feat(baselines): null/hold companion runs on POST /api/expr/backtest"
```

---

### Task 4: Excess math and aggregate fields (`wfo_stitch`)

**Files:**
- Modify: `backend/auto_trader/api/wfo_stitch.py`
- Test: `backend/tests/test_wfo_stitch.py` (append)

**Interfaces:**
- Consumes: fold dicts as built in `wfo_jobs._aggregate` (keys `oos_metrics`,
  and after Task 5 `null_metrics`).
- Produces: `fold_excess(oos_metrics: dict | None, null_metrics: dict | None) -> float | None`
  and two new keys in `aggregate(...)`'s returned block:
  `median_fold_excess_pct`, `pct_folds_beating_null`. Task 5 stores
  `fold_excess`'s result on each fold as `excess_return_pct`; Task 7 renders
  the two block keys.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_wfo_stitch.py`:

```python
from auto_trader.api.wfo_stitch import fold_excess


def test_fold_excess_subtracts_null_return():
    assert fold_excess({"return_pct": 5.0}, {"return_pct": 3.0}) == 2.0
    assert fold_excess({"return_pct": -1.0}, {"return_pct": 2.5}) == -3.5


def test_fold_excess_none_when_either_missing():
    assert fold_excess(None, {"return_pct": 3.0}) is None
    assert fold_excess({"return_pct": 5.0}, None) is None
    assert fold_excess({"return_pct": None}, {"return_pct": 3.0}) is None
    assert fold_excess({"return_pct": 5.0}, {"return_pct": None}) is None


def test_aggregate_excess_fields():
    folds = [
        {"oos_metrics": {"return_pct": 5.0, "net_pnl": 5.0}, "wfe": None,
         "excess_return_pct": 2.0},
        {"oos_metrics": {"return_pct": -1.0, "net_pnl": -1.0}, "wfe": None,
         "excess_return_pct": -3.0},
        {"oos_metrics": {"return_pct": 1.0, "net_pnl": 1.0}, "wfe": None,
         "excess_return_pct": 4.0},
        {"oos_metrics": None, "wfe": None, "excess_return_pct": None},
    ]
    from auto_trader.api.wfo_stitch import aggregate
    block = aggregate(folds, {}, {}, None, oos_trades_total=0)
    assert block["median_fold_excess_pct"] == 2.0   # median of [2, -3, 4]
    assert block["pct_folds_beating_null"] == round(2 / 3, 4)  # None fold excluded


def test_aggregate_excess_fields_all_missing():
    folds = [{"oos_metrics": None, "wfe": None, "excess_return_pct": None}]
    from auto_trader.api.wfo_stitch import aggregate
    block = aggregate(folds, {}, {}, None, oos_trades_total=0)
    assert block["median_fold_excess_pct"] is None
    assert block["pct_folds_beating_null"] is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_wfo_stitch.py -q`
Expected: FAIL with `ImportError: cannot import name 'fold_excess'`

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/wfo_stitch.py` add below `fold_wfe`:

```python
def fold_excess(oos_metrics: dict | None, null_metrics: dict | None) -> float | None:
    """Strategy return minus the null baseline's return over the same test
    window. None when either side is missing: no comparison, not zero."""
    if not oos_metrics or not null_metrics:
        return None
    a, b = oos_metrics.get("return_pct"), null_metrics.get("return_pct")
    if a is None or b is None:
        return None
    return round(a - b, 4)
```

In `aggregate(...)`, alongside the existing list builds:

```python
    excesses = [f.get("excess_return_pct") for f in folds]
    excesses = [e for e in excesses if e is not None]
```

and in the block dict (before the robustness_score call, which is unchanged):

```python
        "median_fold_excess_pct": round(median(excesses), 4) if excesses else None,
        "pct_folds_beating_null": round(
            sum(1 for e in excesses if e > 0) / len(excesses), 4) if excesses else None,
```

- [ ] **Step 4: Run the file's full suite**

Run: `cd backend && python -m pytest tests/test_wfo_stitch.py -q`
Expected: all pass (old tests unaffected: `aggregate` gains keys, loses none).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/wfo_stitch.py backend/tests/test_wfo_stitch.py
git commit -m "feat(wfo): fold_excess and excess aggregate fields"
```

---

### Task 5: Baseline runs inside the WFO job

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (WalkForwardDTO + the fold DTO)
- Modify: `backend/auto_trader/api/wfo_worker.py`
- Modify: `backend/auto_trader/api/wfo_jobs.py`
- Test: `backend/tests/test_expr_wfo.py` (append one test)

**Interfaces:**
- Consumes: Task 1's synthesis, Task 4's `fold_excess`.
- Produces: `WalkForwardDTO.baselines: list[Literal["null", "hold"]] | None = None`;
  `wfo_worker.run_baseline(payload: dict) -> dict` with payload
  `{"key": "s0/f2", "kind": "null"|"hold", "test_from": int, "test_to": int}`
  returning `{"key", "kind", "metrics": dict|None, "error": str|None}`;
  fold result entries gain `null_metrics`, `hold_metrics`,
  `excess_return_pct` (all optional, default None). Task 7 renders these.

- [ ] **Step 1: Write the failing end-to-end test**

Append to `backend/tests/test_expr_wfo.py` (reuse its module-level `client`,
`_candles`, `_WAVE`, `_WFO`, and the store/pool fixtures its existing tests
use; mirror `test_expr_wfo_runs_and_completes` for submit/poll mechanics):

```python
def test_expr_wfo_baselines_per_fold(tmp_wfo_store):
    wfo = {**_WFO, "baselines": ["null", "hold"]}
    req = _base_expr_req(walkforward=wfo)   # same builder the existing tests use
    job_id = _submit_and_wait(req)          # same submit/poll helper pattern
    result = _final_result(job_id)
    folds = result["schemes"][0]["folds"]
    assert folds, "no folds produced"
    # Every fold that has oos_metrics also has baseline metrics and an excess.
    scored = [f for f in folds if f["oos_metrics"] is not None]
    assert scored, "no scored folds"
    for f in scored:
        assert f["null_metrics"] is not None
        assert f["hold_metrics"] is not None
        assert f["excess_return_pct"] == round(
            f["oos_metrics"]["return_pct"] - f["null_metrics"]["return_pct"], 4)
    rb = result["schemes"][0]["robustness"]
    assert "median_fold_excess_pct" in rb
    assert "pct_folds_beating_null" in rb


def test_expr_wfo_without_baselines_fields_none(tmp_wfo_store):
    req = _base_expr_req(walkforward=_WFO)
    job_id = _submit_and_wait(req)
    result = _final_result(job_id)
    f = result["schemes"][0]["folds"][0]
    assert f.get("null_metrics") is None and f.get("hold_metrics") is None
    assert f.get("excess_return_pct") is None
```

`_base_expr_req` / `_submit_and_wait` / `_final_result` name whatever helpers
the existing tests in this file actually use; if the existing tests inline the
submit/poll loop instead, inline the same loop here (copy it, do not invent a
new pattern). The assertions are the deliverable; the plumbing must match the
file's existing style.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_expr_wfo.py -q -k baselines`
Expected: FAIL (422 on the unknown `baselines` WalkForwardDTO field, or
KeyError `null_metrics`).

- [ ] **Step 3: Schema fields**

In `backend/auto_trader/api/schemas.py`:

- `WalkForwardDTO` gains (same doc-comment style as its neighbors):

```python
    # Baseline companion runs per fold test window (expr WFO only): "null" =
    # 1==1 entries, same structure; "hold" = enter-and-hold. Display-only.
    baselines: list[Literal["null", "hold"]] | None = None
```

- The WFO fold DTO (the model `test_wfo_schemas.py` covers; it declares
  `train_from/test_from/combo/is_metrics/oos_metrics/wfe/low_sample/error`)
  gains three optional fields:

```python
    null_metrics: dict | None = None
    hold_metrics: dict | None = None
    excess_return_pct: float | None = None
```

- [ ] **Step 4: Worker `run_baseline`**

In `backend/auto_trader/api/wfo_worker.py` (imports at top:
`from auto_trader.api import baselines as baselines_mod`):

```python
_BASELINE_REQS: dict[str, object] = {}


def run_baseline(payload: dict) -> dict:
    """Flat-start baseline run over one fold's test window, via the same
    period env-combo gating as run_test. The synthesized request is built
    once per kind per worker and cached. Never raises."""
    s = sweep_worker._STATE
    assert s is not None, "worker_init not called"
    kind = payload["kind"]
    test_from, test_to = payload["test_from"], payload["test_to"]
    try:
        req = _BASELINE_REQS.get(kind)
        if req is None:
            synth = baselines_mod.null_request if kind == "null" else baselines_mod.hold_request
            req = synth(s.req)
            _BASELINE_REQS[kind] = req
        combo = {"period:from": test_from, "period:to": test_to}
        result = sweep_worker.execute_combo(s, req, combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        metrics = slice_window_metrics(
            result.trades, result.equity, test_from, test_to, cash, res_s)
        return {"key": payload["key"], "kind": kind, "metrics": metrics,
                "error": None}
    except Exception as e:  # noqa: BLE001
        return {"key": payload.get("key"), "kind": payload.get("kind"),
                "metrics": None, "error": str(e)}
```

Caveat to verify while implementing: `s.req` in the expr WFO path is the
expr request model (worker_init's `expr_sweep=True` path). `run_baseline`
must only ever be dispatched for expr jobs (Step 5 gates it), so
`baselines_mod` never sees a structured request.

- [ ] **Step 5: Jobs dispatch and aggregation**

In `backend/auto_trader/api/wfo_jobs.py`:

1. Where the test phase builds `test_payloads` (line ~194: one payload per
   selected fold winner with `key`/`combo`/`test_from`/`test_to`), also build
   baseline payloads when the job's WalkForwardDTO carries baselines AND the
   job is an expr job (the flag the manager already tracks for worker_init's
   `expr_sweep`):

```python
                baseline_payloads: list[dict] = []
                if wf_baselines and expr_job:
                    seen: set[tuple] = set()
                    for p in test_payloads:
                        for kind in wf_baselines:
                            k = (p["key"], kind)
                            if k in seen:
                                continue
                            seen.add(k)
                            baseline_payloads.append({
                                "key": p["key"], "kind": kind,
                                "test_from": p["test_from"],
                                "test_to": p["test_to"],
                            })
```

   Submit them to the same pool alongside the run_test futures
   (`pool.submit(wfo_worker.run_baseline, p)`), collect rows into
   `baselines_by_key: dict[str, dict[str, dict]]` keyed
   `baselines_by_key[key][kind] = row`. Wire `wf_baselines` from the parsed
   WalkForwardDTO the same way `min_test_trades` and the schedule reach this
   scope, and count the extra futures into the job's done/total progress the
   same way test futures are counted.

2. In `_aggregate`, thread `baselines_by_key` in as a parameter (default
   `{}`), and inside the fold loop after `entry["oos_metrics"]` is set:

```python
                base = baselines_by_key.get(key, {})
                nrow, hrow = base.get("null"), base.get("hold")
                entry["null_metrics"] = nrow["metrics"] if nrow else None
                entry["hold_metrics"] = hrow["metrics"] if hrow else None
                entry["excess_return_pct"] = fold_excess(
                    entry["oos_metrics"], entry["null_metrics"])
```

   (Also add the three keys, as `None`, to the initial `entry = {...}` dict so
   the no-winner/errored branches carry them too. Import `fold_excess` next to
   the existing `fold_wfe` import.)

3. Nothing to change in `_persist_wfo`/`wfo_store`: the result is stored as a
   JSON blob, and the new keys ride along; archived pre-feature rows simply
   lack them.

- [ ] **Step 6: Run the WFO suites**

Run: `cd backend && python -m pytest tests/test_expr_wfo.py tests/test_wfo_jobs.py tests/test_wfo_schemas.py tests/test_wfo_worker.py -q`
Expected: all pass, including the two new tests.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/wfo_worker.py backend/auto_trader/api/wfo_jobs.py backend/tests/test_expr_wfo.py
git commit -m "feat(wfo): per-fold null/hold baseline runs and excess fields"
```

---

### Task 6: Frontend requests baselines; API types

**Files:**
- Modify: `frontend/src/api.ts` (ExprBacktestRequest + BacktestResult + WfoFold + robustness types, `runExprBacktest` at line ~361)
- Modify: `frontend/src/lib/wfo.ts` (`buildWalkForwardPayload`: include `baselines`)
- Modify: the expr-backtest submission site (the caller that builds the
  `runExprBacktest` request from panel config; find it via
  `grep -n "runExprBacktest(" frontend/src` and edit the request builder, not
  the transport function)
- Test: `frontend/src/lib/wfo.test.ts` (append; create only if absent)

**Interfaces:**
- Consumes: Task 3/5 API additions.
- Produces: `BacktestResult.baselines?: { null: Record<string, number | null> | null; hold: Record<string, number | null> | null } | null`;
  `WfoFold.null_metrics` / `hold_metrics` / `excess_return_pct` (all
  `| null`); robustness type gains `median_fold_excess_pct` /
  `pct_folds_beating_null` (`number | null`). Tasks 7-8 render these.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/wfo.test.ts` (mirroring the file's existing
`buildWalkForwardPayload` tests' setup):

```ts
it("includes baselines [null, hold] in the walk-forward payload", () => {
  const { payload } = buildWalkForwardPayload(AXES, DEFAULT_WFO_CONFIG);
  expect(payload.baselines).toEqual(["null", "hold"]);
});
```

(`AXES` stands for whatever minimal valid axes fixture the file's existing
tests construct; reuse it verbatim.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/wfo.test.ts`
Expected: FAIL (`payload.baselines` undefined).

- [ ] **Step 3: Implement**

- `api.ts`: add the fields above to the request/response interfaces. On
  `ExprBacktestRequest`: `baselines?: ("null" | "hold")[] | null;`.
- `lib/wfo.ts` `buildWalkForwardPayload`: set `baselines: ["null", "hold"]`
  on the returned walkforward payload object (always on: product decision).
- Expr backtest submission: in the request builder that feeds
  `runExprBacktest`, add `baselines: ["null", "hold"]` for single (non-sweep)
  runs only: sweeps re-use the same builder but their per-combo jobs must NOT
  carry the field (the sweep endpoint ignores it, but do not send dead
  weight; gate on the same condition that decides a plain run vs a sweep
  submission).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/wfo.test.ts && npx tsc --noEmit`
Expected: pass, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/wfo.ts frontend/src/lib/wfo.test.ts <submission-site file>
git commit -m "feat(baselines): frontend always requests null/hold baselines"
```

---

### Task 7: WFO results UI: Excess % column and scorecard tiles

**Files:**
- Modify: `frontend/src/WfoResults.tsx`
- Test: `frontend/src/WfoResults.test.tsx` (append)

**Interfaces:**
- Consumes: Task 6's `WfoFold.excess_return_pct` and robustness
  `median_fold_excess_pct` / `pct_folds_beating_null`.
- Produces: user-visible column and tiles; nothing downstream.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/WfoResults.test.tsx`, reusing the file's existing
result-fixture builder (extend the fixture's folds with
`excess_return_pct: 2.5` / `-1.2` and the robustness block with
`median_fold_excess_pct: 0.65`, `pct_folds_beating_null: 0.57`):

```tsx
it("renders the Excess % column with sign coloring", () => {
  renderResults(fixtureWithExcess());
  expect(screen.getByText("Excess %")).toBeTruthy();
  expect(screen.getByText("+2.5%")).toBeTruthy();
  expect(screen.getByText("-1.2%")).toBeTruthy();
});

it("renders the excess scorecard tiles", () => {
  renderResults(fixtureWithExcess());
  expect(screen.getByText("Median excess")).toBeTruthy();
  expect(screen.getByText("Folds > null")).toBeTruthy();
  expect(screen.getByText("57%")).toBeTruthy();
});

it("renders dashes when baseline data is absent (old archive)", () => {
  renderResults(fixtureWithoutExcess());
  // Column still present, cells show the en-dash placeholder.
  expect(screen.getByText("Excess %")).toBeTruthy();
});
```

(`renderResults` / fixture names stand for the file's actual helpers; reuse
its established render path. If the file renders `WfoResults` directly with a
`WfoRunState`, extend that state object.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/WfoResults.test.tsx`
Expected: new tests FAIL ("Excess %" not found); the 7 existing tests pass.

- [ ] **Step 3: Implement**

In `frontend/src/WfoResults.tsx`:

- `FoldCol` union gains `"excess"`; `foldColValue` returns
  `f.excess_return_pct ?? null` for it.
- `FOLD_TIPS` gains:

```ts
  excess: "Fold return minus the null baseline's return over the same test window. Positive means the signal beat no-signal.",
```

- Fold table header row: after the "OOS ret %" column, add (same
  Tooltip + SweepSortHeader wrapping as its neighbors):

```tsx
                <th>
                  <Tooltip content={FOLD_TIPS.excess}>
                    <span><SweepSortHeader<FoldCol> label="Excess %" col="excess" sort={sort} onSort={toggleSort} /></span>
                  </Tooltip>
                </th>
```

- Fold body row: after the OOS ret cell:

```tsx
                          <td className={f.excess_return_pct == null ? "" : f.excess_return_pct >= 0 ? "pos" : "neg"}>
                            {f.excess_return_pct == null ? "–"
                              : `${f.excess_return_pct >= 0 ? "+" : ""}${fmt(f.excess_return_pct, 1)}%`}
                          </td>
```

  and bump every hard-coded colSpan in this table (`colSpan={5}` on the
  no-winner cell, `colSpan={7}` on the drill-in row, the errored-row dash
  cells) by one.
- Scorecard `stats` array gains two entries after "Folds profitable":

```ts
    { label: "Median excess", value: rb.median_fold_excess_pct == null ? "–" : `${fmt(rb.median_fold_excess_pct, 1)}%`,
      tip: "Median across folds of the fold's return minus the null baseline's return. Positive means the signal typically beat no-signal.",
      tone: rb.median_fold_excess_pct != null ? (rb.median_fold_excess_pct > 0 ? " pos" : rb.median_fold_excess_pct < 0 ? " neg" : "") : "" },
    { label: "Folds > null", value: fmtPct01(rb.pct_folds_beating_null),
      tip: "Share of folds whose return beat the null baseline (1==1 entries, same risk settings) on the same test window." },
```

- [ ] **Step 4: Run the suite + typecheck**

Run: `cd frontend && npx vitest run src/WfoResults.test.tsx && npx tsc --noEmit`
Expected: all pass, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/WfoResults.tsx frontend/src/WfoResults.test.tsx
git commit -m "feat(wfo): excess-over-baseline column and scorecard tiles"
```

---

### Task 8: Backtest overview Baselines section

**Files:**
- Modify: `frontend/src/BacktestPanel.tsx` (overview tab, after the
  `metricGroups(result).map(...)` sections, line ~336)
- Modify: `frontend/src/backtest.css` or the stylesheet the panel's classes
  live in (locate with `grep -rn "bt-panel-group-title" frontend/src`)
- Test: `frontend/src/BacktestPanel.test.tsx` (append; if the file does not
  exist, create it mirroring another panel test's render setup)

**Interfaces:**
- Consumes: Task 6's `BacktestResult.baselines`.
- Produces: user-visible section; nothing downstream.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders the Baselines section when the result carries baselines", () => {
  renderPanel(resultWith({ baselines: {
    null: { net_pnl: 11966.73, return_pct: 398.89, sharpe: 1.06, max_drawdown_pct: -60.97 },
    hold: { net_pnl: 9000.0, return_pct: 300.0, sharpe: 0.9, max_drawdown_pct: -55.0 },
  }}));
  expect(screen.getByText("Baselines")).toBeTruthy();
  expect(screen.getByText("Null signal")).toBeTruthy();
  expect(screen.getByText("Buy & hold")).toBeTruthy();
});

it("hides the Baselines section when absent", () => {
  renderPanel(resultWith({ baselines: null }));
  expect(screen.queryByText("Baselines")).toBeNull();
});
```

(`renderPanel` / `resultWith` stand for the panel test file's existing
helpers; if creating the file, build a minimal `BacktestResult` fixture the
way `WfoResults.test.tsx` builds its run state.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/BacktestPanel.test.tsx`
Expected: FAIL ("Baselines" not found).

- [ ] **Step 3: Implement**

In the overview tab, after the metric-group sections and before the
cost-sensitivity block:

```tsx
            {result.baselines && (result.baselines.null || result.baselines.hold) && (
              <section className="bt-panel-group">
                <h4 className="bt-panel-group-title">
                  Baselines
                  <InfoTip title="Baselines" text={[
                    "Companion runs of the same window with no entry signal.",
                    "Null signal: entries replaced by 1==1; stops, sizing, sessions, and costs unchanged. The strategy's edge over it is what the signal adds.",
                    "Buy & hold: one position held for the whole window, no stops and no session windows, same costs.",
                  ]} />
                </h4>
                <table className="bt-baselines">
                  <thead>
                    <tr><th></th><th>Net P/L</th><th>Return %</th><th>Sharpe</th><th>Max DD</th><th>Δ Net vs strategy</th></tr>
                  </thead>
                  <tbody>
                    {([["Null signal", result.baselines.null], ["Buy & hold", result.baselines.hold]] as const)
                      .filter(([, m]) => m != null)
                      .map(([label, m]) => {
                        const delta = result.metrics.net_pnl != null && m!.net_pnl != null
                          ? result.metrics.net_pnl - m!.net_pnl : null;
                        return (
                          <tr key={label}>
                            <td>{label}</td>
                            <td>{m!.net_pnl == null ? "–" : m!.net_pnl.toFixed(2)}</td>
                            <td>{m!.return_pct == null ? "–" : `${m!.return_pct.toFixed(2)}%`}</td>
                            <td>{m!.sharpe == null ? "–" : m!.sharpe.toFixed(2)}</td>
                            <td>{m!.max_drawdown_pct == null ? "–" : `${m!.max_drawdown_pct.toFixed(1)}%`}</td>
                            <td className={delta == null ? "" : delta >= 0 ? "pos" : "neg"}>
                              {delta == null ? "–" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </section>
            )}
```

Adjust the metrics access to the panel's actual result shape (`result.metrics`
vs a summary object: match how the existing overview rows read Sharpe). Style
`.bt-baselines` in the panel's stylesheet: same font/size as the existing
`bt-panel-grid` stats, right-aligned numeric cells, hairline row borders,
`font-variant-numeric: tabular-nums`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/BacktestPanel.test.tsx && npx tsc --noEmit`
Expected: pass, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestPanel.tsx frontend/src/BacktestPanel.test.tsx <stylesheet>
git commit -m "feat(baselines): overview Baselines section with strategy deltas"
```

---

### Task 9: Full verification

**Files:** none new.

- [ ] **Step 1: Backend full suite**

Run: `cd backend && python -m pytest -q`
Expected: green (or only failures already present on main before this work;
verify by `git stash && python -m pytest -q` if unsure, then unstash).

- [ ] **Step 2: Frontend suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: only the 5-7 known main-branch failures; every touched file green.

- [ ] **Step 3: Manual smoke in the app**

With the dev servers running: run a plain expr backtest (Baselines section
appears; Null ≈ the user's manual 1==1 result on the same config), then a
small WFO (Excess % column populated; scorecard shows Median excess and
Folds > null; reopen an OLD archived run: new column and tiles show "–").

- [ ] **Step 4: Commit any stragglers and report**

Report: suites' pass counts, the manual-smoke observations, and any deviations
from this plan.
