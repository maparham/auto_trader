"""Admin console API (/api/admin/*).

Every route is gated by deps.require_admin_console at the router level. The
console is read-only except for /impersonate, which validates a target and
writes an audit line, and /assistant, which sets or clears the assistant
gateway key.

See docs/superpowers/specs/2026-09-11-admin-console-design.md.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from auto_trader.core import clerk_admin, impersonation_audit
from auto_trader.core.admin_health import collect_health
from auto_trader.core.admin_usage import collect_usage
from auto_trader.core.assistant_client import ASSISTANT
from auto_trader.core.assistant_key_store import get_assistant_key_store
from auto_trader.core.log_buffer import LOG_BUFFER

from ..auth import auth_enabled
from ..deps import current_user, require_admin_console

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin_console)])

log = logging.getLogger("auto_trader.admin")


@router.get("/whoami")
async def whoami(request: Request) -> dict:
    """Who the caller is, as the server sees them. The console calls this
    first: 200 means render the panels, 403 means render the denial."""
    claims = getattr(request.state, "claims", None) or {}
    email = claims.get("email")
    return {
        "userId": current_user(request),
        "email": email if isinstance(email, str) else None,
        "isAdmin": True,
        "hostedMode": auth_enabled(),
    }


@router.get("/logs")
async def logs(
    limit: int = Query(200, ge=1, le=1000),
    level: str = Query("DEBUG"),
) -> dict:
    """Recent log records from this process, newest first. See log_buffer for
    what this does and does not cover."""
    return {
        "records": LOG_BUFFER.records(limit=limit, min_level=level),
        "capacity": LOG_BUFFER.capacity,
    }


@router.get("/health")
async def health() -> dict:
    """Process, feeds, brokers, databases and disk, as of now."""
    return collect_health()


@router.get("/usage")
async def usage() -> dict:
    """Per-user row counts and sizes. Counts only: no user content.

    The scan groups over multi-hundred-MB sqlite files, so it runs off the
    event loop: a blocking call here would stall every live alert feed."""
    return {"users": await asyncio.to_thread(collect_usage)}


@router.get("/users")
async def users(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    query: str = Query(""),
) -> dict:
    """Clerk users, read-only. Always 200: an unset secret or an upstream
    failure is reported in the body so the panel can say what is wrong."""
    return await clerk_admin.list_users(limit=limit, offset=offset, query=query)


class ImpersonateRequest(BaseModel):
    user_id: str


@router.post("/impersonate")
async def impersonate(req: ImpersonateRequest, request: Request) -> dict:
    """Start an impersonation session against `user_id`.

    This mints nothing and stores nothing. The browser does the impersonating
    by sending X-Impersonate-User on its own admin token. What this endpoint
    buys is a validated target (a typo cannot start a broken session) and the
    authoritative start-of-session line in the audit log."""
    target = req.user_id.strip()
    if not target:
        raise HTTPException(422, "user_id is required")
    try:
        user = await clerk_admin.get_user(target)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    if user is None:
        raise HTTPException(404, f"no such user '{target}'")
    impersonation_audit.log_start(current_user(request), target)
    return {"user": user}


def _assistant_key_view() -> dict:
    """Where the live assistant key comes from. Never the key itself: only
    its last 4 characters, enough to tell two keys apart."""
    base = ASSISTANT.base_config
    stored = get_assistant_key_store().get()
    disabled = bool(base and base.disabled)
    if stored and not disabled:
        source, key = "dashboard", stored.api_key
    elif base and base.api_key:
        source, key = "env", base.api_key
    else:
        source, key = "none", ""
    return {
        "source": source,
        "last4": key[-4:] if len(key) >= 8 else None,
        "disabled": disabled,
        "envKeySet": bool(base and base.api_key),
        "setBy": stored.set_by if stored else None,
        "setAt": stored.set_at * 1000 if stored else None,
    }


class AssistantKeyRequest(BaseModel):
    api_key: str


@router.get("/assistant")
async def assistant_key() -> dict:
    return await asyncio.to_thread(_assistant_key_view)


@router.put("/assistant")
async def set_assistant_key(req: AssistantKeyRequest, request: Request) -> dict:
    """Verify the key against the gateway, then save it and switch to it
    without a restart. A key the gateway refuses is never saved, so a typo
    cannot take the assistant down. A refusal is a 422, never a 502: the
    Cloudflare edge swaps origin 502s for its own CORS-less page."""
    key = req.api_key.strip()
    if not key:
        raise HTTPException(422, "api_key is required")
    ok, why = await ASSISTANT.verify_key(key)
    if not ok:
        raise HTTPException(422, why)
    who = current_user(request)
    await asyncio.to_thread(get_assistant_key_store().set, key, who)
    ASSISTANT.set_key_override(key)
    log.info("assistant key set from the admin console by %s", who)
    return await asyncio.to_thread(_assistant_key_view)


@router.delete("/assistant")
async def clear_assistant_key(request: Request) -> dict:
    """Drop the saved key; the assistant goes back to ASSISTANT_API_KEY."""
    await asyncio.to_thread(get_assistant_key_store().clear)
    ASSISTANT.set_key_override(None)
    log.info("assistant key cleared from the admin console by %s", current_user(request))
    return await asyncio.to_thread(_assistant_key_view)
