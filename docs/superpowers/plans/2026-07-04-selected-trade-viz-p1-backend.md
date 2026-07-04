# Selected-trade viz — Phase 1 (backend stop/target levels) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface each backtest trade's stop (initial + final) and take-profit levels so the chart can draw a selected trade's risk/reward zones. Pass-through data; no behavior change.

**Architecture:** `Position` records the seeded stop as `stop_initial` at open; `_reduce` stamps `stop_initial`, the position's current `stop` (→ `stop_final`), and `target` onto the booked `Trade`. Exposed on `TradeDTO` and the frontend `Trade` type.

**Tech Stack:** Python 3, dataclasses, FastAPI/Pydantic, pytest; TypeScript (types).

## Global Constraints

- **No behavior change.** Existing backtest suites pass unchanged; the new fields are pass-through, default `None`.
- Levels are absolute prices, `None` when that side has no stop/target. `stop_final == stop_initial` when the stop never moved; they differ after trailing / break-even.
- Use `.venv/bin/python -m pytest`; frontend `npx tsc -b`.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

### Task 1: engine + model — record & stamp the levels

**Files:**
- Modify: `backend/auto_trader/core/models.py` (Trade), `backend/auto_trader/engine/backtest.py` (Position, `_open`, `_reduce`)
- Test: `backend/tests/test_backtest_stops.py`

**Interfaces:**
- Produces: `Trade.stop_initial`/`stop_final`/`target` (all `float | None = None`); `Position.stop_initial: float | None = None`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_backtest_stops.py`)

```python
def test_trade_carries_initial_stop_and_target():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry bar2 open=100; stop 98 (2%), target 104 (4%); bar2 low 97 -> stop hits.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
        _c(t0, 3, 99, 99, 99, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("pct", value=4.0))
    res = _run(candles, long_risk=risk)
    tr = res.trades[0]
    assert tr.stop_initial == 98.0
    assert tr.stop_final == 98.0    # never trailed
    assert tr.target == 104.0


def test_trailing_makes_stop_final_differ_from_initial():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # reuse the trail scenario: entry 100, trail 10%, extreme->120, exit at 108.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 120, 99, 118),
        _c(t0, 3, 118, 119, 105, 106),
    ]
    risk = RiskConfig(StopSpec("trailPct", value=10.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    tr = res.trades[0]
    assert tr.stop_initial == 90.0   # seed 100*(1-0.10)
    assert tr.stop_final == 108.0    # trailed to 120*0.90
    assert tr.target is None


def test_no_risk_trade_has_null_levels():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # BuyOnBar1 opens at bar2; a rule exit isn't wired here, so it holds to the end
    # and is settled — but to book a trade, use a SELL rule via the multi helper is
    # overkill; instead assert on an intrabar-closed no-risk position is impossible
    # (no risk => no intrabar close). Simplest: a stop-only config leaves target None
    # and a no-target trade still carries stop levels; the pure-null case is covered
    # by the DTO default. Assert the stop-only trade has target None:
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].target is None
    assert res.trades[0].stop_initial == 98.0
```

- [ ] **Step 2: Run to verify they fail** — `cd backend && .venv/bin/python -m pytest tests/test_backtest_stops.py -q -k "carries or trailing_makes or null_levels"` → FAIL (AttributeError: no `stop_initial`).

- [ ] **Step 3: Add the fields + wiring**

In `core/models.py`, add to the `Trade` dataclass (after `reason_out`):
```python
    stop_initial: float | None = None
    stop_final: float | None = None
    target: float | None = None
```

In `engine/backtest.py`, add to the `Position` dataclass (after `stop`/`target`, near `breakeven_armed`):
```python
    stop_initial: float | None = None
```

In `_open`, right after seeding `p.stop` / `p.target` (inside `if risk:`), record the initial stop:
```python
            p.stop_initial = p.stop
```

In `_reduce`, extend the `Trade(...)` construction with the three levels (the position `p` is in scope):
```python
                leg=side, reason_in=p.open_reason, reason_out=reason,
                stop_initial=p.stop_initial, stop_final=p.stop, target=p.target,
```

- [ ] **Step 4: Run the new tests + full suite** — `cd backend && .venv/bin/python -m pytest tests/test_backtest_stops.py -q` then `.venv/bin/python -m pytest -q` → all pass (existing unchanged).

- [ ] **Step 5: Commit**
```bash
git add backend/auto_trader/core/models.py backend/auto_trader/engine/backtest.py backend/tests/test_backtest_stops.py
git commit -m "feat(backtest): record initial/final stop + target levels on each trade"  # + trailers
```

---

### Task 2: expose the levels on the API

**Files:**
- Modify: `backend/auto_trader/api/app.py`
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Produces: `TradeDTO.stop_initial`/`stop_final`/`target` (`float | None = None`); handler fills them.

- [ ] **Step 1: Write the failing test** (add to `test_api_backtest.py`, reuse `_min_body`)

```python
def test_trade_dto_carries_stop_target_levels():
    body = _min_body()
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "pct", "value": 4}}
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 101, "low": 97, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    t = r.json()["trades"][0]
    assert t["stop_initial"] == 98.0 and t["target"] == 104.0
    assert "stop_final" in t
```

- [ ] **Step 2: Run to verify it fails** — `... -k stop_target_levels` → FAIL (keys absent).

- [ ] **Step 3: Add the DTO fields + wiring**

In `app.py`, add to `TradeDTO` (after `reason`):
```python
    stop_initial: float | None = None
    stop_final: float | None = None
    target: float | None = None
```
In the handler where each `TradeDTO(...)` is built (it already sets `reason=t.reason_out`), add:
```python
                stop_initial=t.stop_initial,
                stop_final=t.stop_final,
                target=t.target,
```

- [ ] **Step 4: Run tests** — `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -q` then full suite → pass.

- [ ] **Step 5: Commit**
```bash
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): expose trade stop/target levels on the API"  # + trailers
```

---

### Task 3: frontend types

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Add fields** to the `Trade` interface (after `reason`):
```ts
  stop_initial: number | null;
  stop_final: number | null;
  target: number | null;
```

- [ ] **Step 2: Type-check** — `cd frontend && npx tsc -b` → no new errors (existing consumers read other Trade fields, unaffected).

- [ ] **Step 3: Commit**
```bash
git add frontend/src/api.ts
git commit -m "feat(backtest): trade stop/target levels on the result type"  # + trailers
```

---

## Self-Review

**Spec coverage:** Phase 1 of the spec — `stop_initial`/`stop_final`/`target` recorded on the position and stamped onto each trade, exposed on the DTO and frontend type, with tests for the trailed-differs and stop-only cases. Phase 2 (the zone overlay + sticky selection) is a separate plan.

**Placeholder scan:** none — exact fields and edits given. (The third Task-1 test's comment explains why a pure all-null booked trade isn't easily constructed here and asserts the stop-only case instead.)

**Type consistency:** `Trade.stop_initial/stop_final/target` (model) ↔ `TradeDTO` fields ↔ `api.ts` `Trade` fields — same three names, `float|None`/`number|null`. `Position.stop_initial` set in `_open`, read in `_reduce`.
