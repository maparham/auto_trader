from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

import auto_trader.api.routers.assistant as assistant_router
from auto_trader.api.app import app
from auto_trader.config import AssistantConfig
from auto_trader.core.assistant_client import ASSISTANT

client = TestClient(app)
KEY = "sk-secret-123"
BODY = {"system": "s", "messages": [{"role": "user", "content": "hi"}], "tools": []}


@pytest.fixture
def upstream():
    """Configure ASSISTANT against a mock gateway; yields the response queue."""
    queue: list[httpx.Response] = []
    calls: list[httpx.Request] = []

    def handler(request):
        calls.append(request)
        return queue.pop(0)

    ASSISTANT.configure(
        AssistantConfig(KEY, "https://gw.example", "claude-opus-5-5"),
        transport=httpx.MockTransport(handler),
    )

    async def no_sleep(_s):
        return None

    ASSISTANT._sleep = no_sleep
    yield queue, calls
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))


def test_status_unconfigured():
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert client.get("/api/assistant/status").json() == {"configured": False}


def test_status_configured(upstream):
    assert client.get("/api/assistant/status").json() == {"configured": True, "model": "claude-opus-5-5"}


def test_post_unconfigured_503():
    ASSISTANT.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert client.post("/api/assistant/messages", json=BODY).status_code == 503


def test_post_passes_message(upstream):
    queue, calls = upstream
    queue.append(httpx.Response(200, json={"id": "m1", "content": [], "stop_reason": "end_turn"}))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 200
    assert r.json()["id"] == "m1"
    assert len(calls) == 1


@pytest.mark.parametrize("status", [401, 403, 502, 503])
def test_upstream_error_424_with_body(upstream, status):
    # 424, never 502/504: the Cloudflare edge swaps an origin 502/504 for its
    # own CORS-less page, which the browser reports as "Load failed".
    queue, _ = upstream
    queue.append(httpx.Response(status, text=f"denied {KEY}"))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 424
    detail = r.json()["detail"]
    assert detail["upstream_status"] == status
    assert KEY not in detail["body"] and "denied ***" == detail["body"]


def test_server_tool_rejected(upstream):
    body = {**BODY, "tools": [{"type": "web_search_20260209", "name": "web_search"}]}
    r = client.post("/api/assistant/messages", json=body)
    assert r.status_code == 422
    assert "client tools only" in r.text


def test_too_many_messages_422(upstream):
    body = {**BODY, "messages": [{"role": "user", "content": "x"}] * 49}
    assert client.post("/api/assistant/messages", json=body).status_code == 422


def test_wrong_content_type_415_without_reaching_upstream(upstream):
    _queue, calls = upstream
    r = client.post(
        "/api/assistant/messages",
        content=json.dumps(BODY).encode(),
        headers={"content-type": "text/plain"},
    )
    assert r.status_code == 415
    assert r.json() == {"detail": "content-type must be application/json"}
    assert len(calls) == 0  # the key was never spent


def test_body_over_cap_413_without_content_length(upstream):
    big = json.dumps({**BODY, "system": "x" * (300 * 1024)}).encode()

    def chunks():
        for i in range(0, len(big), 8192):
            yield big[i : i + 8192]

    r = client.post(
        "/api/assistant/messages", content=chunks(), headers={"content-type": "application/json"}
    )
    assert r.status_code == 413


def test_demo_principal_403(upstream, monkeypatch):
    monkeypatch.setattr(assistant_router, "is_demo_request", lambda _r: True)
    assert client.get("/api/assistant/status").status_code == 403
    assert client.post("/api/assistant/messages", json=BODY).status_code == 403


def test_hosted_non_admin_403(upstream, monkeypatch):
    monkeypatch.setattr(assistant_router, "auth_enabled", lambda: True)
    monkeypatch.setattr(assistant_router.deps, "request_is_admin", lambda _r: False)
    assert client.post("/api/assistant/messages", json=BODY).status_code == 403


def test_busy_429_when_semaphore_full(upstream, monkeypatch):
    import asyncio

    monkeypatch.setattr(assistant_router, "_UPSTREAM", asyncio.Semaphore(0))
    r = client.post("/api/assistant/messages", json=BODY)
    assert r.status_code == 429
    assert "busy" in r.text
