"""Pytest fixtures for the test suite."""

from __future__ import annotations

import pytest

from auto_trader.core.run_store import RunStore


@pytest.fixture(autouse=True)
def _isolated_run_store(tmp_path, monkeypatch):
    """Backtest runs persist via a module singleton; point the router at a
    per-test temp store so the suite never writes backend/backtest_runs.db."""
    import auto_trader.api.routers.backtest as bt_router
    monkeypatch.setattr(bt_router, "RUN_STORE", RunStore(str(tmp_path / "runs.db")))
