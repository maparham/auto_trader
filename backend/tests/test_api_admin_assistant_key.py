"""/api/admin/assistant: set, show and clear the /admin-saved gateway key."""
from __future__ import annotations

import json
import os
import stat

import httpx
import pytest
from fastapi.testclient import TestClient

import auto_trader.api.routers.admin as admin_router
import auto_trader.core.assistant_key_store as key_store_mod
from auto_trader.api.app import app
from auto_trader.config import AssistantConfig
from auto_trader.core.assistant_client import AssistantClient

client = TestClient(app)

ENV_KEY = "sk-env-key-1111"
NEW_KEY = "sk-new-key-2222"


@pytest.fixture
def gateway(monkeypatch):
    """A fresh AssistantClient on a fake gateway that accepts only the keys
    in `accept`. Yields (assistant, seen requests, accept set)."""
    seen: list[httpx.Request] = []
    accept = {ENV_KEY, NEW_KEY}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers["x-api-key"] not in accept:
            return httpx.Response(401, json={"error": "bad key"})
        return httpx.Response(200, json={"id": "m", "content": []})

    a = AssistantClient()
    a.configure(
        AssistantConfig(api_key=ENV_KEY, base_url="https://gw.example", model="claude-opus-5-5"),
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(admin_router, "ASSISTANT", a)
    return a, seen, accept


def test_env_key_is_reported_without_the_key(gateway):
    r = client.get("/api/admin/assistant")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "env"
    assert body["last4"] == "1111"
    assert ENV_KEY not in r.text


def test_saving_a_good_key_verifies_stores_and_switches(gateway):
    a, seen, _ = gateway
    r = client.put("/api/admin/assistant", json={"api_key": f"  {NEW_KEY} "})
    assert r.status_code == 200
    assert r.json()["source"] == "dashboard"
    assert r.json()["last4"] == "2222"
    assert NEW_KEY not in r.text
    (probe,) = seen
    assert probe.headers["x-api-key"] == NEW_KEY
    assert json.loads(probe.content)["max_tokens"] == 1
    assert key_store_mod.get_assistant_key_store().get().api_key == NEW_KEY
    assert a._cfg.api_key == NEW_KEY


def test_store_file_is_owner_only(gateway):
    client.put("/api/admin/assistant", json={"api_key": NEW_KEY})
    path = key_store_mod.get_assistant_key_store()._db_path
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_a_rejected_key_is_not_saved(gateway):
    a, _, _ = gateway
    r = client.put("/api/admin/assistant", json={"api_key": "sk-typo-9999"})
    assert r.status_code == 422
    assert "rejected" in r.json()["detail"]
    assert key_store_mod.get_assistant_key_store().get() is None
    assert a._cfg.api_key == ENV_KEY


def test_gateway_error_is_a_422_not_a_502(gateway, monkeypatch):
    a, _, _ = gateway

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="bad gateway")

    a._transport = httpx.MockTransport(handler)
    r = client.put("/api/admin/assistant", json={"api_key": NEW_KEY})
    assert r.status_code == 422
    assert "502" in r.json()["detail"]
    assert key_store_mod.get_assistant_key_store().get() is None


def test_blank_key_422s(gateway):
    r = client.put("/api/admin/assistant", json={"api_key": "   "})
    assert r.status_code == 422


def test_clearing_reverts_to_the_env_key(gateway):
    a, _, _ = gateway
    client.put("/api/admin/assistant", json={"api_key": NEW_KEY})
    r = client.delete("/api/admin/assistant")
    assert r.status_code == 200
    assert r.json()["source"] == "env"
    assert key_store_mod.get_assistant_key_store().get() is None
    assert a._cfg.api_key == ENV_KEY


def test_disabled_wins_over_a_saved_key():
    a = AssistantClient()
    a.configure(
        AssistantConfig(api_key="", base_url="https://gw.example", model="m", disabled=True)
    )
    a.set_key_override(NEW_KEY)
    assert not a.enabled


def test_override_enables_a_server_with_no_env_key():
    a = AssistantClient()
    a.configure(AssistantConfig(api_key="", base_url="https://gw.example", model="m"))
    assert not a.enabled
    a.set_key_override(NEW_KEY)
    assert a.enabled


def test_non_admin_is_refused(monkeypatch):
    from auto_trader.api import deps

    monkeypatch.setattr(deps, "request_is_admin", lambda request: False)
    assert client.get("/api/admin/assistant").status_code == 403
    assert client.put("/api/admin/assistant", json={"api_key": NEW_KEY}).status_code == 403
    assert client.delete("/api/admin/assistant").status_code == 403
