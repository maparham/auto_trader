"""Admin gating: /api/brokers filtering, restricted-broker 403s on the
?broker= query dependency, and the dealing-router-wide admin gate."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import auth, deps
from auto_trader.api.app import app
from auto_trader.brokers.registry import BrokerRegistry
from tests import clerk_fake


class _FakeData:
    broker_id = ""
    display_name = None


class _FakeExec:
    env = "paper"
    is_real_money = False


def _fake_registry() -> BrokerRegistry:
    r = BrokerRegistry()
    for bid in ("dukascopy", "yfinance", "capital", "mt5"):
        r.add_data(bid, _FakeData())
    r.add_exec("capital:paper", _FakeExec())
    return r


@pytest.fixture()
def client(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "user_admin")
    with TestClient(app) as c:
        # lifespan (triggered by __enter__) builds the real registry; replace
        # it with the fake AFTER startup so it isn't clobbered.
        monkeypatch.setattr(deps, "_registry", _fake_registry())
        yield c


@pytest.fixture()
def admin_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_admin')}"}


@pytest.fixture()
def user_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_pleb')}"}


def test_brokers_filtered_for_non_admin(client, user_headers):
    d = client.get("/api/brokers", headers=user_headers).json()
    assert d["isAdmin"] is False
    assert "capital" not in d["data"]
    # every exec entry must be a synthetic data-only pseudo-account; none of
    # the real (restricted) exec accounts should leak through for a non-admin.
    assert d["exec"] and all(e.get("dataOnly") for e in d["exec"])
    assert "capital:paper" not in {e["key"] for e in d["exec"]}


def test_brokers_full_for_admin(client, admin_headers):
    d = client.get("/api/brokers", headers=admin_headers).json()
    assert d["isAdmin"] is True
    assert "capital" in d["data"]


def test_restricted_broker_query_403(client, user_headers):
    r = client.get("/api/markets?broker=capital&q=x", headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


class _FakeState:
    def __init__(self, is_admin: bool) -> None:
        self.is_admin = is_admin


class _FakeRequest:
    """Stands in for a FastAPI Request for deps.resolve_broker: only
    `.state.is_admin` is read."""

    def __init__(self, is_admin: bool) -> None:
        self.state = _FakeState(is_admin)


def test_default_broker_falls_back_for_non_admin(client, user_headers):
    # bare request must NOT land on restricted default "capital"; it should
    # resolve to an unrestricted broker (dukascopy) instead of 403ing. The
    # route-level assertion alone doesn't prove which broker it landed on
    # (the fake broker 502s on search before that would show up), so also
    # call resolve_broker directly against the same (monkeypatched) registry.
    r = client.get("/api/markets?q=x", headers=user_headers)
    assert r.status_code != 403
    assert deps.resolve_broker(_FakeRequest(is_admin=False), "") == "dukascopy"
    assert deps.resolve_broker(_FakeRequest(is_admin=True), "") == "capital"


def test_dealing_403_for_non_admin(client, user_headers):
    assert (
        client.get("/api/positions?account=capital:paper", headers=user_headers).status_code
        == 403
    )
    r = client.post("/api/orders", json={}, headers=user_headers)
    assert r.status_code == 403  # 403 beats 422 (router-level dependency)
    assert r.json()["detail"] == "dealing requires admin access"


def test_dealing_allowed_for_admin(client, admin_headers):
    r = client.get("/api/positions?account=capital:paper", headers=admin_headers)
    assert r.status_code != 403


def test_brokers_dev_mode_unfiltered(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    with TestClient(app) as c:
        monkeypatch.setattr(deps, "_registry", _fake_registry())
        d = c.get("/api/brokers").json()
    assert d["isAdmin"] is True
    assert "capital" in d["data"]


def test_dealing_not_403_in_dev_mode(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    with TestClient(app) as c:
        monkeypatch.setattr(deps, "_registry", _fake_registry())
        r = c.get("/api/positions?account=capital:paper")
    assert r.status_code != 403


# --- Task 4: body-carried broker ids + WS stream gate -------------------------


def _backtest_body(broker: str) -> dict:
    return {
        "epic": "US100",
        "resolution": "MINUTE",
        "candles": [],
        "series": {},
        "costs": {
            "quantity": 1,
            "commissionPerSide": 0,
            "slippage": {"kind": "fixed", "value": 0},
            "startingCash": 1000,
        },
        "tradeFromTime": 0,
        "broker": broker,
    }


def test_backtest_restricted_broker_403(client, user_headers):
    r = client.post("/api/backtest", json=_backtest_body("capital"), headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_backtest_free_broker_not_403(client, user_headers):
    r = client.post("/api/backtest", json=_backtest_body("dukascopy"), headers=user_headers)
    assert r.status_code != 403


def test_backtest_sweep_restricted_broker_403(client, user_headers):
    r = client.post(
        "/api/backtest/sweep/jobs", json=_backtest_body("capital"), headers=user_headers
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_backtest_wfo_restricted_broker_403(client, user_headers):
    r = client.post(
        "/api/backtest/walkforward/jobs", json=_backtest_body("capital"), headers=user_headers
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_strategy_evaluate_restricted_broker_403(client, user_headers):
    body = {
        "epic": "US100",
        "resolution": "MINUTE",
        "candles": [],
        "broker": "capital",
    }
    r = client.post("/api/strategy/evaluate", json=body, headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def _pattern_body(broker: str) -> dict:
    bar = {"o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0}
    return {
        "epic": "US100",
        "resolution": "MINUTE",
        "broker": broker,
        "query": [bar, bar, bar],
        "queryFromTs": 0,
        "queryToTs": 100,
    }


def test_pattern_search_restricted_403(client, user_headers):
    r = client.post("/api/patterns/search", json=_pattern_body("capital"), headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_pattern_search_free_broker_not_403(client, user_headers):
    r = client.post(
        "/api/patterns/search", json=_pattern_body("dukascopy"), headers=user_headers
    )
    assert r.status_code != 403


def _expr_series_body(broker: str) -> dict:
    return {
        "epic": "US100",
        "resolution": "MINUTE",
        "expr": "close",
        "fromTime": 0,
        "toTime": 100,
        "broker": broker,
    }


def test_expr_series_restricted_403(client, user_headers):
    r = client.post("/api/expr/series", json=_expr_series_body("capital"), headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_expr_closeness_restricted_403(client, user_headers):
    body = {
        "epic": "US100",
        "broker": "capital",
        "rows": ["close > 0"],
        "baseResolution": "MINUTE",
        "displayResolution": "MINUTE",
        "fromTime": 0,
        "toTime": 100,
    }
    r = client.post("/api/expr/closeness", json=body, headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_expr_backtest_restricted_broker_403(client, user_headers):
    r = client.post("/api/expr/backtest", json=_backtest_body("capital"), headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_costs_get_profile_restricted_broker_403(client, user_headers):
    r = client.get("/api/costs/US100?broker=capital", headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "broker 'capital' requires admin access"


def test_costs_get_profile_free_broker_not_403(client, user_headers):
    r = client.get("/api/costs/US100?broker=dukascopy", headers=user_headers)
    assert r.status_code != 403


def test_ws_candles_restricted_broker_fatal(client, user_headers):
    tok = clerk_fake.make_token(sub="user_pleb")
    with client.websocket_connect(f"/ws/candles?token={tok}&broker=capital") as ws:
        msg = ws.receive_json()
    assert msg == {
        "type": "error",
        "detail": "broker 'capital' requires admin access",
        "fatal": True,
    }


