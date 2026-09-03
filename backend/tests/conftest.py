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


@pytest.fixture(autouse=True)
def _registry_for_routes(monkeypatch):
    """Broker-carrying routes resolve the request's data broker through
    deps.resolve_broker (admin gate, Task 4), which needs deps._registry.
    Most route tests drive the app via a module-level TestClient(app) and
    never trigger the app's lifespan (which normally builds the registry on
    startup), so give every test a real, credential-free registry unless one
    is already set (e.g. a test's own `with TestClient(app) as c:` already
    ran lifespan, or a fixture — like test_api_admin_gate's — installs its
    own fake registry after startup).

    Deliberately does NOT call build_registry(): that reads broker credentials
    from ambient env/.env (pydantic settings with env_file=".env"), so on a
    machine with real CAPITAL_/IG_/METAAPI_/OANOR_ creds in backend/.env it
    would construct live credentialed brokers (MetaApi/Capital clients) for
    every single test, hanging/crawling the suite. Register only the
    unconditional free data brokers instead, exactly as build_registry does
    for its credential-free trio, so this fixture is deterministic and
    credential-free regardless of ambient env."""
    from auto_trader.api import deps
    from auto_trader.brokers.registry import BrokerRegistry

    if deps._registry is None:
        from auto_trader.brokers import dukascopy, nobitex, yfinance

        registry = BrokerRegistry()
        dukascopy.register(registry)
        yfinance.register(registry)
        nobitex.register(registry)
        monkeypatch.setattr(deps, "_registry", registry)
