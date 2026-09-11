"""Admin console endpoints: the gate, whoami, logs, health, usage, users."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import auth
from auto_trader.api.app import app
from tests import clerk_fake


@pytest.fixture()
def client(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "user_admin")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_admin')}"}


@pytest.fixture()
def user_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_pleb')}"}


ENDPOINTS = ("/api/admin/whoami", "/api/admin/health", "/api/admin/usage",
             "/api/admin/logs", "/api/admin/users")


@pytest.mark.parametrize("path", ENDPOINTS)
def test_non_admin_gets_403(client, user_headers, path):
    r = client.get(path, headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "admin access required"


@pytest.mark.parametrize("path", ENDPOINTS)
def test_unauthenticated_gets_401(client, path):
    assert client.get(path).status_code == 401


def test_whoami_for_admin(client, admin_headers):
    r = client.get("/api/admin/whoami", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["userId"] == "user_admin"
    assert body["isAdmin"] is True
    assert body["hostedMode"] is True


def test_whoami_carries_email_claim(client):
    tok = clerk_fake.make_token(sub="user_admin", extra={"email": "boss@example.com"})
    r = client.get("/api/admin/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["email"] == "boss@example.com"


def test_whoami_dev_mode(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    with TestClient(app) as c:
        body = c.get("/api/admin/whoami").json()
    assert body == {"userId": "dev", "email": None, "isAdmin": True, "hostedMode": False}


def test_logs_returns_recent_records(client, admin_headers):
    import logging

    logging.getLogger("auto_trader.admin_test").warning("hello-admin-console")
    body = client.get("/api/admin/logs", headers=admin_headers).json()
    assert body["capacity"] >= 1
    assert any(r["message"] == "hello-admin-console" for r in body["records"])


def test_logs_level_filter(client, admin_headers):
    import logging

    logging.getLogger("auto_trader.admin_test").info("quiet-line-xyz")
    body = client.get("/api/admin/logs?level=ERROR", headers=admin_headers).json()
    assert all(r["level"] in ("ERROR", "CRITICAL") for r in body["records"])


def test_health_for_admin(client, admin_headers):
    body = client.get("/api/admin/health", headers=admin_headers).json()
    assert "process" in body and "databases" in body
    assert body["process"]["hostedMode"] is True


def test_usage_for_admin(client, admin_headers):
    body = client.get("/api/admin/usage", headers=admin_headers).json()
    assert isinstance(body["users"], list)
    for row in body["users"]:
        assert set(row) >= {"userId", "runs", "alerts", "lastSeen"}


def test_users_unconfigured_is_200_not_500(client, admin_headers, monkeypatch):
    from auto_trader.core import clerk_admin

    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    r = client.get("/api/admin/users", headers=admin_headers)
    assert r.status_code == 200
    assert r.json() == {"configured": False, "users": [], "total": 0, "error": None}
