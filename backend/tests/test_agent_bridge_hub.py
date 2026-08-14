"""BridgeHub: invocation futures, handle store, session routing."""
import asyncio

import pytest

from auto_trader.api.agent_bridge import (
    ActionFailedError, BridgeHub, NoTabError, TabTimeoutError,
)


def make_tab(hub: BridgeHub):
    """A fake tab: captures outbound frames; test feeds replies via hub.on_frame."""
    sent: list[dict] = []

    async def send(frame: dict) -> None:
        sent.append(frame)

    sid = hub.register(send)
    return sid, sent


async def _reply_ok(hub, sid, sent, result):
    while not sent:
        await asyncio.sleep(0)
    frame = sent[-1]
    hub.on_frame(sid, {"id": frame["id"], "ok": True, "result": result})


@pytest.mark.anyio
async def test_request_roundtrip():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "a", "args": {}}))
    await _reply_ok(hub, sid, sent, {"x": 1})
    assert await task == {"x": 1}
    assert sent[0]["op"] == "invoke" and sent[0]["action"] == "a"


@pytest.mark.anyio
async def test_no_tab_error():
    hub = BridgeHub()
    with pytest.raises(NoTabError):
        await hub.request("manifest", {})


@pytest.mark.anyio
async def test_error_reply_raises_action_failed():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "a", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    hub.on_frame(sid, {"id": sent[-1]["id"], "ok": False,
                       "error": {"code": "INVALID_ARGS", "message": "bad", "expectedSchema": {"type": "object"}}})
    with pytest.raises(ActionFailedError) as ei:
        await task
    assert ei.value.code == "INVALID_ARGS"
    assert ei.value.expected_schema == {"type": "object"}


@pytest.mark.anyio
async def test_timeout():
    hub = BridgeHub()
    make_tab(hub)
    with pytest.raises(TabTimeoutError):
        await hub.request("invoke", {"action": "a", "args": {}}, timeout=0.05)


@pytest.mark.anyio
async def test_targets_most_recently_active_tab():
    hub = BridgeHub()
    sid1, sent1 = make_tab(hub)
    sid2, sent2 = make_tab(hub)
    hub.touch(sid1)  # tab 1 active most recently
    task = asyncio.ensure_future(hub.request("manifest", {}))
    await _reply_ok(hub, sid1, sent1, [])
    await task
    assert sent1 and not sent2


@pytest.mark.anyio
async def test_handle_lifecycle():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "slow", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    assert await task == {"handle": rid}
    hub.on_frame(sid, {"handle": rid, "event": "progress", "payload": {"pct": 40}})
    st = await hub.wait_handle(rid, timeout=0.05)
    assert st["status"] == "running" and st["progress"] == {"pct": 40}
    hub.on_frame(sid, {"handle": rid, "event": "done", "payload": {"pnl": 5}})
    st = await hub.wait_handle(rid, timeout=1.0)
    assert st["status"] == "done" and st["result"] == {"pnl": 5}


@pytest.mark.anyio
async def test_handle_error_event_keeps_the_code():
    """Confirm actions ride the handle path, so REJECTED must survive into
    ui_wait's error string - the code is all that distinguishes a user saying
    no from the handler blowing up."""
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "deal", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    await task
    hub.on_frame(sid, {
        "handle": rid, "event": "error",
        "payload": {"code": "REJECTED", "message": "user rejected"},
    })
    st = await hub.wait_handle(rid, timeout=1.0)
    assert st["status"] == "error"
    assert st["error"] == "REJECTED: user rejected"


@pytest.mark.anyio
async def test_handle_error_event_without_code_is_the_bare_message():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "slow", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    await task
    hub.on_frame(sid, {"handle": rid, "event": "error", "payload": {"message": "kaput"}})
    st = await hub.wait_handle(rid, timeout=1.0)
    assert st["error"] == "kaput"


@pytest.mark.anyio
async def test_disconnect_fails_open_requests_and_handles():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "slow", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    await task
    hub.unregister(sid)
    st = await hub.wait_handle(rid, timeout=0.05)
    assert st["status"] == "error"
    assert "disconnected" in st["error"]


@pytest.mark.anyio
async def test_unregister_scoped_to_target_tab():
    """Pending requests to one tab survive other tabs' disconnect."""
    hub = BridgeHub()
    sid_a, sent_a = make_tab(hub)
    sid_b, sent_b = make_tab(hub)
    sid_c, sent_c = make_tab(hub)

    # Start request to tab A, wait only until frame is sent (still pending)
    task_a = asyncio.ensure_future(hub.request("invoke", {"action": "a", "args": {}}, session_id=sid_a))
    while not sent_a:
        await asyncio.sleep(0)
    rid_a = sent_a[-1]["id"]

    # Unregister tab B while A's request is still pending
    hub.unregister(sid_b)

    # A's request should still resolve normally (not failed by B's disconnect)
    hub.on_frame(sid_a, {"id": rid_a, "ok": True, "result": {"result_a": 1}})
    assert await task_a == {"result_a": 1}

    # Separately: request to tab C should fail when C itself unregisters
    task_c = asyncio.ensure_future(hub.request("invoke", {"action": "c", "args": {}}, session_id=sid_c))
    while not sent_c:
        await asyncio.sleep(0)
    hub.unregister(sid_c)
    with pytest.raises(NoTabError) as ei:
        await task_c
    assert "disconnected" in str(ei.value)
