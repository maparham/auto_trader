"""install_auth middleware: dev no-op, hosted 401s, exemptions, /mcp 404."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import AUTHORIZED_PARTIES_ENV, JWKS_URL_ENV, install_auth
from tests import clerk_fake


def probe_app() -> TestClient:
    app = FastAPI()
    install_auth(app)

    @app.get("/api/whoami")
    def whoami(request: Request) -> dict:
        return {"user_id": request.state.user_id}

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    return TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_dev_mode_stamps_dev_user(monkeypatch):
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    r = probe_app().get("/api/whoami")
    assert r.status_code == 200
    assert r.json() == {"user_id": "dev"}


def test_hosted_missing_header_401(clerk):
    r = probe_app().get("/api/whoami")
    assert r.status_code == 401


def test_hosted_bad_token_401(clerk):
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": "Bearer nope"}
    )
    assert r.status_code == 401


def test_hosted_valid_token_stamps_sub(clerk):
    tok = clerk_fake.make_token()
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200
    assert r.json() == {"user_id": "user_123"}


def test_health_exempt(clerk):
    assert probe_app().get("/health").status_code == 200


def test_options_exempt(clerk):
    # 405 (no OPTIONS route), NOT 401: the middleware let it through.
    assert probe_app().options("/api/whoami").status_code == 405


def test_mcp_hidden_in_hosted_mode(clerk):
    tok = clerk_fake.make_token()
    r = probe_app().get("/mcp", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 404


def test_install_rejects_non_https_jwks(monkeypatch):
    monkeypatch.setenv(JWKS_URL_ENV, "http://insecure.example/jwks.json")
    with pytest.raises(RuntimeError):
        install_auth(FastAPI())


def test_install_rejects_missing_authorized_parties(monkeypatch):
    monkeypatch.setenv(JWKS_URL_ENV, "https://clerk.example/.well-known/jwks.json")
    monkeypatch.delenv(AUTHORIZED_PARTIES_ENV, raising=False)
    with pytest.raises(RuntimeError):
        install_auth(FastAPI())


def test_install_rejects_empty_authorized_parties(monkeypatch):
    monkeypatch.setenv(JWKS_URL_ENV, "https://clerk.example/.well-known/jwks.json")
    monkeypatch.setenv(AUTHORIZED_PARTIES_ENV, "")
    with pytest.raises(RuntimeError):
        install_auth(FastAPI())


def test_real_app_dev_mode_still_open(monkeypatch):
    """Regression guarantee: with no Clerk env the real app behaves as today."""
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    from auto_trader.api.app import app

    r = TestClient(app).get("/api/agent/sessions")
    assert r.status_code == 200


def test_real_app_hosted_mode_gated(clerk):
    from auto_trader.api.app import app

    client = TestClient(app)
    assert client.get("/api/agent/sessions").status_code == 401
    tok = clerk_fake.make_token()
    r = client.get(
        "/api/agent/sessions", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200


def test_real_app_health_exempt_in_hosted_mode(clerk):
    from auto_trader.api.app import app

    assert TestClient(app).get("/health").status_code == 200
