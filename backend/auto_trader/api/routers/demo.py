"""Public demo snapshot + admin publish endpoints.

GET /api/demo/snapshot is reachable anonymously through the demo allowlist
(api/demo_access.py); the admin surface is gated exactly like the admin
console. The store stays append-only (every publish is a new row, latest
wins), but the admin panel no longer surfaces that history: there is one live
demo, replaced by the next publish. `GET /versions` remains so the panel can
show when the live one went out; there is deliberately no rollback endpoint,
because an "undo" the UI cannot reach is just an unused attack surface.
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
    # The data broker demo visitors are served on. Must be one of
    # deps.DEMO_BROKERS (the credential-free read-only pair); the default keeps
    # payloads published before this field existed on dukascopy. New publishes
    # from the app always send "yfinance" (it covers stocks, dukascopy does
    # not) - see frontend lib/demoPublish.ts.
    broker: str = "dukascopy"
    # Optional: nothing in the demo UI reads the published watchlist any more
    # (the symbol modal browses the whole catalogue), so an empty list is a
    # perfectly good publish. Non-empty lists are still validated.
    watchlist: list[str] = []
    backtests: list[dict] = []


async def _validate_watchlist(epics: list[str], broker_id: str) -> None:
    if not epics:
        return
    from .. import deps

    broker = deps.get_data(broker_id)
    bad = []
    for epic in epics:
        meta = await broker.get_market_meta(epic)
        if not meta:
            bad.append(epic)
    if bad:
        raise HTTPException(422, f"unknown {broker_id} epics: {', '.join(bad)}")


@admin_router.post("/publish")
async def publish(body: PublishBody, request: Request) -> dict:
    # An empty layout means the admin's workspace had no saved named layout to
    # capture; publishing it would leave visitors on the built-in fallback
    # chart with no error to explain why.
    if not body.layout:
        raise HTTPException(422, "layout is empty: save the workspace layout, then publish")
    from .. import deps

    if body.broker not in deps.DEMO_BROKERS:
        raise HTTPException(
            422, f"demo broker must be one of: {', '.join(sorted(deps.DEMO_BROKERS))}"
        )
    await _validate_watchlist(body.watchlist, body.broker)
    payload = json.dumps(
        {
            "layout": body.layout,
            "broker": body.broker,
            "watchlist": body.watchlist,
            "backtests": body.backtests,
        }
    )
    version = await get_demo_store().publish(payload, current_user(request))
    return {"version": version}


@admin_router.get("/versions")
async def versions() -> dict:
    return {"versions": await get_demo_store().versions()}

