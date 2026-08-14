"""Cooperative cancel for single blocking backtests, keyed by progressId.

POST /api/backtest/cancel/{progress_id} flips a cancelled flag on the live
progress entry; the run's on_progress callback observes it and aborts with a
499. Conventions mirror test_api_backtest_progress.py (direct handler awaits
via asyncio.run, spies on the progress registry).
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import auto_trader.strategy.loader as loader
from auto_trader.api import expr_exec
from auto_trader.api.routers import backtest as bt
from auto_trader.api.routers import expr as expr_router
from auto_trader.api.schemas import BacktestRequest, ExprBacktestRequest
from auto_trader.core import progress as pr

STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.2, reason="in")]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''


def make_candles(n=60):
    t0 = 1_700_000_000
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({
            "time": t0 + i * 3600, "open": px, "high": px + 1,
            "low": px - 1, "close": px + 0.3, "volume": 10,
        })
    return out


def base_request(strategy: str, candles, **extra) -> BacktestRequest:
    return BacktestRequest(**{
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": strategy,
        **extra,
    })


@pytest.fixture(autouse=True)
def _drop_stray_entries():
    yield
    for pid in ("live", "gone", "cancel-test", "expr-cancel", "expr-baseline-cancel",
                "expr-reg"):
        pr.clear_progress(pid)


def expr_request(**extra) -> ExprBacktestRequest:
    candles = [{"time": 3600 * k, "open": c, "high": c, "low": c,
                "close": c, "volume": 100.0}
               for k, c in enumerate([1, 2, 3, 2, 1] * 12)]
    return ExprBacktestRequest(**{
        "epic": "TEST", "resolution": "HOUR", "candles": candles,
        "htfCandles": None,
        "longEntry": [{"expr": "crossAbove(candle.close, 2)"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": True,
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None, "inspect": False,
        **extra,
    })


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


# --- registry-level behavior -------------------------------------------------


def test_request_cancel_flags_live_entry_only():
    pr.set_progress("live", stage="simulate")
    assert pr.request_cancel("live") is True
    assert pr.is_cancelled("live") is True
    assert pr.request_cancel("gone") is False
    assert pr.is_cancelled("gone") is False


def test_cancel_survives_stage_reset():
    """Handlers re-register the entry on stage changes (simulate -> exit-times
    -> cost-sensitivity); a cancel must not be lost across that."""
    pr.set_progress("live", stage="simulate")
    pr.request_cancel("live")
    pr.set_progress("live", stage="cost-sensitivity")
    assert pr.is_cancelled("live") is True


# --- cancel route ------------------------------------------------------------


def test_cancel_route_flags_live_run_and_404s_when_absent():
    pr.set_progress("live", stage="simulate")
    out = asyncio.run(bt.cancel_backtest("live"))
    assert out == {"ok": True}
    assert pr.is_cancelled("live") is True

    with pytest.raises(HTTPException) as e:
        asyncio.run(bt.cancel_backtest("gone"))
    assert e.value.status_code == 404


# --- end-to-end: cancel observed mid-run aborts with 499 ---------------------


def test_backtest_cancel_mid_run_aborts_with_499_and_clears(strategies, monkeypatch):
    req = base_request("test.py", make_candles(), progressId="cancel-test")

    real_update = pr.update_progress

    def cancelling_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        pr.request_cancel(pid)  # cancel lands after the first progress beat

    monkeypatch.setattr(pr, "update_progress", cancelling_update)
    with pytest.raises(HTTPException) as e:
        asyncio.run(bt.backtest(req))
    assert e.value.status_code == 499
    assert pr.get_progress("cancel-test") is None  # cleared in finally


def test_expr_backtest_cancel_mid_run_aborts_with_499(monkeypatch):
    req = expr_request(progressId="expr-cancel")

    real_update = pr.update_progress

    def cancelling_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        pr.request_cancel(pid)

    monkeypatch.setattr(pr, "update_progress", cancelling_update)
    with pytest.raises(HTTPException) as e:
        asyncio.run(expr_router.expr_backtest(req))
    assert e.value.status_code == 499
    assert pr.get_progress("expr-cancel") is None


def test_expr_baseline_passes_observe_cancel(monkeypatch):
    """A cancel landing after the main pass must stop the baseline companion
    runs (which used to run progress-free and swallow every exception) — not
    report success while the server grinds through two more engine passes."""
    req = expr_request(progressId="expr-baseline-cancel", baselines=["null", "hold"])

    real_update = pr.update_progress

    def cancelling_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        if done == total:  # cancel lands as the MAIN pass finishes
            pr.request_cancel(pid)

    monkeypatch.setattr(pr, "update_progress", cancelling_update)
    with pytest.raises(HTTPException) as e:
        asyncio.run(expr_router.expr_backtest(req))
    assert e.value.status_code == 499
    assert pr.get_progress("expr-baseline-cancel") is None


def test_expr_progress_registered_before_htf_prefetch(monkeypatch):
    """The progress entry must exist before _ensure_htf's broker fetch — that
    await is the one place the handler suspends for seconds, and a cancel
    arriving then must find an entry to flag instead of 404ing into the void."""
    req = expr_request(progressId="expr-reg")
    seen: list[bool] = []
    # The compile-and-run pipeline (and its _ensure_htf call site) lives in
    # expr_exec, so the patch must land there, not on the router module.
    real_ensure = expr_exec._ensure_htf

    async def spying_ensure(nodes, r, htf, instances):
        seen.append(pr.get_progress("expr-reg") is not None)
        return await real_ensure(nodes, r, htf, instances)

    monkeypatch.setattr(expr_exec, "_ensure_htf", spying_ensure)
    asyncio.run(expr_router.expr_backtest(req))
    assert seen == [True]
