"""MCP server for the Agent UI Bridge, mounted on the FastAPI app at /mcp.

Agents (Claude Code etc.) connect over streamable HTTP and get two families of
tools. The `ui_*` tools relay to the connected browser tab via agent_bridge.HUB
(six tools today: sessions, actions, invoke, wait, read_state, screenshot).
The direct (no-tab) tools call the app's own REST routes in-process over
httpx.ASGITransport, configured via `configure_direct_tools`: `ta_*` (candles,
indicator series, pattern search/scan/families), `wf_*` (run/status/cancel/
fold a walk-forward job), and `runs_list`/`run_get` (the backtest/sweep/
walkforward archives). Errors surface as tool errors with actionable messages
(the MCP SDK converts raised exceptions).

Note: the tools read the module-global `HUB` at call time, so tests can
monkeypatch `mcp_server.HUB` with a fresh BridgeHub.
"""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from mcp.server import MCPServer  # mcp>=2.0 API (1.x called this mcp.server.fastmcp.FastMCP)
from mcp.types import ImageContent, TextContent

from .agent_bridge import HUB, ActionFailedError, NoTabError, TabTimeoutError
from .guard import API_TOKEN_ENV

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


@mcp.tool()
async def ui_screenshot(session: str | None = None) -> list:
    """Screenshot of the focused chart in the connected tab, as an image the
    client renders natively. Pairs with ui_read_state("chart.state") for the
    numbers behind the pixels."""
    try:
        res = await HUB.request(
            "invoke",
            {"action": "chart.screenshot", "args": {}, "readOnly": True},
            session_id=session,
        )
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e
    return [
        ImageContent(type="image", data=res["image_base64"], mimeType=res["mime"]),
        TextContent(
            type="text",
            text=f"{res['epic']} {res['resolution']} (cell {res['cellId']})",
        ),
    ]


_ASGI_APP = None


def configure_direct_tools(app) -> None:
    """Give the direct (no-tab) tools the FastAPI app to call in-process."""
    global _ASGI_APP
    _ASGI_APP = app


def _auth_headers() -> dict:
    """Authorization header for the in-process call, mirroring what a real
    client would send against guard.token_ok. Only attached when API_TOKEN is
    actually configured, so a local/dev deployment (no REQUIRE_API_TOKEN, no
    API_TOKEN) sends no header at all. Read at call time (not import time) so
    tests can monkeypatch the env without reloading the module."""
    token = os.environ.get(API_TOKEN_ENV, "")
    return {"Authorization": f"Bearer {token}"} if token else {}


# Every job_id/run_id in this codebase is uuid.uuid4().hex (32 lowercase hex
# chars: sweep_jobs.py, wfo_jobs.py, routers/backtest.py's run_id). This
# pattern is intentionally a little looser than that (the full URL-safe
# unreserved set, not just hex) so a legitimate future id scheme isn't broken
# by drift, while still rejecting the characters that let an agent-supplied
# id, f-string'd straight into a URL path, escape the intended route: "/",
# "\\", "..", "#", "?", and whitespace all fall outside this set.
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _path_id(value: str) -> str:
    """Validate an id headed into an f-string'd URL path segment.

    httpx normalizes dot segments in a URL, so an unvalidated id like
    "../../../admin/users#" reaches a completely different route (here,
    GET /api/admin/users) than the one the tool intends. Raises ValueError on
    anything that isn't a single safe path segment; callers let that surface
    as a normal tool error.
    """
    if not isinstance(value, str) or not _SAFE_ID_RE.match(value):
        raise ValueError(f"invalid id: {value!r}")
    return value


async def _api_get(path: str, params: dict) -> object:
    if _ASGI_APP is None:
        raise RuntimeError("direct tools not configured (server still starting?)")
    clean = {k: v for k, v in params.items() if v is not None}
    transport = httpx.ASGITransport(app=_ASGI_APP)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        r = await client.get(path, params=clean, headers=_auth_headers())
    if r.status_code >= 400:
        try:
            body = r.json()
        except ValueError:
            body = r.text
        detail = body.get("detail", body) if isinstance(body, dict) else body
        raise RuntimeError(f"{path} -> {r.status_code}: {detail}")
    return r.json()


@mcp.tool()
async def ta_candles(
    epic: str, resolution: str = "HOUR", bars: int = 200,
    broker: str | None = None, from_ts: int | None = None, to_ts: int | None = None,
) -> object:
    """OHLCV candles for an epic (no browser tab needed). from_ts/to_ts are
    unix seconds; without them the most recent `bars` are returned."""
    return await _api_get("/api/candles", {
        "epic": epic, "resolution": resolution, "bars": bars,
        "broker": broker, "from_ts": from_ts, "to_ts": to_ts,
    })


