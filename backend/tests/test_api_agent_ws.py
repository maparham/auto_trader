"""WS /ws/agent-ui registers a tab in the HUB; GET /api/agent/sessions lists it."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auto_trader.api.app import app

client = TestClient(app)


def test_sessions_empty():
    r = client.get("/api/agent/sessions")
    assert r.status_code == 200
    assert r.json() == {"sessions": []}


def test_ws_registers_and_relays():
    with client.websocket_connect("/ws/agent-ui") as ws:
        sessions = client.get("/api/agent/sessions").json()["sessions"]
        assert len(sessions) == 1

        # Emulate the tab side: an unknown request id is ignored by the hub but
        # still bumps lastActive. (The full request/reply round trip over a real
        # socket is covered by the probe script in Task 9.)
        ws.send_json({"id": "nope", "ok": True, "result": 1})
        sessions2 = client.get("/api/agent/sessions").json()["sessions"]
        assert sessions2[0]["lastActive"] >= sessions[0]["lastActive"]

    # After close the tab is gone.
    assert client.get("/api/agent/sessions").json()["sessions"] == []


# -- token gate ------------------------------------------------------------
# guard.install_guards is http-only middleware, so the WS route enforces
# REQUIRE_API_TOKEN itself. The sessions probe below carries the bearer header
# because the GET *is* gated by the middleware.
AUTH = {"Authorization": "Bearer s3cret"}


@pytest.fixture
def token_gate(monkeypatch):
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.setenv("API_TOKEN", "s3cret")


def test_ws_rejected_without_token(token_gate):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/agent-ui"):
            pass
    assert exc.value.code == 4401
    # Rejected before HUB.register, so nothing was ever registered.
    assert client.get("/api/agent/sessions", headers=AUTH).json()["sessions"] == []


def test_ws_accepted_with_token(token_gate):
    with client.websocket_connect("/ws/agent-ui", headers=AUTH):
        sessions = client.get("/api/agent/sessions", headers=AUTH).json()["sessions"]
        assert len(sessions) == 1
    assert client.get("/api/agent/sessions", headers=AUTH).json()["sessions"] == []


# -- origin gate -----------------------------------------------------------
# WebSockets are CORS-exempt, so the route checks Origin itself: a browser
# always sends one, a non-browser client (probe script, tests) sends none.


def test_ws_rejects_foreign_origin():
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            "/ws/agent-ui", headers={"Origin": "http://evil.example"}
        ):
            pass
    assert exc.value.code == 4403
    # Rejected before HUB.register, so nothing was ever registered.
    assert client.get("/api/agent/sessions").json()["sessions"] == []


def test_ws_accepts_allowlisted_origin():
    with client.websocket_connect(
        "/ws/agent-ui", headers={"Origin": "http://localhost:5173"}
    ):
        assert len(client.get("/api/agent/sessions").json()["sessions"]) == 1


def test_ws_accepts_absent_origin():
    with client.websocket_connect("/ws/agent-ui"):
        assert len(client.get("/api/agent/sessions").json()["sessions"]) == 1
