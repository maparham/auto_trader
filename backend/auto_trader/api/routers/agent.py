"""Agent UI Bridge relay routes: the tab-side WebSocket and a sessions probe."""
from __future__ import annotations

import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..agent_bridge import HUB
from ..auth import verify_ws
from ..guard import REQUIRE_TOKEN_ENV, cors_origins, token_ok

router = APIRouter()

WS_AUTH_CLOSE_CODE = 4401  # app-defined close code: the http 401 has no ws equivalent
WS_ORIGIN_CLOSE_CODE = 4403  # app-defined: origin not in the CORS allowlist


@router.get("/api/agent/sessions")
async def agent_sessions() -> dict:
    return {"sessions": HUB.sessions()}


@router.websocket("/ws/agent-ui")
async def ws_agent_ui(websocket: WebSocket) -> None:
    """A browser tab's bridge connection. Frames FROM the tab are replies and
    handle events; frames TO the tab are invoke/manifest/abort requests sent by
    HUB.request. (Same accept/registry/finally shape as /ws/state.)

    guard.install_guards registers an http-only middleware, so REQUIRE_API_TOKEN
    would never reach a WebSocket. Enforce the same bearer check here, before
    accept and before touching the HUB, so a rejected tab never registers.

    Origin is checked the same way: WebSockets are exempt from CORS, so without
    this any webpage the user visits could open the command channel and drive
    the app. A *browser* always sends Origin, so requiring it to be in the CORS
    allowlist blocks that; an absent Origin (curl, the probe script, tests) is
    a non-browser client and stays allowed."""
    if os.environ.get(REQUIRE_TOKEN_ENV) == "1" and not token_ok(
        websocket.headers.get("authorization")
    ):
        await websocket.close(code=WS_AUTH_CLOSE_CODE)
        return
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in cors_origins():
        await websocket.close(code=WS_ORIGIN_CLOSE_CODE)
        return
    if await verify_ws(websocket) is None:
        return
    await websocket.accept()
    sid = HUB.register(websocket.send_json)
    try:
        while True:
            frame = await websocket.receive_json()
            HUB.on_frame(sid, frame)
    except WebSocketDisconnect:
        pass
    finally:
        HUB.unregister(sid)
