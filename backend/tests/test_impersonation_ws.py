"""Impersonation over WebSocket: browsers cannot set handshake headers, so the
target rides in the `impersonate` query param next to `token`."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auto_trader.api.app import app
from auto_trader.api.auth import ADMIN_EMAILS_ENV
from tests import clerk_fake

ADMIN_EMAIL = "boss@example.com"

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(ADMIN_EMAILS_ENV, ADMIN_EMAIL)


def admin_token() -> str:
    return clerk_fake.make_token(sub="user_admin", extra={"email": ADMIN_EMAIL})


def plain_token() -> str:
    return clerk_fake.make_token(sub="user_plain")


def test_ws_admin_impersonates(clerk):
    from auto_trader.api.routers.state import _state_subscribers

    url = f"/ws/state?token={admin_token()}&impersonate=user_target"
    with client.websocket_connect(url):
        # A clean handshake alone can't distinguish "resolved to the target"
        # from "quietly fell back to the admin's own sub" (the failure
        # resolve_impersonation exists to prevent): assert on the identity
        # the socket actually registered under.
        registered = list(_state_subscribers.values())
        assert registered == ["user_target"]
        assert "user_admin" not in registered


def test_ws_non_admin_impersonating_is_closed(clerk):
    url = f"/ws/state?token={plain_token()}&impersonate=user_target"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url):
            pass
    assert exc.value.code == 4401


def test_ws_render_token_with_impersonate_is_closed(clerk):
    from auto_trader.api.auth import mint_render_token

    url = f"/ws/state?token={mint_render_token('user_rendered')}&impersonate=user_target"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url):
            pass
    assert exc.value.code == 4401


def test_ws_render_token_with_impersonate_is_logged(clerk, caplog):
    import logging

    from auto_trader.api.auth import mint_render_token
    from auto_trader.core import impersonation_audit

    impersonation_audit.reset()
    url = f"/ws/state?token={mint_render_token('user_rendered')}&impersonate=user_target"
    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url):
                pass
    assert "impersonation refused" in caplog.text
    assert "render token" in caplog.text
    impersonation_audit.reset()


def test_ws_non_admin_impersonating_is_logged(clerk, caplog):
    import logging

    from auto_trader.core import impersonation_audit

    impersonation_audit.reset()
    url = f"/ws/state?token={plain_token()}&impersonate=user_target"
    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url):
                pass
    assert "impersonation refused" in caplog.text
    impersonation_audit.reset()
