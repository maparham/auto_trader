"""`/api/alerts` CRUD + triggered-history endpoints.

Thin HTTP layer over `AlertStore` (persistence) and `AlertEngine` (live tick
evaluation registry). Every successful mutation both notifies the engine (so
its in-memory registry stays in sync with what's stored) and broadcasts a
`__alerts__:changed` ping on `/ws/state` (so other tabs/devices refetch),
mirroring the `origin`-echo convention `/api/state` uses.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from auto_trader.core.alert_engine import ALERT_ENGINE
from auto_trader.core.alert_store import ALERT_STORE

from ..deps import current_user
from .state import broadcast_to_user

router = APIRouter()

_ID_RE = re.compile(r"^al-[A-Za-z0-9-]{1,64}$")
_KINDS = {"price_level"}
_CONDITIONS = {"crossing", "crossing_up", "crossing_down", "greater", "less"}
_TRIGGERS = {"once", "every"}
_NOTIFY_CHANNELS = ("toast", "browser", "sound", "push", "telegram")


def _validate_id(alert_id: str) -> None:
    if not _ID_RE.match(alert_id):
        raise HTTPException(422, f"invalid alert id: {alert_id!r}")


def _validate_kind(kind: str) -> None:
    if kind not in _KINDS:
        raise HTTPException(422, f"unknown alert kind: {kind!r}")


def _validate_params(kind: str, params: dict[str, Any]) -> None:
    if kind != "price_level":
        return
    level = params.get("level")
    # Strict type check (not just float()-coercible): a JSON string like "100"
    # would otherwise pass float("100") and land in the stored row as a str —
    # evaluate_alert's math.isfinite(level) then raises TypeError deep inside
    # AlertEngine.on_tick, silently killing that feed (caught by _feed_loop's
    # broad except, logged-and-backed-off forever with no user-visible error).
    if isinstance(level, bool) or not isinstance(level, (int, float)):
        raise HTTPException(422, "params.level must be a finite number")
    if not math.isfinite(level):
        raise HTTPException(422, "params.level must be a finite number")
    condition = params.get("condition")
    if condition not in _CONDITIONS:
        raise HTTPException(422, f"unknown condition: {condition!r}")
    trigger = params.get("trigger")
    if trigger not in _TRIGGERS:
        raise HTTPException(422, f"unknown trigger: {trigger!r}")


class CreateAlertBody(BaseModel):
    id: str
    broker: str
    epic: str
    kind: str
    params: dict[str, Any]
    message: str = ""
    expires_at: int | None = None
    notify: dict[str, bool] | None = None
    precision: int = 2


class PatchAlertBody(BaseModel):
    params: dict[str, Any] | None = None
    message: str | None = None
    expires_at: int | None = None
    notify: dict[str, bool] | None = None
    precision: int | None = None


class TriggeredSeenBody(BaseModel):
    time: int


async def _notify(request: Request, row: dict | None, alert_id: str, broker: str, epic: str, origin: str) -> None:
    user = current_user(request)
    ALERT_ENGINE.on_alert_changed(user, row, alert_id)
    await broadcast_to_user(
        user, {"key": "__alerts__:changed", "value": {"broker": broker, "epic": epic, "origin": origin}}
    )


@router.get("/api/alerts")
async def list_alerts(request: Request) -> dict[str, Any]:
    rows = await ALERT_STORE.list_user(current_user(request))
    return {"alerts": rows}


@router.post("/api/alerts")
async def create_alert(request: Request, body: CreateAlertBody, origin: str = Query("")) -> dict[str, Any]:
    _validate_id(body.id)
    _validate_kind(body.kind)
    _validate_params(body.kind, body.params)

    notify = {ch: True for ch in _NOTIFY_CHANNELS}
    if body.notify:
        notify.update(body.notify)

    user = current_user(request)
    now = int(time.time() * 1000)
    row = {
        "id": body.id,
        "broker": body.broker,
        "epic": body.epic,
        "kind": body.kind,
        "params": body.params,
        "message": body.message,
        "expires_at": body.expires_at,
        "notify": notify,
        "precision": body.precision,
        "active": 1,
        "created_at": now,
        "updated_at": now,
    }
    try:
        saved = await ALERT_STORE.create(user, row)
    except ValueError:
        raise HTTPException(409, f"alert id already exists: {body.id}") from None

    await _notify(request, saved, saved["id"], saved["broker"], saved["epic"], origin)
    return saved


@router.get("/api/alerts/triggered")
async def get_triggered(request: Request) -> dict[str, Any]:
    user = current_user(request)
    entries = await ALERT_STORE.list_triggered(user)
    seen_raw = await ALERT_STORE.get_meta(user, "triggered_seen")
    seen = int(seen_raw) if seen_raw is not None else 0
    return {"entries": entries, "seen": seen}


@router.post("/api/alerts/triggered/seen", status_code=204)
async def set_triggered_seen(request: Request, body: TriggeredSeenBody) -> None:
    user = current_user(request)
    await ALERT_STORE.set_meta(user, "triggered_seen", str(body.time))


@router.delete("/api/alerts/triggered", status_code=204)
async def clear_triggered(request: Request) -> None:
    user = current_user(request)
    await ALERT_STORE.clear_triggered(user)


# The fixed-path /api/alerts/triggered* routes above must be registered
# BEFORE these {alert_id} routes — FastAPI matches path operations in
# registration order, and a {alert_id} route would otherwise swallow
# "triggered" as an id.


@router.patch("/api/alerts/{alert_id}")
async def patch_alert(
    request: Request, alert_id: str, body: PatchAlertBody, origin: str = Query("")
) -> dict[str, Any]:
    user = current_user(request)
    # Drop explicit nulls for every field except expires_at (where null is
    # meaningful: "clear the expiry"). params/message/notify/precision map to
    # NOT NULL columns — passing None through to AlertStore.update would
    # store the literal string "null" (params/notify, via json.dumps(None))
    # or trip a sqlite IntegrityError (message/precision) — either way an
    # uncaught 500, plus a stored params=None that later crashes the engine's
    # _alert_sig(params).get(...) on the next tick.
    patch = {
        k: v for k, v in body.model_dump(exclude_unset=True).items()
        if v is not None or k == "expires_at"
    }
    if "params" in patch:
        existing = await ALERT_STORE.list_user(user)
        kind = next((r["kind"] for r in existing if r["id"] == alert_id), "price_level")
        _validate_params(kind, patch["params"])

    saved = await ALERT_STORE.update(user, alert_id, patch)
    if saved is None:
        raise HTTPException(404, f"alert not found: {alert_id}")

    await _notify(request, saved, saved["id"], saved["broker"], saved["epic"], origin)
    return saved


@router.delete("/api/alerts/{alert_id}", status_code=204)
async def delete_alert(request: Request, alert_id: str, origin: str = Query("")) -> None:
    user = current_user(request)
    # Fetch the row first (for broker/epic in the notify/broadcast payload)
    # before it's gone.
    existing = await ALERT_STORE.list_user(user)
    row = next((r for r in existing if r["id"] == alert_id), None)
    if row is None:
        raise HTTPException(404, f"alert not found: {alert_id}")

    deleted = await ALERT_STORE.delete(user, alert_id)
    if not deleted:
        raise HTTPException(404, f"alert not found: {alert_id}")

    await _notify(request, None, alert_id, row["broker"], row["epic"], origin)
