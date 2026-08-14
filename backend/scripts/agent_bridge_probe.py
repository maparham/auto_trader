"""End-to-end probe for the Agent UI Bridge.

Prereqs: the backend running (uvicorn auto_trader.api.app:app --port 8000) and,
for anything beyond ui_sessions, the frontend open in a browser (npm run dev,
http://localhost:5173) so a tab is connected. Run:

    cd backend && python3 -m scripts.agent_bridge_probe [--run]
    cd backend && python3 -m scripts.agent_bridge_probe --invoke order.place \
        --args '{"epic": "CS.D.EURUSD.MINI.IP", "side": "buy", "quantity": 1, "type": "market"}'

With no tab connected the ui_* tools return tool errors ("no UI session
connected: open the app in a browser"); the probe prints them and carries on.

Transport: the MCP python client (mcp>=2.0) over streamable HTTP. The /mcp
endpoint has the SDK's DNS-rebinding protection, so the URL host must be
localhost, 127.0.0.1 or [::1] (any other Host header gets a 421).
"""
from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from mcp.client import Client  # mcp>=2.0: dataclass client, URL string = streamable HTTP

DEFAULT_URL = "http://localhost:8000/mcp"
_MISSING = object()  # distinguishes "no structured output" from a structured None


def _structured(res: Any) -> Any:
    """The structured output, or _MISSING when the result has none."""
    sc = getattr(res, "structured_content", None)
    if sc is None:
        sc = getattr(res, "structuredContent", None)
    return _MISSING if sc is None else sc


def _blocks(res: Any) -> list[str]:
    """EVERY text block of the result. A tool returning a list arrives as one
    block per element (ui_actions: one block per action), so joining only the
    first block silently drops most of the answer."""
    return [c.text for c in (getattr(res, "content", None) or []) if hasattr(c, "text")]


def payload(res: Any) -> Any:
    """The tool's return value, whatever shape the SDK wrapped it in.

    Structured output is preferred (tools declare real return types); a lone
    "result" key is the SDK's wrapper for a non-object return and is unwrapped.
    Falls back to the text blocks: each block parsed as JSON where it is JSON,
    collapsing to the single value when there is exactly one block.
    """
    sc = _structured(res)
    if sc is not _MISSING:
        if isinstance(sc, dict) and set(sc) == {"result"}:
            return sc["result"]
        return sc
    parsed = []
    for text in _blocks(res):
        try:
            parsed.append(json.loads(text))
        except (ValueError, TypeError):
            parsed.append(text)
    if not parsed:
        return None
    return parsed[0] if len(parsed) == 1 else parsed


def show(name: str, res: Any) -> Any:
    """Print one tool result in full. Tool errors are printed, not raised.

    Nothing is truncated and no block is skipped: an under-printed manifest
    reads as a missing action.
    """
    marker = " [tool error]" if getattr(res, "is_error", False) else ""
    print(f"\n== {name}{marker} ==")
    sc = _structured(res)
    if sc is not _MISSING:
        print(json.dumps(sc, indent=2, default=str))
    else:
        for text in _blocks(res) or ["(no content)"]:
            print(text)
    return payload(res)


async def main(url: str, run: bool, invoke: str | None, args_json: str) -> None:
    print(f"connecting to {url}")
    async with Client(url) as client:
        tools = await client.list_tools()
        print("tools:", ", ".join(t.name for t in tools.tools))

        show("ui_sessions", await client.call_tool("ui_sessions", {}))
        show("ui_actions", await client.call_tool("ui_actions", {}))
        show(
            "ui_read_state backtest.config.get",
            await client.call_tool("ui_read_state", {"key": "backtest.config.get"}),
        )

        if invoke:
            res = await client.call_tool(
                "ui_invoke", {"action": invoke, "args": json.loads(args_json)}
            )
            await _follow(client, show(f"ui_invoke {invoke}", res), res)

        if run:
            res = await client.call_tool("ui_invoke", {"action": "backtest.run", "args": {}})
            await _follow(client, show("ui_invoke backtest.run", res), res)


async def _follow(client: Client, body: Any, res: Any, max_polls: int = 60) -> None:
    """Poll ui_wait when the invocation returned a long-running handle."""
    if getattr(res, "is_error", False):
        return
    handle = body.get("handle") if isinstance(body, dict) else None
    if not handle:
        print("(immediate result, no handle to poll)")
        return
    print(f"run started, handle={handle}")
    for _ in range(max_polls):
        wres = await client.call_tool("ui_wait", {"handle": handle, "timeout_s": 10})
        if getattr(wres, "is_error", False):
            show("ui_wait", wres)
            return
        st = payload(wres)
        if not isinstance(st, dict):
            show("ui_wait", wres)
            return
        print("status:", st.get("status"), "progress:", st.get("progress"))
        if st.get("status") != "running":
            print("final:", json.dumps(st, indent=2, default=str))
            return
    print(f"gave up after {max_polls} polls; handle {handle} still running")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=DEFAULT_URL, help=f"MCP endpoint (default {DEFAULT_URL})")
    ap.add_argument("--run", action="store_true", help="also trigger backtest.run")
    ap.add_argument("--invoke", help="invoke an arbitrary action by name (e.g. order.place)")
    ap.add_argument("--args", default="{}", help="JSON args for --invoke")
    ns = ap.parse_args()
    asyncio.run(main(ns.url, ns.run, ns.invoke, ns.args))
