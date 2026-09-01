"""Hosted mode gates every WS route via a `token` query param; dev mode open."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auto_trader.api.app import app
from auto_trader.api.auth import JWKS_URL_ENV
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_ws_state_dev_mode_open(monkeypatch):
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    with client.websocket_connect("/ws/state"):
        pass


@pytest.mark.parametrize("path", ["/ws/state", "/ws/agent-ui", "/ws/candles"])
def test_ws_rejected_without_token(clerk, path):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(path):
            pass
    assert exc.value.code == 4401


@pytest.mark.parametrize("path", ["/ws/state", "/ws/agent-ui", "/ws/candles"])
def test_ws_rejected_with_bad_token(clerk, path):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"{path}?token=nope"):
            pass
    assert exc.value.code == 4401


def test_ws_state_accepts_valid_token(clerk):
    tok = clerk_fake.make_token()
    with client.websocket_connect(f"/ws/state?token={tok}"):
        pass


def test_ws_agent_ui_accepts_valid_token(clerk):
    tok = clerk_fake.make_token()
    with client.websocket_connect(f"/ws/agent-ui?token={tok}") as ws:
        del ws
