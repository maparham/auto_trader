# Backtest trades panel — Phase A (metrics + trade reason) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute richer backtest performance metrics on the backend and expose the exit `reason` on each trade, so the (later) Overview tab and trades List have their data — with no UI yet.

**Architecture:** A new pure `engine/metrics.py` computes metrics from the already-produced `trades[]` + `equity[]`. The `/api/backtest` response gains a `metrics` block and a `reason` field on each trade. The frontend `api.ts` types are updated to match. No behaviour change to the engine or existing summary.

**Tech Stack:** Python 3, dataclasses, FastAPI/Pydantic, pytest; TypeScript (types only).

## Global Constraints

- **No engine behaviour change.** The existing backtest suites pass unchanged; `summary()` (net_pnl, n_trades, win_rate, max_drawdown) is untouched and still returned. `metrics` is additive.
- **Metrics are pure** functions of `trades[]` + `equity[]` (+ net_pnl, starting_cash, resolution seconds passed in). No re-running the engine.
- **Definitions (exact):** a winner is `pnl > 0`, a loser is `pnl < 0` (breakeven `pnl == 0` counts as neither for profit/loss aggregates). The existing `win_rate` keeps its own commission-aware definition (`pnl > 2*commission`) — do NOT recompute it here. Every metric is defined for the **empty-trades** case with no divide-by-zero.
- Use `.venv/bin/python -m pytest`; frontend `npx tsc -b`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

## File Structure

- Create `backend/auto_trader/engine/metrics.py` — `compute_metrics(...)` pure.
- Modify `backend/auto_trader/api/app.py` — `metrics` on `BacktestResponse`, `reason` on `TradeDTO`, wire both in the handler.
- Modify `frontend/src/api.ts` — `reason` on the `Trade` type, `metrics` on `BacktestResult`.
- Tests: `backend/tests/test_metrics.py`; extend `backend/tests/test_api_backtest.py`.

---

### Task 1: `engine/metrics.py` (pure)

**Files:**
- Create: `backend/auto_trader/engine/metrics.py`
- Test: `backend/tests/test_metrics.py`

**Interfaces:**
- Produces: `compute_metrics(trades: list[Trade], equity: list[EquityPoint], net_pnl: float, starting_cash: float, res_seconds: int) -> dict`. Keys (all floats unless noted; `None` where undefined): `return_pct`, `profit_factor` (None if no losers), `expectancy`, `avg_win`, `avg_loss`, `avg_win_loss_ratio` (None if no losers), `largest_win`, `largest_loss`, `max_drawdown_pct`, `avg_duration_bars`, `max_consec_wins` (int), `max_consec_losses` (int).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_metrics.py
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Side, Trade
from auto_trader.engine.backtest import EquityPoint
from auto_trader.engine.metrics import compute_metrics

T0 = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _trade(pnl, i=0, dur_min=5):
    entry = T0 + timedelta(minutes=i)
    return Trade(
        side=Side.BUY, quantity=1.0, entry_time=entry, entry_price=100.0,
        exit_time=entry + timedelta(minutes=dur_min), exit_price=100.0 + pnl,
        pnl=pnl, leg="long", reason_in="in", reason_out="out",
    )


def test_basic_metrics_hand_computed():
    # pnls: +10, -4, +6, -2  -> gross win 16, gross loss 6
    trades = [_trade(10, 0), _trade(-4, 1), _trade(6, 2), _trade(-2, 3)]
    eq = [EquityPoint(T0, 10_000), EquityPoint(T0 + timedelta(minutes=1), 10_010)]
    m = compute_metrics(trades, eq, net_pnl=10.0, starting_cash=10_000.0, res_seconds=300)
    assert m["profit_factor"] == 16 / 6
    assert m["expectancy"] == (10 - 4 + 6 - 2) / 4
    assert m["avg_win"] == 8.0        # (10+6)/2
    assert m["avg_loss"] == -3.0      # (-4-2)/2
    assert m["avg_win_loss_ratio"] == 8.0 / 3.0
    assert m["largest_win"] == 10.0
    assert m["largest_loss"] == -4.0
    assert m["return_pct"] == 10.0 / 10_000 * 100
    assert m["avg_duration_bars"] == 1.0   # 5 min / 300s = 1 bar


