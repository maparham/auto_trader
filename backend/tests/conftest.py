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
def _isolated_alert_store(tmp_path, monkeypatch):
    """Alerts persist via a module singleton; point BOTH the router AND the
    module singleton itself at a per-test temp store so the suite never
    writes backend/alerts.db. Patching only the router's reference is not
    enough: app.py's lifespan does its own
    `from auto_trader.core.alert_store import ALERT_STORE` and hands that
    (real) singleton to ALERT_ENGINE.configure()/start(), and several tests
    do enter lifespan (test_api_admin_gate.py's `client` fixture, its
    dev-mode tests, test_api_compute_hosted.py, test_coded_strategy_mtf.py)
    — the engine can read AND delete rows (e.g. expiring/firing an alert)
    off whatever store it was configured with."""
    import auto_trader.api.routers.alerts as alerts_router
    import auto_trader.core.alert_store as alert_store_mod
    from auto_trader.core.alert_store import AlertStore

    store = AlertStore(str(tmp_path / "alerts.db"))
    monkeypatch.setattr(alert_store_mod, "ALERT_STORE", store)
    monkeypatch.setattr(alerts_router, "ALERT_STORE", store)


@pytest.fixture(autouse=True)
def _isolated_state_store(tmp_path, monkeypatch):
    """StateStore (the localStorage mirror) persists via a module singleton
    too; point every module that holds a reference to it at a per-test temp
    store so the suite never reads/writes the ambient backend/app_state.db.
    Mirrors the RunStore/AlertStore fixtures above. Three separate patch
    sites, all sharing one instance:
    - `auto_trader.core.state_store.STATE_STORE` itself, since some readers
      (e.g. chart_snapshot._state_store(), api/app.py's lifespan) do
      `from auto_trader.core.state_store import STATE_STORE` freshly inside a
      function body each call, which resolves against this attribute.
    - `auto_trader.core.alert_engine.STATE_STORE`, which binds the name at
      module import time (top-level import), so patching the source module's
      attribute alone would not reach it.
    - `auto_trader.api.routers.state.STATE_STORE`, same top-level-import
      reasoning.
    A test file may still install its own StateStore(tmp_path) on top of this
    (e.g. test_api_state_users.py, test_auth_render_token.py) — that's fine,
    both are isolated instances, just possibly different ones; nothing here
    depends on which isolated instance wins."""
    import auto_trader.api.routers.state as state_router
    import auto_trader.core.alert_engine as alert_engine_mod
    import auto_trader.core.state_store as state_store_mod
    from auto_trader.core.state_store import StateStore

    store = StateStore(str(tmp_path / "app_state.db"))
    monkeypatch.setattr(state_store_mod, "STATE_STORE", store)
    monkeypatch.setattr(alert_engine_mod, "STATE_STORE", store)
    monkeypatch.setattr(state_router, "STATE_STORE", store)


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
