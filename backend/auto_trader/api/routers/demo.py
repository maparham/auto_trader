"""Public demo snapshot + admin publish endpoints.

GET /api/demo/snapshot is reachable anonymously through the demo allowlist
(api/demo_access.py); the admin surface is gated exactly like the admin
console. Rollback republishes as a NEW version so history stays append-only.
See docs/superpowers/specs/2026-09-12-public-demo-page-design.md.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auto_trader.core.demo_store import get_demo_store

from ..deps import current_user, require_admin_console

router = APIRouter()
admin_router = APIRouter(
    prefix="/api/admin/demo", dependencies=[Depends(require_admin_console)]
)


@router.get("/api/demo/snapshot")
async def demo_snapshot() -> dict:
    latest = await get_demo_store().latest()
    if latest is None:
        raise HTTPException(404, "no demo published")
    version, payload = latest
    return {"version": version, "payload": json.loads(payload)}


class PublishBody(BaseModel):
    layout: dict
    watchlist: list[str]
    backtests: list[dict] = []


class RollbackBody(BaseModel):
    version: int


async def _validate_watchlist(epics: list[str]) -> None:
    if not epics:
        raise HTTPException(422, "watchlist must not be empty")
    from .. import deps

    broker = deps.get_data("dukascopy")
    bad = []
    for epic in epics:
        meta = await broker.get_market_meta(epic)
        if not meta:
            bad.append(epic)
    if bad:
        raise HTTPException(422, f"unknown dukascopy epics: {', '.join(bad)}")


@admin_router.post("/publish")
async def publish(body: PublishBody, request: Request) -> dict:
    await _validate_watchlist(body.watchlist)
    payload = json.dumps(
        {"layout": body.layout, "watchlist": body.watchlist, "backtests": body.backtests}
    )
    version = await get_demo_store().publish(payload, current_user(request))
    return {"version": version}


@admin_router.get("/versions")
async def versions() -> dict:
    return {"versions": await get_demo_store().versions()}


@admin_router.post("/rollback")
async def rollback(body: RollbackBody, request: Request) -> dict:
    payload = await get_demo_store().get(body.version)
    if payload is None:
        raise HTTPException(404, f"no demo version {body.version}")
    version = await get_demo_store().publish(payload, current_user(request))
    return {"version": version}
