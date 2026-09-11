"""Clerk Backend API client: mapping, unconfigured degradation, error paths."""
from __future__ import annotations

import httpx
import pytest

from auto_trader.core import clerk_admin

RAW = {
    "id": "user_abc",
    "primary_email_address_id": "idn_2",
    "email_addresses": [
        {"id": "idn_1", "email_address": "old@example.com"},
        {"id": "idn_2", "email_address": "boss@example.com"},
    ],
    "first_name": "Ada",
    "last_name": "Lovelace",
    "image_url": "https://img.clerk.com/x",
    "created_at": 1700000000000,
    "last_active_at": 1800000000000,
    "last_sign_in_at": 1750000000000,
    "banned": False,
    "locked": False,
}


def test_map_user_picks_the_primary_email():
    u = clerk_admin.map_user(RAW)
    assert u["id"] == "user_abc"
    assert u["email"] == "boss@example.com"
    assert u["firstName"] == "Ada"
    assert u["createdAt"] == 1700000000000
    assert u["lastActiveAt"] == 1800000000000
    assert u["banned"] is False


def test_map_user_tolerates_missing_fields():
    u = clerk_admin.map_user({"id": "user_x"})
    assert u["id"] == "user_x"
    assert u["email"] is None and u["firstName"] is None and u["createdAt"] is None


def test_map_user_never_leaks_unmapped_keys():
    u = clerk_admin.map_user({**RAW, "private_metadata": {"secret": "s3cr3t"}})
    assert "s3cr3t" not in str(u)
    assert set(u) == {
        "id", "email", "firstName", "lastName", "imageUrl", "createdAt",
        "lastActiveAt", "lastSignInAt", "banned", "locked",
    }


@pytest.mark.anyio
async def test_unconfigured_returns_empty_not_an_error(monkeypatch):
    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    out = await clerk_admin.list_users()
    assert out == {"configured": False, "users": [], "total": 0, "error": None}


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_list_users_maps_and_counts(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer sk_test_x"
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"object": "total_count", "total_count": 7})
        assert request.url.params["limit"] == "2"
        return httpx.Response(200, json=[RAW])

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users(limit=2)
    assert out["configured"] is True and out["error"] is None
    assert out["total"] == 7
    assert out["users"][0]["email"] == "boss@example.com"


@pytest.mark.anyio
async def test_upstream_error_degrades_inline(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errors": [{"message": "Invalid key"}]})

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users()
    assert out["configured"] is True and out["users"] == []
    assert "401" in out["error"]
    assert "sk_test_x" not in out["error"]


@pytest.mark.anyio
async def test_transport_failure_degrades_inline(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users()
    assert out["configured"] is True and out["users"] == []
    assert out["error"]
