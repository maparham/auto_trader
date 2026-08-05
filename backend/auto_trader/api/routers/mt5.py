"""MetaApi (MT5) account deploy lifecycle: the cost toggle.

Undeploying stops MetaApi hosting billing; the account record survives and a
redeploy takes ~1-2 minutes. The broker NEVER auto-deploys (MT5Broker._ensure
raises MT5PausedError instead) — these endpoints are the only in-app path that
deploys the account. Mirrors the compute-host trio in compute.py."""

from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import APIRouter, HTTPException

from .. import deps

router = APIRouter()


async def _lifecycle(action: Callable[[object], Awaitable[str]]) -> dict:
    """Resolve the mt5 broker and run one lifecycle call. No mt5 in the
    registry means MetaApi env vars aren't set: report "unconfigured" (the
    frontend hides the pill) rather than erroring."""
    try:
        broker = deps.get_data("mt5")
    except HTTPException:
        return {"state": "unconfigured", "detail": None}
    try:
        return {"state": await action(broker), "detail": None}
    except Exception as exc:  # SDK error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"MetaApi error: {exc}") from None


@router.get("/api/mt5/deploy-state")
async def mt5_deploy_state() -> dict:
    try:
        broker = deps.get_data("mt5")
    except HTTPException:
        return {"state": "unconfigured", "detail": None, "idle_seconds_remaining": None}
    try:
        state = await broker.deploy_state()
    except Exception as exc:  # SDK error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"MetaApi error: {exc}") from None
    # Countdown only means anything while deployed; hide it otherwise.
    remaining = broker.seconds_until_idle_undeploy() if state == "on" else None
    return {"state": state, "detail": None, "idle_seconds_remaining": remaining}


@router.post("/api/mt5/deploy")
async def mt5_deploy() -> dict:
    return await _lifecycle(lambda b: b.resume())


@router.post("/api/mt5/undeploy")
async def mt5_undeploy() -> dict:
    """No open-position guard here: the frontend confirm warns that positions
    stay open at the broker; a deliberate stop wins (same stance as compute)."""
    return await _lifecycle(lambda b: b.pause())
