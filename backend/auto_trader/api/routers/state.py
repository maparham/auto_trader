"""Chart workspace state routes + the live fan-out pub/sub (localStorage mirror)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Query, Request, WebSocket, WebSocketDisconnect

from auto_trader.core.state_store import STATE_STORE

from ..auth import verify_ws
from ..deps import current_user
from ..schemas import StateValue

router = APIRouter()


# Live fan-out: every browser tab/device holding the app open subscribes here, so a
# PUT/DELETE from one is pushed to the others without a reload. This is a simple
# pub/sub registry (unlike /ws/candles, which is per-connection upstream streaming).
# `origin` on each write identifies the writing tab so it can ignore its own echo.
# Keyed socket -> user id, so a broadcast can be scoped to only that user's own
# sockets — never leaking one user's writes to another's tabs.
_state_subscribers: dict[WebSocket, str] = {}

# Max seconds to wait on one client's send before dropping it as too slow/stuck, so
# fan-out (and the writer's request that awaits it) can't be held hostage by one socket.
_BROADCAST_SEND_TIMEOUT = 5.0


async def _send_to(targets: list[WebSocket], message: dict[str, Any]) -> None:
    """Send one message to each target CONCURRENTLY with a per-client timeout
    so a slow/dead client can't block or break the writer's request: a serial
    `await ws.send_json` loop let one slow-but-alive socket apply backpressure
    and stall the PUT/DELETE that awaits this. Clients that error OR time out
    are dropped from the registry."""

    async def _send(ws: WebSocket) -> WebSocket | None:
        try:
            await asyncio.wait_for(ws.send_json(message), timeout=_BROADCAST_SEND_TIMEOUT)
            return None
        except Exception:
            return ws  # errored or too slow → drop it

    results = await asyncio.gather(*(_send(ws) for ws in targets))
    for ws in results:
        if ws is not None:
            _state_subscribers.pop(ws, None)


async def _broadcast_state(user_id: str, message: dict[str, Any]) -> None:
    """Push one change to every subscriber OWNED BY user_id."""
    # Snapshot the matching subset: a concurrent /ws/state connect/disconnect
    # would otherwise mutate the dict during iteration ("dictionary changed
    # size during iteration"). Only sockets belonging to this user are targeted.
    await _send_to(
        [ws for ws, uid in list(_state_subscribers.items()) if uid == user_id], message
    )


async def _broadcast_state_all(message: dict[str, Any]) -> None:
    """Push one message to EVERY subscriber regardless of owner. Only for
    events about genuinely shared, unpartitioned resources (today: the paper
    trading book's trades-dirty ping — until paper accounts are per-user
    partitioned, every signed-in user is looking at the same book). Per-user
    workspace writes must go through _broadcast_state so one user's state
    never reaches another's tabs."""
    await _send_to(list(_state_subscribers), message)


@router.get("/api/state")
async def get_state(request: Request) -> dict[str, Any]:
    """The whole workspace snapshot ({key: parsed JSON value}) for one startup
    hydrate. Keys are the frontend's exact localStorage keys; values are parsed
    back from their stored JSON strings."""
    raw = await STATE_STORE.get_all(current_user(request))
    out: dict[str, Any] = {}
    for k, v in raw.items():
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            continue  # skip a corrupt row rather than fail the whole hydrate
    return out


@router.put("/api/state/{key}", status_code=204)
async def put_state(
    request: Request, key: str, body: StateValue, origin: str = Query("")
) -> None:
    """Upsert one key. Mirrors a single localStorage.setItem from the browser, then
    pushes it to other tabs. `origin` is the writing tab's id (it ignores its echo)."""
    user = current_user(request)
    await STATE_STORE.set(user, key, json.dumps(body.value))
    await _broadcast_state(user, {"key": key, "value": body.value, "origin": origin})


@router.delete("/api/state/{key}", status_code=204)
async def delete_state(request: Request, key: str, origin: str = Query("")) -> None:
    """Remove one key (mirrors localStorage.removeItem / purgeScope), then push the
    removal to other tabs."""
    user = current_user(request)
    await STATE_STORE.delete(user, key)
    await _broadcast_state(user, {"key": key, "deleted": True, "origin": origin})


@router.websocket("/ws/state")
async def ws_state(websocket: WebSocket) -> None:
    """Subscribe to workspace-state changes from other tabs/devices. Each message
    is {key, value, origin} for an upsert or {key, deleted:true, origin} for a
    removal. The client applies it to localStorage and ignores its own origin."""
    user_id = await verify_ws(websocket)
    if user_id is None:
        return
    await websocket.accept()
    _state_subscribers[websocket] = user_id
    try:
        # We never expect client messages; receive() returns/raises on disconnect.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _state_subscribers.pop(websocket, None)