def test_consecutive_streaks():
    # W W L W L L L W  -> max wins 2, max losses 3
    pnls = [1, 1, -1, 1, -1, -1, -1, 1]
    trades = [_trade(p, i) for i, p in enumerate(pnls)]
    m = compute_metrics(trades, [], net_pnl=0.0, starting_cash=1000.0, res_seconds=60)
    assert m["max_consec_wins"] == 2
    assert m["max_consec_losses"] == 3


def test_drawdown_pct_from_equity():
    # peak 10_000 -> trough 9_500 => 5% drawdown
    eq = [
        EquityPoint(T0, 10_000),
        EquityPoint(T0 + timedelta(minutes=1), 9_500),
        EquityPoint(T0 + timedelta(minutes=2), 9_800),
    ]
    m = compute_metrics([], eq, net_pnl=-200.0, starting_cash=10_000.0, res_seconds=60)
    assert m["max_drawdown_pct"] == 5.0


def test_no_losers_profit_factor_none():
    trades = [_trade(5, 0), _trade(3, 1)]
    m = compute_metrics(trades, [], net_pnl=8.0, starting_cash=1000.0, res_seconds=60)
    assert m["profit_factor"] is None
    assert m["avg_win_loss_ratio"] is None
    assert m["avg_loss"] == 0.0


def test_empty_trades_no_divide_by_zero():
    m = compute_metrics([], [], net_pnl=0.0, starting_cash=10_000.0, res_seconds=60)
    assert m["expectancy"] == 0.0
    assert m["avg_win"] == 0.0 and m["avg_loss"] == 0.0
    assert m["profit_factor"] is None
    assert m["max_consec_wins"] == 0 and m["max_consec_losses"] == 0
    assert m["avg_duration_bars"] == 0.0
    assert m["max_drawdown_pct"] == 0.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_metrics.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the module**

```python
# backend/auto_trader/engine/metrics.py
"""Pure backtest performance metrics, derived from the round-trip trades and the
equity curve the engine already produced. No engine re-run; no indicator math.

Winner = pnl > 0, loser = pnl < 0 (breakeven counts as neither). The engine's
commission-aware `win_rate` is separate and not recomputed here."""

from __future__ import annotations

from collections.abc import Sequence


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def compute_metrics(trades, equity, net_pnl, starting_cash, res_seconds) -> dict:
    pnls = [t.pnl for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]

    gross_loss = -sum(losses)  # positive magnitude, 0.0 when no losers
    profit_factor = (sum(wins) / gross_loss) if gross_loss > 0 else None

    avg_win = _mean(wins)
    avg_loss = _mean(losses)  # <= 0
    avg_win_loss_ratio = (avg_win / -avg_loss) if avg_loss < 0 else None

    # Max consecutive winners / losers over the trade sequence.
    max_w = max_l = cur_w = cur_l = 0
    for p in pnls:
        if p > 0:
            cur_w += 1; cur_l = 0
        elif p < 0:
            cur_l += 1; cur_w = 0
        else:
            cur_w = cur_l = 0
        max_w = max(max_w, cur_w)
        max_l = max(max_l, cur_l)

    # Max drawdown as a percent of the running peak (peak seeded at starting cash).
    peak = starting_cash
    max_dd_pct = 0.0
    for pt in equity:
        peak = max(peak, pt.equity)
        if peak > 0:
            max_dd_pct = max(max_dd_pct, (peak - pt.equity) / peak * 100.0)

    durations = [
        (t.exit_time - t.entry_time).total_seconds() / res_seconds for t in trades
    ] if res_seconds else []

    return {
        "return_pct": (net_pnl / starting_cash * 100.0) if starting_cash else 0.0,
        "profit_factor": profit_factor,
        "expectancy": _mean(pnls),
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "avg_win_loss_ratio": avg_win_loss_ratio,
        "largest_win": max(wins) if wins else 0.0,
        "largest_loss": min(losses) if losses else 0.0,
        "max_drawdown_pct": max_dd_pct,
        "avg_duration_bars": _mean(durations),
        "max_consec_wins": max_w,
        "max_consec_losses": max_l,
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_metrics.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/metrics.py backend/tests/test_metrics.py
git commit -m "feat(backtest): pure performance-metrics module"  # + trailers
```

