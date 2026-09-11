"""Read-only admin console API (/api/admin/*).

Every route is gated by deps.require_admin_console at the router level. The
console is read-only by design: nothing here mutates Clerk, user data or jobs.

See docs/superpowers/specs/2026-09-11-admin-console-design.md.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query, Request

from auto_trader.core import clerk_admin
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
