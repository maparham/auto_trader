import time

import jwt as pyjwt
import pytest
from fastapi.testclient import TestClient

from auto_trader.api import auth
from auto_trader.api.app import app
from auto_trader.core.state_store import StateStore
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated_state_store(tmp_path, monkeypatch):
    import auto_trader.api.routers.state as state_router

    monkeypatch.setattr(
        state_router, "STATE_STORE", StateStore(str(tmp_path / "state.db"))
    )


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_mint_verify_roundtrip():
    tok = auth.mint_render_token("user-42")
    assert auth.verify_render_token(tok) == "user-42"


def test_expired_token_rejected():
    tok = pyjwt.encode(
        {"sub": "u", "iss": auth.RENDER_TOKEN_ISS, "exp": int(time.time()) - 10},
        auth._render_secret(),
        algorithm="HS256",
    )
    assert auth.verify_render_token(tok) is None


def test_wrong_secret_rejected():
    tok = pyjwt.encode(
        {"sub": "u", "iss": auth.RENDER_TOKEN_ISS, "exp": int(time.time()) + 60},
        "not-the-secret",
        algorithm="HS256",
    )
    assert auth.verify_render_token(tok) is None


def test_garbage_rejected():
    assert auth.verify_render_token("nonsense") is None
    assert auth.verify_render_token("") is None


def test_middleware_accepts_render_token(clerk):
    tok = auth.mint_render_token("user-42")
    r = client.get("/api/state", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200


def test_middleware_still_rejects_garbage(clerk):
    r = client.get("/api/state", headers={"Authorization": "Bearer junk"})
    assert r.status_code == 401


def test_ws_accepts_render_token(clerk):
    tok = auth.mint_render_token("user-42")
    with client.websocket_connect(f"/ws/state?token={tok}"):
        pass  # handshake succeeding is the assertion; 4401 would raise


def test_middleware_rejects_render_token_on_write(clerk):
    # The render token exists only so the headless snapshot page can READ as
    # the alerted user; it must never authorize a write (it travels in a URL
    # query string, so it's more exposed than a header-only bearer token).
    tok = auth.mint_render_token("user-42")
    r = client.put(
        "/api/state/some.key",
        headers={"Authorization": f"Bearer {tok}"},
        json={"value": "x"},
    )
    assert r.status_code == 401
    assert r.json() == {"detail": auth.INVALID_TOKEN_MSG}


def test_render_token_passes_restricted_broker_gate(clerk):
    # The heartbeat the snapshot page rebuilds is usually on a credentialed
    # broker (capital-live). The render principal is deliberately non-admin,
    # but it must still pass resolve_broker's restricted gate for reads, or
    # hosted snapshots can never fetch the candles of the very chart they
    # exist to screenshot (they 403'd and fell back to matplotlib for weeks).
    tok = auth.mint_render_token("user-42")
    r = client.get(
        "/api/candles?epic=X&resolution=HOUR&broker=capital-live",
        headers={"Authorization": f"Bearer {tok}"},
    )
    # capital-live isn't registered in tests, so passing the gate surfaces as
    # 404 (unknown broker) rather than the admin-access 403.
    assert r.status_code != 403


def test_clerk_non_admin_still_blocked_on_restricted_broker(clerk):
    tok = clerk_fake.make_token(sub="user_plain")
    r = client.get(
        "/api/candles?epic=X&resolution=HOUR&broker=capital-live",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
    assert "requires admin access" in r.json()["detail"]


def test_middleware_render_token_is_never_admin(clerk):
    # /api/brokers reflects request.state.is_admin as `isAdmin` in its
    # response body, giving an observable seam for the middleware's admin
    # flag without adding a test-only production route.
    tok = auth.mint_render_token("user-42")
    r = client.get("/api/brokers", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200
    assert r.json()["isAdmin"] is False
