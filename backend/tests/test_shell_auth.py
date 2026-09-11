"""The shell browser-auth handoff's token mint: /api/auth/shell-token."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.routers import shell_auth
from tests import clerk_fake


@pytest.fixture()
def client(monkeypatch):
    clerk_fake.install(monkeypatch)
    with TestClient(app) as c:
        yield c


def _auth() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_123')}"}


def test_mints_a_token_for_the_request_user(client, monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["json"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"token": "sit_abc", "user_id": "user_123"})

    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(shell_auth, "_transport", lambda: httpx.MockTransport(handler))
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"token": "sit_abc"}
    assert seen["url"] == f"{shell_auth.API_BASE}/sign_in_tokens"
    assert seen["json"] == {"user_id": "user_123", "expires_in_seconds": 300}
    assert seen["auth"] == "Bearer sk_test_secret"


def test_unconfigured_is_503(client, monkeypatch):
    monkeypatch.delenv(shell_auth.SECRET_ENV, raising=False)
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 503


def test_clerk_failure_is_502_without_echoing_the_secret(client, monkeypatch):
    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(
        shell_auth,
        "_transport",
        lambda: httpx.MockTransport(lambda req: httpx.Response(500, json={"errors": []})),
    )
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 502
    assert "sk_test_secret" not in r.text


def test_missing_token_in_clerk_response_is_502(client, monkeypatch):
    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(
        shell_auth,
        "_transport",
        lambda: httpx.MockTransport(lambda req: httpx.Response(200, json={"nope": 1})),
    )
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 502


def test_malformed_json_in_200_response_is_502(client, monkeypatch):
    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(
        shell_auth,
        "_transport",
        lambda: httpx.MockTransport(lambda req: httpx.Response(200, text="not json")),
    )
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 502


def test_unauthenticated_is_401(client):
    r = client.post("/api/auth/shell-token")
    assert r.status_code == 401
