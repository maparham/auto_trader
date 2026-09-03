"""Clerk authentication: JWT verification for the hosted multi-user deployment.

Opt-in via env, exactly like guard.py: CLERK_JWKS_URL unset (local dev) means
no verification anywhere and a fixed dev user id; set (hosted) means every
HTTP request and WebSocket must present a valid Clerk session JWT. Env is read
per request so tests can monkeypatch without reloading the app.

- CLERK_JWKS_URL: Clerk instance JWKS endpoint (https). Presence = hosted mode.
- CLERK_AUTHORIZED_PARTIES: comma-separated allowed `azp` values (the frontend
  origin(s)). Empty = azp unchecked per-request, but install_auth() refuses to
  start in hosted mode (CLERK_JWKS_URL set) unless this is also non-empty.
"""

from __future__ import annotations

import asyncio
import logging
import os

import jwt
from fastapi import FastAPI, Request, WebSocket
from jwt import PyJWKClient
from starlette.responses import JSONResponse

JWKS_URL_ENV = "CLERK_JWKS_URL"
AUTHORIZED_PARTIES_ENV = "CLERK_AUTHORIZED_PARTIES"
ADMIN_EMAILS_ENV = "ADMIN_EMAILS"
ADMIN_USER_IDS_ENV = "ADMIN_USER_IDS"
DEV_USER_ID = "dev"

log = logging.getLogger(__name__)

# Client-visible 401 body. Never interpolate exception text into this: JWKS
# fetch failures can carry urllib error text/hostnames. The real reason is
# logged server-side instead (see verify_token).
INVALID_TOKEN_MSG = "invalid token"


class AuthError(Exception):
    """Token missing/invalid. Message is safe to return to the client."""


# Lazily-built JWKS client, kept for the process lifetime (PyJWKClient caches
# the key set for `lifespan` seconds and refetches on unknown kid). Rebuilt if
# the URL changes so tests can repoint it; tests may also monkeypatch these.
_jwk_client: PyJWKClient | None = None
_jwk_client_url: str | None = None


def _jwks_client(url: str) -> PyJWKClient:
    global _jwk_client, _jwk_client_url
    if _jwk_client is None or _jwk_client_url != url:
        _jwk_client = PyJWKClient(url, cache_keys=True, lifespan=3600)
        _jwk_client_url = url
    return _jwk_client


def auth_enabled() -> bool:
    return bool(os.environ.get(JWKS_URL_ENV))


def _csv_env(name: str) -> list[str]:
    return [p.strip() for p in os.environ.get(name, "").split(",") if p.strip()]


def _authorized_parties() -> list[str]:
    return _csv_env(AUTHORIZED_PARTIES_ENV)


def is_admin_claims(claims: dict) -> bool:
    """Whether the verified claims belong to an admin: `email` claim (present
    only when the Clerk session token is customized to carry it) against
    ADMIN_EMAILS, or `sub` against ADMIN_USER_IDS. Fails closed on both."""
    email = claims.get("email")
    if isinstance(email, str) and email.lower() in {
        e.lower() for e in _csv_env(ADMIN_EMAILS_ENV)
    }:
        return True
    sub = claims.get("sub")
    return isinstance(sub, str) and sub in _csv_env(ADMIN_USER_IDS_ENV)


def _verify_claims(token: str) -> dict:
    """Verify a Clerk session JWT; return its claims dict.

    Raises AuthError on ANY failure — including JWKS fetch problems — so the
    middleware fails closed with a 401 rather than a 500."""
    url = os.environ.get(JWKS_URL_ENV, "")
    try:
        key = _jwks_client(url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            options={"require": ["exp", "sub"]},
            # Clerk session tokens live ~60s and carry nbf; with zero
            # tolerance a server clock a few seconds off Clerk's rejects
            # freshly minted tokens ("not yet valid") or barely-delivered
            # ones. Clerk's own docs recommend ~5s.
            leeway=5,
        )
    except Exception as e:  # PyJWTError, JWKS/network errors: all 401
        log.info("auth failed: token verification error: %s", e)
        raise AuthError(INVALID_TOKEN_MSG) from e
    parties = _authorized_parties()
    if parties and claims.get("azp") not in parties:
        log.info("auth failed: azp %r not in authorized parties", claims.get("azp"))
        raise AuthError(INVALID_TOKEN_MSG)
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        log.info("auth failed: missing or invalid sub claim")
        raise AuthError(INVALID_TOKEN_MSG)
    return claims


