"""Admin console API (/api/admin/*).

Every route is gated by deps.require_admin_console at the router level. The
console is read-only except for /impersonate, which validates a target and
writes an audit line; it mutates nothing else.

See docs/superpowers/specs/2026-09-11-admin-console-design.md.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from auto_trader.core import clerk_admin, impersonation_audit
from auto_trader.core.admin_health import collect_health
from auto_trader.core.admin_usage import collect_usage
from auto_trader.core.log_buffer import LOG_BUFFER

from ..auth import auth_enabled
from ..deps import current_user, require_admin_console

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin_console)])


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
