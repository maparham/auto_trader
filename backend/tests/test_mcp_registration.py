"""Chartkar's MCP mount: the server answers at exactly /mcp and lists both
tool families (the ten ui_* tools from agent_ui_bridge, plus the direct ones
this repo defines)."""
import re

from fastapi.testclient import TestClient

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


def _tools_list_text():
    # Two startups: the session manager must be rebuilt per lifespan (it can
    # only be run() once), or the second TestClient would blow up.
    with _client():
        pass
    with _client() as c:
        h = _session(c)
        r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                   headers=h)
    return r.text


def test_mcp_serves_initialize_at_exactly_slash_mcp():
    with _client() as c:
        r = c.post("/mcp", json=_INIT, headers=_HDR, follow_redirects=False)
    assert r.status_code == 200, r.text  # not a 307 to /mcp/, not a 404
    assert r.headers.get("mcp-session-id")


def test_mcp_lists_the_ui_tools_and_survives_a_second_startup():
    text = _tools_list_text()
    assert sorted(set(re.findall(r'"name":\s?"(ui_\w+)"', text))) == [
        "ui_actions", "ui_close_tab", "ui_focus_tab", "ui_invoke",
        "ui_open_tab", "ui_read_state", "ui_screenshot", "ui_sessions",
        "ui_set_title", "ui_wait",
    ]


def test_mcp_still_lists_the_direct_tools():
    # The ui_* half moved to agent_ui_bridge; the direct half must not have
    # been collateral damage of that edit.
    text = _tools_list_text()
    names = set(re.findall(r'"name":\s?"(\w+)"', text))
    assert {
        "ta_candles", "ta_indicator_series", "ta_pattern_search", "ta_pattern_scan",
        "ta_pattern_families", "wf_run", "wf_status", "wf_cancel", "wf_fold",
        "runs_list", "run_get",
    } <= names


def test_ui_set_title_description_still_names_the_gate():
    # The docstrings are the agent-visible contract; app_name/screenshot_doc
    # exist so the extraction did not change a word of them.
    text = _tools_list_text()
    assert "REQUIRED before ui_invoke" in text
    assert "Chartkar browser tab to the front" in text


def test_tools_call_over_http_returns_a_result():
    with _client() as c:
        r = _call(c, _session(c), "ui_sessions", {})
    assert r.status_code == 200, r.text
    assert '"isError":true' not in r.text.replace(" ", "")


def test_ui_sessions_tool_is_bound_to_chartkars_hub():
    # The ui_* tools bind to a hub at registration time (agent_bridge.HUB),
    # not per-call, so a session registered directly on that HUB must show up
    # through the tool.
    from auto_trader.api.agent_bridge import HUB

    async def _send(_msg):
        pass

    sid = HUB.register(_send)
    try:
        with _client() as c:
            r = _call(c, _session(c), "ui_sessions", {})
        assert r.status_code == 200, r.text
        assert sid in r.text
    finally:
        HUB.unregister(sid)


def test_tools_call_surfaces_the_no_tab_message_as_a_tool_error():
    # The SDK converts the raised RuntimeError into an MCP tool error, so the
    # agent reads the actionable message rather than a transport failure.
    with _client() as c:
        r = _call(c, _session(c), "ui_invoke", {"action": "x", "args": {}})
    assert r.status_code == 200, r.text
    assert '"isError":true' in r.text.replace(" ", "")
    assert "no UI session connected" in r.text
