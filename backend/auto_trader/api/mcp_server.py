"""MCP server for the Agent UI Bridge, mounted on the FastAPI app at /mcp.

Agents (Claude Code etc.) connect over streamable HTTP and get five tools that
relay to the connected browser tab via agent_bridge.HUB. Errors surface as tool
errors with actionable messages (the MCP SDK converts raised exceptions).

Note: the tools read the module-global `HUB` at call time, so tests can
monkeypatch `mcp_server.HUB` with a fresh BridgeHub.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from mcp.server import MCPServer  # mcp>=2.0 API (1.x called this mcp.server.fastmcp.FastMCP)

from .agent_bridge import HUB, ActionFailedError, NoTabError, TabTimeoutError

mcp = MCPServer("auto-trader-ui")


def _friendly(e: Exception) -> Exception:
    if isinstance(e, ActionFailedError):
        detail = f"{e.code}: {e}"
        if e.expected_schema:
            detail += f" (expected schema: {e.expected_schema})"
        return RuntimeError(detail)
    return RuntimeError(str(e))


@mcp.tool()
async def ui_sessions() -> list[dict]:
    """List connected UI tabs (most recently active first)."""
    return HUB.sessions()


@mcp.tool()
async def ui_actions(session: str | None = None) -> list[dict]:
    """The manifest: every UI action with its name, kind, and JSON schema."""
    try:
        return await HUB.request("manifest", {}, session_id=session)
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


@mcp.tool()
async def ui_invoke(action: str, args: dict | None = None, session: str | None = None) -> object:
    """Invoke a UI action. Fast actions return the result; long-running ones
    (backtest.run, sweep.start) and confirm-kind ones (which wait on a human
    approving a dialog) return {"handle": ...} - poll with ui_wait. A rejected
    confirm surfaces as ui_wait status "error" with "REJECTED: ..."."""
    try:
        return await HUB.request(
            "invoke", {"action": action, "args": args or {}}, session_id=session
        )
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


@mcp.tool()
async def ui_wait(handle: str, timeout_s: float = 60.0) -> dict:
    """Wait for a long-running invocation. Returns {status, progress, result?, error?};
    status "running" after timeout means keep polling."""
    try:
        return await HUB.wait_handle(handle, timeout=timeout_s)
    except KeyError:
        raise RuntimeError(f"unknown handle: {handle} (expired or never issued)") from None


@mcp.tool()
async def ui_read_state(key: str, session: str | None = None) -> object:
    """Shorthand for invoking a read-kind action by name (e.g. backtest.result).

    `readOnly` is enforced by the tab: a key naming a write- or confirm-kind
    action is refused with NOT_READ_ACTION instead of being executed."""
    try:
        return await HUB.request(
            "invoke", {"action": key, "args": {}, "readOnly": True}, session_id=session
        )
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


def mcp_http_app():
    """The streamable-HTTP ASGI app, for mounting at /mcp in app.py.

    A thin shim rather than the SDK's Starlette app: it resolves the session
    manager per request, so the manager can be (re)created by `mcp_session()`
    below. The mount point itself is the endpoint - the agent's URL is exactly
    http://host:8000/mcp, with no /mcp/mcp suffix.
    """

    async def app(scope, receive, send):
        await mcp.session_manager.handle_request(scope, receive, send)

    return app


@asynccontextmanager
async def mcp_session() -> AsyncIterator[None]:
    """Run the streamable-HTTP session manager for the app's lifetime.

    A mounted sub-app's own lifespan never runs, so app.py's lifespan drives
    this. `streamable_http_app()` is called for its side effect: it builds the
    session manager (with the SDK's DNS-rebinding protection) and publishes it
    as `mcp.session_manager`. Building a fresh one per lifespan matters because
    a manager may only be `run()` once - tests that start the app repeatedly
    would otherwise fail on the second startup.
    """
    mcp.streamable_http_app(streamable_http_path="/")
    async with mcp.session_manager.run():
        yield
