"""Per-user /api/state + scoped /ws/state fan-out (hosted mode, two tokens)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

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


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def test_state_documents_are_disjoint(clerk):
    client.put("/api/state/t.k", json={"value": 1}, headers=_auth("alice"))
    assert client.get("/api/state", headers=_auth("alice")).json() == {"t.k": 1}
    assert client.get("/api/state", headers=_auth("bob")).json() == {}
    client.delete("/api/state/t.k", headers=_auth("alice"))
    assert client.get("/api/state", headers=_auth("alice")).json() == {}


def test_ws_broadcast_scoped_to_writer_user(clerk):
    tok_a = clerk_fake.make_token(sub="alice")
    tok_b = clerk_fake.make_token(sub="bob")
    with client.websocket_connect(f"/ws/state?token={tok_a}") as ws_a, \
         client.websocket_connect(f"/ws/state?token={tok_b}") as ws_b:
        client.put(
            "/api/state/t.live", json={"value": 7},
            headers=_auth("alice"), params={"origin": "tab1"},
        )
        assert ws_a.receive_json() == {"key": "t.live", "value": 7, "origin": "tab1"}
        # Bob must NOT receive alice's write. Prove the socket stayed silent by
        # sending bob his own write and asserting it is the FIRST frame he sees.
        client.put(
            "/api/state/t.bob", json={"value": 8},
            headers=_auth("bob"), params={"origin": "tab2"},
        )
        assert ws_b.receive_json() == {"key": "t.bob", "value": 8, "origin": "tab2"}


def test_dev_mode_still_single_document(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    client.put("/api/state/t.dev", json={"value": 2})
    assert client.get("/api/state").json().get("t.dev") == 2
    client.delete("/api/state/t.dev")
