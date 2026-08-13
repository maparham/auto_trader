# Baselines for Coded Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coded (Built-in) single backtests get the same Null + Hold baselines and overview Baselines section as expression runs, via a structured-to-expr request converter that reuses the entire existing baseline pipeline.

**Architecture:** The expr route's `_compiled_run` helper moves verbatim to a shared module (`api/expr_exec.py`) so the structured router can use it without a circular import. A pure converter (`expr_request_from_structured`) builds an `ExprBacktestRequest` from a structured `BacktestRequest`'s panel-level fields (exits-as-expressions, risk, mask, costs, indicators); the existing `null_request`/`hold_request` synthesizers and response embedding then work unchanged. Frontend: the coded branch sends `baselines` for single runs, and the overview InfoTip gains one coded-only sentence.

**Tech Stack:** FastAPI + Pydantic v2, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-coded-baselines-design.md`

## Global Constraints

- Coded **plain backtests only**. Coded WFO stays out; structured WFO keeps accepting-and-ignoring `baselines`. Rules-mode structured requests (no `codedStrategy`) also ignore the field.
- Baseline failures never fail the request: log with `exc_info=True`, leave that kind `None` (same contract as the expr route).
- Response shape unchanged: `BacktestResponse.baselines` already exists (`{"null": blob|None, "hold": blob|None} | None`); blobs are compute_metrics MERGED with summary() (they have `net_pnl`).
- End-user copy: no em dashes (colons/parentheses instead); no tooltip line opening with "How"/"Which".
- Frontend typecheck command is `npx tsc -p tsconfig.app.json --noEmit` (bare `--noEmit` is a no-op); ~10 pre-existing errors in ToolbarControls.tsx, RulePalette.tsx, BacktestSettingsModal.tsx, useLiveMarketData.ts and test files are tolerated; zero NEW errors.
- Frontend main-branch test baseline has 4 known failures in `ComputeHostButton.test.tsx`; never touch or "fix" them.
- Backend tests run from `backend/`: `python -m pytest tests/<file> -q`. Frontend from `frontend/`: `npx vitest run <file>`.
- Commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01NHedkKHW2TqVWFyimKgTaE`

---

### Task 1: Move `_compiled_run` to a shared module

**Files:**
- Create: `backend/auto_trader/api/expr_exec.py`
- Modify: `backend/auto_trader/api/routers/expr.py`

**Interfaces:**
- Consumes: the existing `_compiled_run` local helper inside `expr_backtest` (`backend/auto_trader/api/routers/expr.py`, defined in the route body; it parses rule groups, compiles rows, builds `ExprRuleStrategy` + `BacktestEngine`, runs, and returns `(BacktestResult, metrics_blob)` where the blob is `compute_metrics(...) | result.summary()`).
- Produces: `async def compiled_run(r: ExprBacktestRequest, *, on_progress=None) -> tuple[BacktestResult, dict]` in `expr_exec.py` — the exact same body, renamed and importable. Task 3 imports it from the structured router.

This is a MOVE, not a copy: after the move, `expr.py` must contain no compile-and-run pipeline of its own.

- [ ] **Step 1: Read the current helper**

Open `backend/auto_trader/api/routers/expr.py` and locate the `_compiled_run` helper inside `expr_backtest` (added by the baseline-comparison branch; the route body around it is only the empty-candles 422, one `await _compiled_run(req)`, the `_result_to_response` call, and the baselines block). Note every symbol the helper's body uses (candle_from_dto, build_atr_risk_series, first_tradeable_index, AtrWarmupError, _parse_group, _ensure_htf, request_instances, compile_row, ExprRuleStrategy, BacktestEngine, compute_metrics, resolution_seconds, progress-registration helpers). `_parse_group` and `_ensure_htf` are module-level in expr.py: they move too if only the helper uses them, or stay and be imported by expr_exec if the route still needs them — inspect and pick the option that leaves each function defined in exactly one place.

