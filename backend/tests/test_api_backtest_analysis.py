"""API integration: backtest response carries MAE/MFE + context + analysis +
run_id; runs land in the store and are readable via the runs endpoints.

Uses a temp run-store db (monkeypatched RUN_STORE on the router module) so tests
never touch the real backtest_runs.db. Handlers are called directly via
asyncio.run(...) — same convention as test_api_backtest.py (this repo has no
pytest-asyncio and API tests don't use TestClient for the async handlers).
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from auto_trader.api import app as app_module
import auto_trader.api.routers.backtest as bt_router
from auto_trader.core.run_store import RunStore


@pytest.fixture()
def tmp_run_store(tmp_path, monkeypatch):
    store = RunStore(str(tmp_path / "runs.db"))
    # Patch the singleton where the router looks it up (imported into its namespace).
    monkeypatch.setattr(bt_router, "RUN_STORE", store)
    return store


def _run(body: dict):
    async def scenario():
        return await app_module.backtest(app_module.BacktestRequest(**body))

    return asyncio.run(scenario())


def _trade_body():
    # Always-open long that gets stopped out -> books at least one closed trade
    # with an initial stop (so mae_r/mfe_r are computable and context attaches).
    candles = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 100, "low": 98, "close": 98, "volume": 0},
    ]
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "EURUSD",
        "resolution": "MINUTE",
        "candles": candles,
        "series": {},
        "longEntry": {"combine": "AND", "rules": [
            {"left": {"kind": "price", "field": "close"}, "op": "gt",
             "right": {"kind": "const", "value": 0}}]},
        "longExit": empty,
        "shortEntry": empty,
        "shortExit": empty,
        "longRisk": {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}},
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": 0,
    }


def test_backtest_response_has_analysis_and_run_id(tmp_run_store):
    result = _run(_trade_body())
    assert result.run_id
    assert result.analysis is not None
    assert result.analysis["n_trades"] == len(result.trades)
    assert result.trades, "expected at least one closed trade"
    for t in result.trades:
        d = t.model_dump()
        assert "mae" in d and "mfe" in d and "mae_r" in d and "context" in d


def test_run_is_persisted_and_readable(tmp_run_store):
    result = _run(_trade_body())
    run_id = result.run_id

    listed = asyncio.run(bt_router.list_runs())
    assert any(r["id"] == run_id for r in listed)
    row = next(r for r in listed if r["id"] == run_id)
    assert "summary" in row and "trades" not in row  # summaries only

    full = asyncio.run(bt_router.get_run(run_id))
    assert full["id"] == run_id
    assert "trades" in full and "request" in full
    assert full["strategy_kind"] == "rules"
    assert full["strategy_name"] is None
    assert full["analysis"]["n_trades"] == len(full["trades"])
    # Re-derivable market data is stripped before the store write; the strategy
    # config (rules/risk/epic/resolution) is kept.
    assert "candles" not in full["request"]
    assert "series" not in full["request"]
    assert "sweep" not in full["request"]
    assert full["request"]["epic"] == "EURUSD"
    assert full["request"]["longEntry"]["rules"]

    with pytest.raises(HTTPException) as e:
        asyncio.run(bt_router.get_run("nope"))
    assert e.value.status_code == 404

    assert asyncio.run(bt_router.delete_run(run_id)) == {"ok": True}
    with pytest.raises(HTTPException) as e2:
        asyncio.run(bt_router.get_run(run_id))
    assert e2.value.status_code == 404


def test_response_and_stored_run_carry_whatif(tmp_run_store):
    result = _run(_trade_body())
    payload = result.model_dump()
    assert "whatif" in payload["analysis"]
    assert set(payload["analysis"]["whatif"].keys()) == {
        "rule_exit", "no_target", "stop_curve", "target_curve",
        "fill_delay", "limit_entry", "breakeven_curve",
    }
    assert payload["trades"], "expected at least one closed trade"
    for t in payload["trades"]:
        assert "whatif" in t

    rec = asyncio.run(bt_router.get_run(payload["run_id"]))
    assert "whatif" in rec["analysis"]
    assert rec["trades"]
    assert all("whatif" in t for t in rec["trades"])


def test_store_failure_does_not_fail_backtest(tmp_run_store, monkeypatch):
    async def boom(rec):
        raise RuntimeError("disk full")

    monkeypatch.setattr(tmp_run_store, "insert", boom)
    result = _run(_trade_body())  # best-effort: response unaffected
    assert result.run_id is None
    assert result.analysis is not None  # analysis is computed before the store write
    assert result.analysis["n_trades"] == len(result.trades)