---

### Task 2: expose `reason` + `metrics` in the API

**Files:**
- Modify: `backend/auto_trader/api/app.py`
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: `compute_metrics` (Task 1).
- Produces: `TradeDTO.reason: str`; `BacktestResponse.metrics: dict`; the handler fills both.

- [ ] **Step 1: Write the failing test**

```python
# add to backend/tests/test_api_backtest.py (reuse _min_body; add a rule that trades)
def test_response_has_metrics_and_trade_reason():
    body = _min_body()
    # a trivial always-open then stop so at least one trade closes with a reason
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}}
    # give it a down-bar so the stop triggers and books a trade
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 100, "low": 98, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    data = r.json()
    assert "metrics" in data
    assert "profit_factor" in data["metrics"] and "max_consec_losses" in data["metrics"]
    assert data["trades"], "expected at least one closed trade"
    assert "reason" in data["trades"][0]  # e.g. "stop"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -q -k metrics_and_trade_reason`
Expected: FAIL — `metrics`/`reason` absent.

- [ ] **Step 3: Add `reason` to `TradeDTO`, `metrics` to the response, wire the handler**

In `backend/auto_trader/api/app.py`:

Add the import:
```python
from auto_trader.engine.metrics import compute_metrics
```

Add `reason` to `TradeDTO` (find the class; it has side/quantity/entry_time/entry_price/exit_time/exit_price/pnl/leg):
```python
    reason: str = ""
```

Add `metrics` to `BacktestResponse` (find the response model that has `summary`):
```python
    metrics: dict = {}
```

In the `/api/backtest` handler, where each `TradeDTO(...)` is built, add `reason=t.reason_out`. And where `BacktestResponse(...)` is returned, add:
```python
        metrics=compute_metrics(
            result.trades, result.equity, result.net_pnl,
            req.costs.startingCash, resolution.seconds,
        ),
```
`resolution` is already resolved in the handler (used elsewhere); if only the raw string is in scope, use `Resolution(req.resolution).seconds`. Confirm the correct in-scope name before writing.

- [ ] **Step 4: Run tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -q`
Expected: PASS (all, incl. new). Then full suite `.venv/bin/python -m pytest -q` stays green.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): expose exit reason + metrics block in the API"  # + trailers
```

---

### Task 3: frontend types

**Files:**
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Produces: `Trade.reason: string`; `BacktestResult.metrics` typed.

- [ ] **Step 1: Update the types**

In `frontend/src/api.ts`, add to the `Trade` interface:
```ts
  reason: string;
```
Add to the `BacktestResult` interface a `metrics` field:
```ts
  metrics: {
    return_pct: number;
    profit_factor: number | null;
    expectancy: number;
    avg_win: number;
    avg_loss: number;
    avg_win_loss_ratio: number | null;
    largest_win: number;
    largest_loss: number;
    max_drawdown_pct: number;
    avg_duration_bars: number;
    max_consec_wins: number;
    max_consec_losses: number;
  };
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: no NEW errors from `api.ts` (the ~20 pre-existing unrelated errors are not yours). Existing `runAndRender`/`BacktestButton` consumers of `BacktestResult` still compile (they read `.summary`, unaffected).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(backtest): trade reason + metrics on the result type"  # + trailers
```

---

## Self-Review

**Spec coverage:** implements the Phase-A slice of the spec — `engine/metrics.py` (the full v1 metric set minus Sharpe/CAGR, which are non-goals), exit `reason` on the Trade DTO, and the `metrics` response block, with frontend types updated. Phases B (panel) and C (chart sync) are out of scope for this plan.

**Placeholder scan:** none — full module, DTO edits, and tests given. The one instruction requiring judgment (which in-scope name resolves the resolution seconds in the handler) is called out explicitly with a fallback (`Resolution(req.resolution).seconds`).

**Type consistency:** the `metrics` dict keys in `compute_metrics` (Task 1) match the `BacktestResult.metrics` TS fields (Task 3) one-for-one. `reason` added to both `TradeDTO` (Task 2) and the TS `Trade` (Task 3). `compute_metrics(trades, equity, net_pnl, starting_cash, res_seconds)` signature matches its call site in Task 2.