@mcp.tool()
async def ta_indicator_series(
    epic: str, indicator: str, resolution: str = "HOUR",
    length: int | None = None, bars: int = 500, broker: str | None = None,
) -> object:
    """A named indicator series (RSI, EMA, ATR, SR_LEVELS, PIVOT_BANDS, ...)
    computed server-side over the epic's candles, aligned to timestamps."""
    return await _api_get("/api/indicators/series", {
        "epic": epic, "indicator": indicator, "resolution": resolution,
        "length": length, "bars": bars, "broker": broker,
    })


async def _api_post(path: str, body: dict) -> object:
    if _ASGI_APP is None:
        raise RuntimeError("direct tools not configured (server still starting?)")
    transport = httpx.ASGITransport(app=_ASGI_APP)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        r = await client.post(path, json=body, headers=_auth_headers())
    if r.status_code >= 400:
        try:
            body_json = r.json()
        except ValueError:
            body_json = r.text
        detail = body_json.get("detail", body_json) if isinstance(body_json, dict) else body_json
        raise RuntimeError(f"{path} -> {r.status_code}: {detail}")
    return r.json()


@mcp.tool()
async def ta_pattern_search(body: dict) -> object:
    """Pattern search: find historical windows shaped like a user-selected
    sequence (no browser tab needed). `body` is the same JSON the REST route
    POST /api/patterns/search takes, verbatim. An invalid body comes back as a
    422 with FastAPI's field-level schema errors; fix and retry."""
    return await _api_post("/api/patterns/search", body)


@mcp.tool()
async def ta_pattern_scan(body: dict) -> object:
    """Pattern scan across markets for known families/presets (no browser tab
    needed). `body` is the same JSON the REST route POST /api/patterns/scan
    takes, verbatim. An invalid body comes back as a 422 with FastAPI's
    field-level schema errors; fix and retry."""
    return await _api_post("/api/patterns/scan", body)


@mcp.tool()
async def ta_pattern_families() -> object:
    """The scan's available pattern families and preset definitions."""
    return await _api_get("/api/patterns/families", {})


_ARCHIVES = {
    "backtest": "/api/backtest/runs",
    "sweep": "/api/backtest/sweeps",
    "walkforward": "/api/backtest/walkforward/archive",
}


@mcp.tool()
async def wf_run(body: dict) -> object:
    """Start a walk-forward job (POST /api/backtest/walkforward/jobs). `body`
    is a BacktestRequest: required fields are epic, resolution, candles,
    series, costs, tradeFromTime, plus a walkforward block (combos, axes,
    schedule) - the endpoint 422s without candles or walkforward.combos.
    candles can be paged from ta_candles (1000-bar cap per call; page with
    from_ts/to_ts). Returns {jobId, total, schemes}; poll wf_status(jobId)
    until its phase is "done" (status also exposes running/foldRows/result)."""
    return await _api_post("/api/backtest/walkforward/jobs", body)


@mcp.tool()
async def wf_status(job_id: str, cursor: int = 0) -> object:
    """Walk-forward job status + incremental fold rows from cursor."""
    return await _api_get(f"/api/backtest/walkforward/jobs/{_path_id(job_id)}", {"cursor": cursor})


@mcp.tool()
async def wf_cancel(job_id: str) -> object:
    """Cancel a running walk-forward job."""
    return await _api_post(f"/api/backtest/walkforward/jobs/{_path_id(job_id)}/cancel", {})


@mcp.tool()
async def wf_fold(job_id: str, key: str) -> object:
    """Detail for one fold of a walk-forward job."""
    # key rides the query string (params=), which httpx percent-encodes, so
    # it can't escape the path the way job_id (f-string'd directly) could.
    return await _api_get(f"/api/backtest/walkforward/jobs/{_path_id(job_id)}/fold", {"key": key})


@mcp.tool()
async def runs_list(kind: str = "backtest", epic: str | None = None, limit: int = 20) -> object:
    """List archived runs. kind: backtest, sweep, walkforward."""
    base = _ARCHIVES.get(kind)
    if base is None:
        raise ValueError(f"unknown kind: {kind} (one of {', '.join(sorted(_ARCHIVES))})")
    return await _api_get(base, {"epic": epic, "limit": limit})


@mcp.tool()
async def run_get(kind: str, run_id: str) -> object:
    """One archived run's full record."""
    base = _ARCHIVES.get(kind)
    if base is None:
        raise ValueError(f"unknown kind: {kind} (one of {', '.join(sorted(_ARCHIVES))})")
    return await _api_get(f"{base}/{_path_id(run_id)}", {})


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
