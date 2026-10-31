from __future__ import annotations

import json

import httpx
import pytest

from auto_trader.config import AssistantConfig
from auto_trader.core.assistant_client import AssistantClient

KEY = "sk-secret-123"
REQ = {"system": "s", "messages": [{"role": "user", "content": "hi"}], "tools": [], "max_tokens": None}


def _client(responses):
    """responses: list of httpx.Response, served in order."""
    calls: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return queue.pop(0)

    c = AssistantClient()
    c.configure(
        AssistantConfig(api_key=KEY, base_url="https://gw.example", model="claude-opus-5-5"),
        transport=httpx.MockTransport(handler),
    )
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:
        slept.append(s)

    c._sleep = fake_sleep
    return c, calls, slept


@pytest.mark.anyio
async def test_success_passes_message_and_builds_exact_body():
    msg = {"id": "m1", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}
    c, calls, _ = _client([httpx.Response(200, json=msg)])
    req = {**REQ, "max_tokens": 99999, "stream": True, "tool_choice": {"type": "any"}}
    out = await c.create_message(req)
    assert out == {"ok": True, "message": msg}
    (call,) = calls
    assert call.url.path == "/v1/messages"
    assert call.headers["x-api-key"] == KEY
    assert call.headers["anthropic-version"] == "2023-06-01"
    assert call.headers["content-type"] == "application/json"
    body = json.loads(call.content)
    assert set(body) == {"model", "max_tokens", "system", "messages", "tools"}
    assert body["model"] == "claude-opus-5-5"
    assert body["max_tokens"] == 4096


@pytest.mark.anyio
async def test_429_then_200_retries_once_with_retry_after():
    c, calls, slept = _client([
        httpx.Response(429, headers={"retry-after": "1"}, text="slow down"),
        httpx.Response(200, json={"id": "m"}),
    ])
    out = await c.create_message(REQ)
    assert out["ok"] is True
    assert len(calls) == 2
    assert slept == [1.0]


@pytest.mark.anyio
async def test_retry_after_capped_and_defaulted():
    c, _, slept = _client([httpx.Response(429, headers={"retry-after": "999"}), httpx.Response(200, json={})])
    await c.create_message(REQ)
    c2, _, slept2 = _client([httpx.Response(429), httpx.Response(200, json={})])
    await c2.create_message(REQ)
    assert slept == [30.0]
    assert slept2 == [2.0]


@pytest.mark.anyio
async def test_429_twice_returns_second_body():
    c, calls, _ = _client([httpx.Response(429, text="first"), httpx.Response(429, text="second")])
    out = await c.create_message(REQ)
    assert out == {"ok": False, "status": 429, "body": "second"}
    assert len(calls) == 2


@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 403, 503, 500])
async def test_no_retry_statuses_report_body(status):
    c, calls, slept = _client([httpx.Response(status, text=f"err {status}")])
    out = await c.create_message(REQ)
    assert out == {"ok": False, "status": status, "body": f"err {status}"}
    assert len(calls) == 1
    assert slept == []


@pytest.mark.anyio
async def test_key_scrubbed_from_error_body():
    c, _, _ = _client([httpx.Response(401, text=f"bad key {KEY}")])
    out = await c.create_message(REQ)
    assert KEY not in out["body"]
    assert "***" in out["body"]


@pytest.mark.anyio
async def test_upstream_error_is_logged_scrubbed_and_trimmed(caplog):
    import logging

    c, _, _ = _client([httpx.Response(502, text=f"gateway down {KEY} " + "x" * 2000)])
    with caplog.at_level(logging.WARNING, logger="auto_trader.core.assistant_client"):
        await c.create_message(REQ)
    assert "assistant upstream answered 502" in caplog.text
    assert "gateway down ***" in caplog.text
    assert KEY not in caplog.text
    assert "x" * 600 not in caplog.text


@pytest.mark.anyio
async def test_network_error_is_scrubbed_502():
    c = AssistantClient()

    def boom(request):
        raise httpx.ConnectError(f"cannot reach with {KEY}")

    c.configure(AssistantConfig(KEY, "https://gw.example", "claude-opus-5-5"), transport=httpx.MockTransport(boom))
    out = await c.create_message(REQ)
    assert out["ok"] is False and out["status"] == 502
    assert KEY not in out["body"]


def test_unconfigured_is_disabled():
    c = AssistantClient()
    c.configure(AssistantConfig("", "https://gw.example", "claude-opus-5-5"))
    assert not c.enabled
    assert c.model is None
