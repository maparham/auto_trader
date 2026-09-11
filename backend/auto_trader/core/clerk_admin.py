"""Read-only Clerk Backend API client for the admin console's Users panel.

Config is CLERK_SECRET_KEY, read per request (same stance as auth.py) so tests
can monkeypatch without reloading. Unset means "not configured": the caller
gets an empty, non-error result and the panel says so. The secret never
appears in a return value, an error string, or a log line.
"""

from __future__ import annotations

import logging
import os

import httpx

SECRET_ENV = "CLERK_SECRET_KEY"
API_BASE = "https://api.clerk.com/v1"
TIMEOUT_SECONDS = 10.0
MAX_LIMIT = 100

log = logging.getLogger(__name__)


def _secret() -> str:
    return os.environ.get(SECRET_ENV, "").strip()


def configured() -> bool:
    return bool(_secret())


def _transport():
    """Seam for tests: None means httpx's real transport."""
    return None


def map_user(raw: dict) -> dict:
    """Clerk's user object down to the fields the console renders. Nothing
    unmapped survives, so metadata can never leak into the page."""
    primary_id = raw.get("primary_email_address_id")
    email = None
    addresses = raw.get("email_addresses") or []
    for addr in addresses:
        if addr.get("id") == primary_id:
            email = addr.get("email_address")
            break
    if email is None and addresses:
        email = addresses[0].get("email_address")
    return {
        "id": raw.get("id"),
        "email": email,
        "firstName": raw.get("first_name"),
        "lastName": raw.get("last_name"),
        "imageUrl": raw.get("image_url"),
        "createdAt": raw.get("created_at"),
        "lastActiveAt": raw.get("last_active_at"),
        "lastSignInAt": raw.get("last_sign_in_at"),
        "banned": bool(raw.get("banned", False)),
        "locked": bool(raw.get("locked", False)),
    }


async def list_users(limit: int = 50, offset: int = 0, query: str = "") -> dict:
    """One page of users plus the total. Always returns a dict: upstream
    failures come back as `error`, never as an exception."""
    secret = _secret()
    if not secret:
        return {"configured": False, "users": [], "total": 0, "error": None}

    params: dict = {
        "limit": max(1, min(int(limit), MAX_LIMIT)),
        "offset": max(0, int(offset)),
        "order_by": "-created_at",
    }
    if query:
        params["query"] = query
    headers = {"Authorization": f"Bearer {secret}"}
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS, transport=_transport()
        ) as client:
            res = await client.get(f"{API_BASE}/users", params=params, headers=headers)
            if res.status_code >= 400:
                # Status only. The body can echo request details, and the
                # secret must never reach the client or the log.
                return {
                    "configured": True,
                    "users": [],
                    "total": 0,
                    "error": f"Clerk API returned {res.status_code}",
                }
            raw_users = res.json()
            if isinstance(raw_users, dict):  # defensive: some endpoints wrap
                raw_users = raw_users.get("data") or []
            total = len(raw_users)
            count = await client.get(f"{API_BASE}/users/count", headers=headers)
            if count.status_code < 400:
                body = count.json()
                if isinstance(body, dict) and isinstance(body.get("total_count"), int):
                    total = body["total_count"]
    except Exception as exc:
        log.warning("clerk user list failed: %s", type(exc).__name__)
        return {
            "configured": True,
            "users": [],
            "total": 0,
            "error": f"Clerk API unreachable ({type(exc).__name__})",
        }
    return {
        "configured": True,
        "users": [map_user(u) for u in raw_users if isinstance(u, dict)],
        "total": total,
        "error": None,
    }
