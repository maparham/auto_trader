"""Mint a Clerk sign-in token for the Tauri shell's browser-auth handoff.

The shell opens the user's default browser (already signed in to Clerk) at a
handoff page, which POSTs here and forwards the returned single-use token to
the shell's loopback listener. The token can only be minted for the caller's
own verified user id, so this grants nothing the caller does not already have.

Config is CLERK_SECRET_KEY, read per request (same stance as core/clerk_admin)
so tests can monkeypatch without reloading. Unset means 503: the handoff is a
hosted-mode feature. The secret never appears in a response or a log line.
"""
from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..deps import current_user

router = APIRouter()

SECRET_ENV = "CLERK_SECRET_KEY"
API_BASE = "https://api.clerk.com/v1"
TIMEOUT_SECONDS = 10.0
TOKEN_TTL_SECONDS = 300

log = logging.getLogger(__name__)


def _transport():
    """Seam for tests: None means httpx's real transport."""
    return None


@router.post("/api/auth/shell-token")
async def shell_token(user_id: str = Depends(current_user)) -> dict:
    secret = os.environ.get(SECRET_ENV, "").strip()
    if not secret:
        raise HTTPException(503, "sign-in token minting is not configured")
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS, transport=_transport()
        ) as client:
            res = await client.post(
                f"{API_BASE}/sign_in_tokens",
                json={"user_id": user_id, "expires_in_seconds": TOKEN_TTL_SECONDS},
                headers={"Authorization": f"Bearer {secret}"},
            )
    except Exception as exc:  # status only: bodies/exc text can carry secrets
        log.warning("clerk sign-in token mint failed: %s", type(exc).__name__)
        raise HTTPException(502, "Clerk API unreachable")
    if res.status_code >= 400:
        log.warning("clerk sign-in token mint returned %s", res.status_code)
        raise HTTPException(502, f"Clerk API returned {res.status_code}")
    try:
        body = res.json()
    except Exception as exc:  # JSONDecodeError, etc. (status only: no body/secret)
        log.warning("clerk sign-in token mint returned invalid json: %s", type(exc).__name__)
        raise HTTPException(502, "Clerk API returned invalid JSON")
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise HTTPException(502, "Clerk API returned no token")
    return {"token": token}