- [ ] **Step 2: Create `expr_exec.py` and move the code**

```python
# backend/auto_trader/api/expr_exec.py
"""Shared expression compile-and-run pipeline. One implementation serves the
expr route's main run and every baseline run (expr and coded routes both):
whatever the main path executes, a baseline executes identically."""
```

Move the helper verbatim as `async def compiled_run(r, *, on_progress=None)`, moving its private dependencies (`_parse_group`, `_ensure_htf`, and any others used only by it) along with it. Keep the progress-registration block inside the helper gated on `r.progressId` exactly as it is now (baseline requests strip `progressId` by construction, so they never register).

- [ ] **Step 3: Rewire `expr.py`**

`from auto_trader.api.expr_exec import compiled_run` and replace the local helper with calls to it. No behavior change.

- [ ] **Step 4: Run the regression net**

Run: `cd backend && python -m pytest tests/test_api_expr.py tests/test_api_expr_baselines.py tests/test_baselines_engine.py -q`
Expected: all pass (these exercise the route's parse-error 422s, ATR warmup 422, baselines, and progress side effects).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/expr_exec.py backend/auto_trader/api/routers/expr.py
git commit -m "refactor(expr): move compiled_run to shared expr_exec module"
```

---

### Task 2: `expr_request_from_structured` converter

**Files:**
- Modify: `backend/auto_trader/api/baselines.py`
- Test: `backend/tests/test_baselines.py` (append)

**Interfaces:**
- Consumes: `BacktestRequest`, `ExprBacktestRequest` from `auto_trader.api.schemas`.
- Produces: `expr_request_from_structured(req: BacktestRequest) -> ExprBacktestRequest`, a pure function; Task 3 composes it with the existing `null_request`/`hold_request`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_baselines.py`:

```python
from auto_trader.api.baselines import expr_request_from_structured
from auto_trader.api.schemas import BacktestRequest


def _structured(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": 3600 * k, "open": 1.0, "high": 1.0, "low": 1.0,
                     "close": 1.0, "volume": 1.0} for k in range(3)],
        "series": {"IGNORED": [1.0, 1.0, 1.0]},
        "exprLongExit": [{"expr": "candle.close < entry"}],
        "exprShortExit": [],
        "exprLongExitCombine": "OR",
        "longEnabled": True, "shortEnabled": False,
        "longRisk": {"stop": {"kind": "pct", "value": 1.0},
                     "target": {"kind": "pct", "value": 1.0}},
        "mask": {"enabled": True, "session": "NYSE"},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0,
        "codedStrategy": "whatever.py",
        "broker": "capital", "priceSide": "bid",
    }
    d.update(over)
    return BacktestRequest.model_validate(d)


def test_converter_maps_panel_fields():
    out = expr_request_from_structured(_structured())
    assert out.longEntry == [] and out.shortEntry == []
    assert [r.expr for r in out.longExit] == ["candle.close < entry"]
    assert out.longExitCombine == "OR"
    assert out.longEnabled is True and out.shortEnabled is False
    assert out.longRisk is not None and out.mask is not None
    assert out.broker == "capital" and out.priceSide == "bid"
    assert out.epic == "TEST" and len(out.candles) == 3
    assert out.sweep is None and out.walkforward is None
    assert out.baselines is None and out.progressId is None


def test_converter_carries_indicator_instances():
    # Exit rows may name chart indicator outputs (SLOPE.14 etc.); their pane
    # settings ride the request's `indicators` dict and must pass through so
    # the expr pipeline can compile the exits.
    req = _structured(
        exprLongExit=[{"expr": "SLOPE.14 < 0"}],
        indicators={"slope1": {"type": "SLOPE", "calcParams": [9, 14, 50]}},
    )
    out = expr_request_from_structured(req)
    assert "slope1" in out.indicators
    # Match the IndicatorInstanceDTO fixture shape to the real schema while
    # implementing; adjust the dict above only on verified mismatch.


def test_converter_does_not_mutate_input():
    req = _structured()
    expr_request_from_structured(req)
    assert req.codedStrategy == "whatever.py"
    assert [r.expr for r in req.exprLongExit] == ["candle.close < entry"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_baselines.py -q`
Expected: FAIL with `ImportError: cannot import name 'expr_request_from_structured'`.

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/baselines.py` (module docstring gains one line saying coded runs convert first, then use the same synthesizers):

```python
def expr_request_from_structured(req: "BacktestRequest") -> ExprBacktestRequest:
    """Panel-level expr equivalent of a structured (coded) request: same
    candles, costs, risk, scaling, mask, sides, brokers, indicators, and the
    panel exit rules; EMPTY entry groups (null/hold synthesizers fill them).
    Logic inside the coded strategy file (on_bar exits, dynamic sizing) is
    not represented: that is exactly the point of the coded null baseline.
    `series` is dropped (the expr pipeline computes its own risk series)."""
    return ExprBacktestRequest(
        epic=req.epic, resolution=req.resolution, candles=req.candles,
        htfCandles=req.htfCandles, broker=req.broker, priceSide=req.priceSide,
        longEntry=[], shortEntry=[],
        longExit=req.exprLongExit, shortExit=req.exprShortExit,
        longExitCombine=req.exprLongExitCombine,
        shortExitCombine=req.exprShortExitCombine,
        longEnabled=req.longEnabled, shortEnabled=req.shortEnabled,
        longRisk=req.longRisk, shortRisk=req.shortRisk,
        longScaling=req.longScaling, shortScaling=req.shortScaling,
        costs=req.costs, tradeFromTime=req.tradeFromTime, mask=req.mask,
        indicators=req.indicators,
    )
```

Import `BacktestRequest` under `TYPE_CHECKING` (string annotation) if a
runtime import would be circular; otherwise import normally. Check the exact
field names against `schemas.py` while implementing (notably the exit-combine
field names and whether `BacktestRequest.indicators` exists on this branch);
adjust ONLY on verified mismatch and note it in the report. Entry combine
modes are left at their defaults ("AND"): entry groups hold a single `1==1`
row after synthesis, so combine mode is irrelevant.

- [ ] **Step 4: Run tests to verify green**

Run: `cd backend && python -m pytest tests/test_baselines.py -q`
Expected: all pass (the pre-existing synthesis tests included).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/baselines.py backend/tests/test_baselines.py
git commit -m "feat(baselines): structured-to-expr request converter for coded runs"
```

---

### Task 3: Baselines on the structured route (coded runs)

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (`BacktestRequest`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (the `POST /api/backtest` handler, coded path)
- Test: `backend/tests/test_api_backtest_baselines.py`

**Interfaces:**
- Consumes: Task 1's `compiled_run`, Task 2's converter, existing `null_request`/`hold_request`.
- Produces: `BacktestRequest.baselines: list[Literal["null", "hold"]] | None = None`; coded single-run responses carry the standard `baselines` block.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_backtest_baselines.py`. Read `backend/tests/test_api_backtest_coded.py` FIRST and mirror its client setup, its tiny coded-strategy fixture (a `strategies_dir` temp dir or monkeypatch — copy the file's exact mechanism), and its minimal structured request builder. Then the tests, with the file's fixture names substituted:

```python
def test_coded_baselines_absent_by_default(coded_client):
    r = coded_client.post("/api/backtest", json=_coded_req())
    assert r.status_code == 200
    assert r.json()["baselines"] is None


def test_coded_baselines_null_and_hold(coded_client):
    r = coded_client.post("/api/backtest",
                          json=_coded_req(baselines=["null", "hold"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    for kind in ("null", "hold"):
        assert b[kind] is not None
        assert "net_pnl" in b[kind] and "return_pct" in b[kind]


def test_coded_baselines_diverge_under_panel_risk(coded_client):
    # 1% stop/target on a steady rise: null re-enters, hold takes one trade.
    r = coded_client.post("/api/backtest", json=_coded_req(
        baselines=["null", "hold"],
        longRisk={"stop": {"kind": "pct", "value": 1.0},
                  "target": {"kind": "pct", "value": 1.0}},
        candles=_rising_candles(30),
    ))
    b = r.json()["baselines"]
    assert b["hold"]["n_trades"] == 1
    assert b["null"]["n_trades"] > 1


def test_rules_mode_structured_request_ignores_baselines(coded_client):
    # No codedStrategy: field accepted, response block stays None.
    r = coded_client.post("/api/backtest",
                          json=_coded_req(codedStrategy=None,
                                          baselines=["null", "hold"]))
    assert r.status_code == 200
    assert r.json()["baselines"] is None
```

The coded fixture strategy must actually trade on the fixture candles (the
existing coded route test's strategy/candles pair already does; reuse both).
`_rising_candles(30)` = closes 100..129, same shape as the file's candle
builder.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_api_backtest_baselines.py -q`
Expected: FAIL (422 unknown field or KeyError, depending on model strictness).

- [ ] **Step 3: Schema field**

On `BacktestRequest` in `backend/auto_trader/api/schemas.py` (next to `progressId`, mirroring the ExprBacktestRequest comment):

```python
    # Baseline companion runs (coded single runs only on this route): "null" =
    # 1==1 entries + the PANEL's exits/risk (code-internal logic not
    # mirrored); "hold" = enter-and-hold. Rules-mode requests and
    # sweep/walkforward jobs ignore the field.
    baselines: list[Literal["null", "hold"]] | None = None
```

- [ ] **Step 4: Route wiring**

In the `POST /api/backtest` handler in `backend/auto_trader/api/routers/backtest.py`: locate where the coded path (`req.codedStrategy` set) has built its `BacktestResponse` (the `_result_to_response(...)` result). Add, coded-path only:

```python
    baselines_out = None
    if req.baselines and req.codedStrategy:
        from auto_trader.api.baselines import (
            expr_request_from_structured, hold_request, null_request)
        from auto_trader.api.expr_exec import compiled_run
        base_expr = expr_request_from_structured(req)
        synth = {"null": null_request, "hold": hold_request}
        baselines_out = {"null": None, "hold": None}
        for kind in req.baselines:
            try:
                _res, blob = await compiled_run(synth[kind](base_expr))
                baselines_out[kind] = blob
            except Exception:  # noqa: BLE001  a baseline never fails the run
                log.warning("coded baseline run %r failed", kind, exc_info=True)
    response.baselines = baselines_out
```

Use the module's existing logger if one exists (grep for `logging.getLogger`
in the file; create `log = logging.getLogger(__name__)` if absent). If the
handler `return`s `_result_to_response(...)` directly, bind to `response`
first. The rules-mode structured path sets nothing (field ignored per spec).

- [ ] **Step 5: Run the new tests plus the coded route regression**

Run: `cd backend && python -m pytest tests/test_api_backtest_baselines.py tests/test_api_backtest_coded.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_baselines.py
git commit -m "feat(baselines): null/hold companion runs for coded single backtests"
```

---

### Task 4: Frontend: coded branch sends baselines; coded-only tooltip line

**Files:**
- Modify: `frontend/src/api.ts` (structured `BacktestRequest` interface)
- Modify: `frontend/src/BacktestButton.tsx` (coded single-run request)
- Modify: `frontend/src/BacktestPanel.tsx` (InfoTip copy + new prop)
- Test: `frontend/src/BacktestPanel.test.tsx` (append)

**Interfaces:**
- Consumes: Task 3's request field; the existing overview Baselines section.
- Produces: coded single runs carry `baselines: ["null","hold"]`; `BacktestPanel` gains an optional `codedRun?: boolean` prop appending one InfoTip line.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/BacktestPanel.test.tsx` (reuse its `renderPanel`/fixture helpers; extend `renderPanel` to forward a `codedRun` prop):

```tsx
it("adds the Built-in caveat line to the Baselines tip for coded runs", () => {
  renderPanel(resultWith({ baselines: BOTH_BASELINES }), { codedRun: true });
  fireEvent.mouseEnter(screen.getByLabelText(/about baselines/i));
  expect(screen.getByText(/logic inside the strategy file is not mirrored/i)).toBeTruthy();
});

it("omits the Built-in caveat for expression runs", () => {
  renderPanel(resultWith({ baselines: BOTH_BASELINES }));
  fireEvent.mouseEnter(screen.getByLabelText(/about baselines/i));
  expect(screen.queryByText(/logic inside the strategy file/i)).toBeNull();
});
```

`BOTH_BASELINES` = the file's existing two-blob fixture. If the InfoTip
trigger's accessible name differs, query it the way the file's existing
tooltip tests do (read them first); if no tooltip-hover test pattern exists
in the file, assert on the tip's text array via the InfoTip's rendered
trigger + the shared Tooltip's shown content, following
`WfoResults.test.tsx`'s established pattern.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/BacktestPanel.test.tsx`
Expected: new tests FAIL (prop/caveat line absent).

- [ ] **Step 3: Implement**

- `api.ts`: add `baselines?: ("null" | "hold")[] | null;` to the structured `BacktestRequest` interface (the expr interface already has it; reuse the `BaselineKind` type and `BASELINE_KINDS` const).
- `BacktestButton.tsx`: in the single-run call, the coded branch currently builds `{ ...baseReq, progressId }`; extend to `{ ...baseReq, progressId, baselines: BASELINE_KINDS }`. Sweep and WFO branches return earlier and stay untouched (verify by reading the control flow, same as the expr gating commit did). Pass `codedRun={coded}` (whatever the branch's existing coded/rules discriminator variable is) through to `BacktestPanel` — follow the props path from BacktestButton's render of the panel; if the panel is rendered elsewhere (e.g. via a signal), route the flag the same way the result gets there, and document the chosen path in the commit body.
- `BacktestPanel.tsx`: `codedRun?: boolean` prop; the Baselines InfoTip `text` array conditionally appends:

```ts
"For Built-in strategies, the null baseline uses the panel's exits and risk; logic inside the strategy file is not mirrored."
```

(No em dashes; doesn't open with "How"/"Which".)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/BacktestPanel.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: all pass; error list unchanged from the pre-existing baseline.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestButton.tsx frontend/src/BacktestPanel.tsx frontend/src/BacktestPanel.test.tsx
git commit -m "feat(baselines): coded runs request baselines; Built-in tooltip caveat"
```

---

### Task 5: Full verification

**Files:** none new.

- [ ] **Step 1: Backend full suite**

Run: `cd backend && python -m pytest -q`
Expected: green (baseline before this work: 1677 passed / 1 skipped).

- [ ] **Step 2: Frontend suite + typecheck**

Run: `cd frontend && npx vitest run` and `npx tsc -p tsconfig.app.json --noEmit`
Expected: only the 4 known `ComputeHostButton.test.tsx` failures; tsc error list unchanged (~10 pre-existing).

- [ ] **Step 3: Manual smoke in the app**

With dev servers running on this checkout: pick a Built-in strategy (e.g. BB Regime Breakout), run a single backtest, and confirm the Baselines section appears with Null and Enter & hold rows plus both delta columns, and that the InfoTip shows the Built-in caveat line. Then run a User Defined backtest and confirm the caveat line is absent and results are unchanged from before this work.

- [ ] **Step 4: Report**

Report suite counts, smoke observations, and any deviations from this plan.
