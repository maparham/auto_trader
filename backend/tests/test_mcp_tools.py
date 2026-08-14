"""MCP tool functions drive BridgeHub correctly (no HTTP transport involved),
plus a transport-level check that the server really answers at exactly /mcp."""
import asyncio
import re

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import mcp_server
from auto_trader.api.agent_bridge import BridgeHub


@pytest.fixture()
def hub(monkeypatch):
    h = BridgeHub()
    monkeypatch.setattr(mcp_server, "HUB", h)
    return h


def fake_tab(hub):
    sent = []

    async def send(frame):
        sent.append(frame)

    sid = hub.register(send)
    return sid, sent


async def reply(hub, sid, sent, **kv):
    while not sent:
        await asyncio.sleep(0)
    hub.on_frame(sid, {"id": sent[-1]["id"], **kv})


@pytest.mark.anyio
async def test_ui_sessions_empty(hub):
    assert await mcp_server.ui_sessions() == []


@pytest.mark.anyio
async def test_ui_actions_relays_manifest(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_actions())
    await reply(hub, sid, sent, ok=True, result=[{"name": "backtest.run"}])
    assert await task == [{"name": "backtest.run"}]
    assert sent[0]["op"] == "manifest"


@pytest.mark.anyio
async def test_ui_invoke_and_wait(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_invoke("backtest.run", {}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    assert await task == {"handle": rid}
    hub.on_frame(sid, {"handle": rid, "event": "done", "payload": {"pnl": 1}})
    st = await mcp_server.ui_wait(rid, timeout_s=1)
    assert st["status"] == "done" and st["result"] == {"pnl": 1}


@pytest.mark.anyio
async def test_no_tab_is_a_clear_message(hub):
    with pytest.raises(Exception, match="no UI session connected"):
        await mcp_server.ui_invoke("x", {})


@pytest.mark.anyio
async def test_invalid_args_error_carries_schema(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_invoke("x", {}))
    await reply(hub, sid, sent, ok=False,
                error={"code": "INVALID_ARGS", "message": "missing epic",
                       "expectedSchema": {"type": "object"}})
    with pytest.raises(Exception, match="INVALID_ARGS.*missing epic"):
        await task


@pytest.mark.anyio
async def test_ui_read_state_marks_the_frame_read_only(hub):
    """The tab refuses a non-read action on a readOnly frame, so ui_read_state
    can never be used to place an order."""
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_read_state("backtest.result"))
    await reply(hub, sid, sent, ok=True, result={"pnl": 1})
    assert await task == {"pnl": 1}
    assert sent[0]["op"] == "invoke"
    assert sent[0]["action"] == "backtest.result"
    assert sent[0]["readOnly"] is True


# -- transport: the mount answers at exactly /mcp, on every app startup -------

_INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"}}}
_HDR = {"Accept": "application/json, text/event-stream",
        "Content-Type": "application/json"}


def _client():
    # 127.0.0.1 because the SDK's DNS-rebinding protection rejects other hosts.
    from auto_trader.api.app import app
    return TestClient(app, base_url="http://127.0.0.1:8000")


def _session(c):
    """Initialize an MCP session; returns headers for follow-up calls."""
    r = c.post("/mcp", json=_INIT, headers=_HDR, follow_redirects=False)
    h = {**_HDR, "mcp-session-id": r.headers["mcp-session-id"],
         "MCP-Protocol-Version": "2025-06-18"}
    c.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=h)
    return h


def _call(c, h, name, args, rid=9):
    return c.post("/mcp", headers=h, json={
        "jsonrpc": "2.0", "id": rid, "method": "tools/call",
        "params": {"name": name, "arguments": args}})


def test_mcp_serves_initialize_at_exactly_slash_mcp():
    with _client() as c:
        r = c.post("/mcp", json=_INIT, headers=_HDR, follow_redirects=False)
    assert r.status_code == 200, r.text  # not a 307 to /mcp/, not a 404
    assert r.headers.get("mcp-session-id")


def test_mcp_lists_the_ui_tools_and_survives_a_second_startup():
    # Two startups: the session manager must be rebuilt per lifespan (it can
    # only be run() once), or the second TestClient would blow up.
    with _client():
        pass
    with _client() as c:
        h = _session(c)
        r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                   headers=h)
    assert sorted(set(re.findall(r'"name":\s?"(ui_\w+)"', r.text))) == [
        "ui_actions", "ui_invoke", "ui_read_state", "ui_sessions", "ui_wait",
    ]


def test_tools_call_over_http_returns_a_result(hub):
    with _client() as c:
        r = _call(c, _session(c), "ui_sessions", {})
    assert r.status_code == 200, r.text
    assert '"isError":true' not in r.text.replace(" ", "")


def test_tools_call_surfaces_the_no_tab_message_as_a_tool_error(hub):
    # The SDK converts the raised RuntimeError into an MCP tool error, so the
    # agent reads the actionable message rather than a transport failure.
    with _client() as c:
        r = _call(c, _session(c), "ui_invoke", {"action": "x", "args": {}})
    assert r.status_code == 200, r.text
    assert '"isError":true' in r.text.replace(" ", "")
    assert "no UI session connected" in r.text
