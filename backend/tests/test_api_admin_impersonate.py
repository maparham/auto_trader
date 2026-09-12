"""POST /api/admin/impersonate: validate the target, record the start."""
from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import clerk_admin

client = TestClient(app)

RAW_USER = {
    "id": "user_target",
    "primary_email_address_id": "idn_1",
    "email_addresses": [{"id": "idn_1", "email_address": "target@example.com"}],
    "first_name": "Tara",
    "last_name": "Get",
}


def fake_clerk(monkeypatch, status: int, body, seen_paths: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen_paths is not None:
            # raw_path preserves percent-encoding as sent on the wire; .path
            # decodes it back for display and would hide an injection.
            seen_paths.append(request.url.raw_path.decode())
        return httpx.Response(status, json=body)

    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_fake")
    monkeypatch.setattr(
        clerk_admin, "_transport", lambda: httpx.MockTransport(handler)
    )


def test_known_user_returns_the_mapped_user(monkeypatch):
    fake_clerk(monkeypatch, 200, RAW_USER)
    r = client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "target@example.com"


def test_unknown_user_404s(monkeypatch):
    seen_paths: list = []
    fake_clerk(monkeypatch, 404, {"errors": []}, seen_paths)
    r = client.post("/api/admin/impersonate", json={"user_id": "user_nope"})
    assert r.status_code == 404
    assert "user_nope" in r.json()["detail"]
    assert seen_paths == ["/v1/users/user_nope"]


def test_unconfigured_clerk_503s(monkeypatch):
    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    r = client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert r.status_code == 503


def test_blank_user_id_422s(monkeypatch):
    fake_clerk(monkeypatch, 200, RAW_USER)
    r = client.post("/api/admin/impersonate", json={"user_id": "  "})
    assert r.status_code == 422


def test_it_logs_the_start(monkeypatch, caplog):
    import logging

    fake_clerk(monkeypatch, 200, RAW_USER)
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert "impersonation start" in caplog.text
    assert "target=user_target" in caplog.text


def test_path_traversal_user_id_does_not_escape_the_users_collection(monkeypatch):
    seen_paths: list = []
    fake_clerk(monkeypatch, 404, {"errors": []}, seen_paths)
    r = client.post("/api/admin/impersonate", json={"user_id": "../users"})
    assert r.status_code == 404
    # The traversal segments must reach Clerk percent-encoded, as a literal
    # user id, never resolved into a different collection endpoint.
    assert seen_paths == ["/v1/users/..%2Fusers"]
