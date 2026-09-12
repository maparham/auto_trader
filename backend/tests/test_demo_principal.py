"""Anonymous demo principal: hosted-mode allowlisted GETs run as user "demo"
without a bearer token, rate-limited, and pinned to the dukascopy broker."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import install_auth


@pytest.fixture()
def hosted_app(monkeypatch):
    monkeypatch.setenv("CLERK_JWKS_URL", "https://x.example/jwks.json")
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example")
    app = FastAPI()
    install_auth(app)

    @app.get("/api/candles")
    async def candles(request: Request) -> dict:
        return {
            "user": request.state.user_id,
            "demo": request.state.is_demo,
            "admin": request.state.is_admin,
        }

    @app.get("/api/alerts")
    async def alerts(request: Request) -> dict:
        return {"user": request.state.user_id}

    @app.post("/api/candles")
    async def candles_post() -> dict:
        return {}

    return TestClient(app)


def test_anonymous_allowlisted_get_runs_as_demo(hosted_app):
    r = hosted_app.get("/api/candles")
    assert r.status_code == 200
    assert r.json() == {"user": "demo", "demo": True, "admin": False}


def test_anonymous_off_allowlist_still_401(hosted_app):
    assert hosted_app.get("/api/alerts").status_code == 401


def test_anonymous_post_still_401(hosted_app):
    assert hosted_app.post("/api/candles").status_code == 401


def test_demo_rate_limited(hosted_app, monkeypatch):
    from auto_trader.api import demo_limit

    demo_limit._buckets.clear()
    monkeypatch.setenv("DEMO_RATE_BURST", "2")
    assert hosted_app.get("/api/candles").status_code == 200
    assert hosted_app.get("/api/candles").status_code == 200
    assert hosted_app.get("/api/candles").status_code == 429
    demo_limit._buckets.clear()


def test_dev_mode_unchanged(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    app = FastAPI()
    install_auth(app)

    @app.get("/x")
    async def x(request: Request) -> dict:
        return {"user": request.state.user_id, "demo": request.state.is_demo}

    r = TestClient(app).get("/x")
    assert r.json() == {"user": "dev", "demo": False}


# --- resolve_broker: demo pinned to dukascopy --------------------------------


class _FakeData:
    broker_id = ""
    display_name = None


def _demo_request() -> Request:
    scope = {"type": "http", "method": "GET", "path": "/api/candles", "headers": []}
    req = Request(scope)
    req.state.is_demo = True
    req.state.is_admin = False
    return req


def test_resolve_broker_demo_is_dukascopy_only(monkeypatch):
    from auto_trader.api import deps
    from auto_trader.brokers.registry import BrokerRegistry

    reg = BrokerRegistry()
    for bid in ("dukascopy", "yfinance"):
        reg.add_data(bid, _FakeData())
    monkeypatch.setattr(deps, "_registry", reg, raising=True)
    monkeypatch.setenv("CLERK_JWKS_URL", "https://x.example/jwks.json")
    assert deps.resolve_broker(_demo_request(), "") == "dukascopy"
    assert deps.resolve_broker(_demo_request(), "dukascopy") == "dukascopy"
    with pytest.raises(Exception) as ei:
        deps.resolve_broker(_demo_request(), "yfinance")
    assert getattr(ei.value, "status_code", None) == 403