def verify_token(token: str) -> str:
    """Verify a Clerk session JWT; return its `sub` (the Clerk user id)."""
    return _verify_claims(token)["sub"]


def install_auth(app: FastAPI) -> None:
    """Register the auth middleware. MUST be called BEFORE app.add_middleware(
    CORSMiddleware, ...) in app.py source order: Starlette stacks later-added
    middleware OUTSIDE earlier, so adding auth first puts CORS around it and
    our 401s carry CORS headers the browser can read (unlike guard.py's gate,
    which is server-to-server only and skips CORS on purpose).

    Sanity-checks env once at install: fails fast if CLERK_JWKS_URL is set
    and not https, or if it's set but CLERK_AUTHORIZED_PARTIES is empty
    (hosted mode requires an explicit azp allowlist). Everything else reads
    env per request."""
    url = os.environ.get(JWKS_URL_ENV)
    if url and not url.startswith("https://"):
        raise RuntimeError(f"{JWKS_URL_ENV} must be an https URL, got {url!r}")
    if url and not _authorized_parties():
        raise RuntimeError(
            f"{AUTHORIZED_PARTIES_ENV} must be set (non-empty) when "
            f"{JWKS_URL_ENV} is set: hosted mode requires an explicit azp "
            "allowlist."
        )

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        if not auth_enabled():
            request.state.user_id = DEV_USER_ID
            request.state.is_admin = True
            return await call_next(request)
        path = request.url.path
        # The MCP bridge is local-only; in hosted mode it does not exist.
        if path == "/mcp" or path.startswith("/mcp/"):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        # Preflights carry no auth by design; /health serves LB probes.
        if request.method == "OPTIONS" or path == "/health":
            return await call_next(request)
        authz = request.headers.get("authorization", "")
        if not authz.startswith("Bearer "):
            return JSONResponse(
                status_code=401, content={"detail": "missing bearer token"}
            )
        try:
            # _verify_claims can block on a JWKS HTTP fetch (cold cache, key
            # rotation); keep that off the event loop.
            claims = await asyncio.to_thread(
                _verify_claims, authz[len("Bearer ") :]
            )
            request.state.user_id = claims["sub"]
            request.state.is_admin = is_admin_claims(claims)
        except AuthError as e:
            return JSONResponse(status_code=401, content={"detail": str(e)})
        return await call_next(request)


WS_AUTH_CLOSE_CODE = 4401  # same app-defined code routers/agent.py already uses


async def verify_ws(websocket: WebSocket) -> str | None:
    """WS counterpart of the HTTP middleware (which never sees WS upgrades).

    Browsers cannot set headers on WebSocket dials, so hosted mode passes the
    short-lived Clerk token as a `token` query param. Returns the user id, or
    closes with 4401 and returns None — callers must bail on None. Safe to
    call before OR after accept(); Starlette turns a pre-accept close into a
    handshake denial."""
    if not auth_enabled():
        websocket.state.is_admin = True
        return DEV_USER_ID
    token = websocket.query_params.get("token", "")
    if token:
        try:
            claims = await asyncio.to_thread(_verify_claims, token)
            websocket.state.is_admin = is_admin_claims(claims)
            return claims["sub"]
        except AuthError:
            pass
    await websocket.close(code=WS_AUTH_CLOSE_CODE)
    return None
