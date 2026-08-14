"""Relay hub for the Agent UI Bridge.

Browser tabs connect over /ws/agent-ui (routers/agent.py) and register a send
callable here. MCP tools (mcp_server.py) call `HUB.request(...)`, which sends a
frame to the target tab and awaits its reply as an asyncio future. Long-running
invocations get a HandleRecord that accumulates progress/done/error events for
`ui_wait` polling. All state is in-memory (same pattern as sweep_jobs.JOBS);
handles are TTL-pruned an hour after completion.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

_HANDLE_TTL_S = 3600.0
_DEFAULT_TIMEOUT_S = 30.0


class NoTabError(Exception):
    """No UI session connected: open the app in a browser."""


class TabTimeoutError(Exception):
    """The tab did not reply within the timeout."""


class ActionFailedError(Exception):
    def __init__(self, code: str, message: str, expected_schema: dict | None = None):
        super().__init__(message)
        self.code = code
        self.expected_schema = expected_schema


@dataclass
class _Tab:
    id: str
    send: Callable[[dict], Awaitable[None]]
    connected_at: float
    last_active: float


@dataclass
class _Handle:
    session_id: str
    status: str = "running"  # running | done | error
    progress: Any = None
    result: Any = None
    error: str | None = None
    finished_at: float | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class BridgeHub:
    def __init__(self) -> None:
        self._tabs: dict[str, _Tab] = {}
        self._pending: dict[str, tuple[str, asyncio.Future]] = {}
        self._handles: dict[str, _Handle] = {}

    # -- tab lifecycle -----------------------------------------------------
    def register(self, send: Callable[[dict], Awaitable[None]]) -> str:
        sid = uuid.uuid4().hex[:12]
        now = time.time()
        self._tabs[sid] = _Tab(id=sid, send=send, connected_at=now, last_active=now)
        return sid

    def unregister(self, session_id: str) -> None:
        self._tabs.pop(session_id, None)
        # Fail only requests that are parked on the disconnecting tab.
        for rid, (target_sid, fut) in list(self._pending.items()):
            if target_sid == session_id:
                if not fut.done():
                    fut.set_exception(NoTabError("UI session disconnected"))
                self._pending.pop(rid, None)
        for h in self._handles.values():
            if h.session_id == session_id and h.status == "running":
                h.status = "error"
                h.error = "UI session disconnected"
                h.finished_at = time.time()
                h.changed.set()

    def touch(self, session_id: str) -> None:
        tab = self._tabs.get(session_id)
        if tab:
            tab.last_active = time.time()

    def sessions(self) -> list[dict]:
        return [
            {"id": t.id, "connectedAt": t.connected_at, "lastActive": t.last_active}
            for t in sorted(self._tabs.values(), key=lambda t: -t.last_active)
        ]

    def _target(self, session_id: str | None) -> _Tab:
        if session_id is not None:
            tab = self._tabs.get(session_id)
            if not tab:
                raise NoTabError(f"no UI session {session_id!r}")
            return tab
        if not self._tabs:
            raise NoTabError("no UI session connected: open the app in a browser")
        return max(self._tabs.values(), key=lambda t: t.last_active)

    # -- request/reply -----------------------------------------------------
    async def request(
        self,
        op: str,
        payload: dict,
        session_id: str | None = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> Any:
        self._prune_handles()
        tab = self._target(session_id)
        rid = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = (tab.id, fut)
        try:
            await tab.send({"id": rid, "op": op, **payload})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise TabTimeoutError(f"tab did not reply within {timeout}s (op={op})") from e
        finally:
            self._pending.pop(rid, None)

    def on_frame(self, session_id: str, frame: dict) -> None:
        self.touch(session_id)
        rid = frame.get("id")
        if rid is not None:
            pending_entry = self._pending.get(rid)
            if pending_entry is None:
                return
            _, fut = pending_entry
            if fut.done():
                return
            if frame.get("ok"):
                if "handle" in frame:
                    self._handles[frame["handle"]] = _Handle(session_id=session_id)
                    fut.set_result({"handle": frame["handle"]})
                else:
                    fut.set_result(frame.get("result"))
            else:
                err = frame.get("error") or {}
                fut.set_exception(ActionFailedError(
                    err.get("code", "ACTION_FAILED"),
                    err.get("message", "action failed"),
                    err.get("expectedSchema"),
                ))
            return
        handle_id = frame.get("handle")
        if handle_id is None:
            return
        h = self._handles.get(handle_id)
        if h is None:
            return
        event = frame.get("event")
        if event == "progress":
            h.progress = frame.get("payload")
        elif event == "done":
            h.status = "done"
            h.result = frame.get("payload")
            h.finished_at = time.time()
        elif event == "error":
            payload = frame.get("payload") or {}
            message = payload.get("message", "action failed")
            code = payload.get("code")
            h.status = "error"
            # Keep the code in the string ui_wait returns: confirm actions now
            # ride the handle path, so REJECTED would otherwise be lost.
            h.error = f"{code}: {message}" if code else message
            h.finished_at = time.time()
        h.changed.set()
        h.changed = asyncio.Event()

    # -- handles -----------------------------------------------------------
    async def wait_handle(self, handle: str, timeout: float) -> dict:
        h = self._handles[handle]  # KeyError -> caller reports unknown handle
        deadline = asyncio.get_running_loop().time() + timeout
        while h.status == "running":
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(h.changed.wait(), remaining)
            except asyncio.TimeoutError:
                break
        out: dict[str, Any] = {"status": h.status, "progress": h.progress}
        if h.status == "done":
            out["result"] = h.result
        if h.status == "error":
            out["error"] = h.error
        return out

    def _prune_handles(self) -> None:
        cutoff = time.time() - _HANDLE_TTL_S
        for hid, h in list(self._handles.items()):
            if h.finished_at is not None and h.finished_at < cutoff:
                self._handles.pop(hid, None)


HUB = BridgeHub()
