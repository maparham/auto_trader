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

from auto_trader.api.demo_access import DEMO_USER_ID, demo_path_allowed
from auto_trader.api.demo_limit import client_key, demo_rate_ok
from auto_trader.core import impersonation_audit

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


IMPERSONATE_HEADER = "X-Impersonate-User"
IMPERSONATE_PARAM = "impersonate"

# Impersonation never authorizes a write. The admin's own token is still the
# credential on the wire, so a mutating method would be indistinguishable from
# the admin acting on their own account at the storage layer.
_IMPERSONATION_SAFE_METHODS = ("GET", "HEAD")


class ImpersonationError(Exception):
    """An impersonation attempt that must be refused. `message` is safe to
    return to the client: it names the rule, never the caller or the target."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def resolve_impersonation(
    claims: dict, raw_target: str, method: str
) -> tuple[str, bool, str | None]:
    """Resolve the effective identity for a verified caller.

    Returns (user_id, is_admin, impersonator). With no target this is the
    caller's own identity unchanged. With a target it is the target, with
    is_admin forced False (so /api/admin/* refuses the session) and the real
    admin id carried through for the audit trail.

    A non-admin naming a target is an error, never a silent fallback to self:
    a bug that quietly served the caller their own data would look like a
    working feature right up until it served the wrong user's."""
    real_sub = claims.get("sub", "")
    target = (raw_target or "").strip()
    if not target:
        return real_sub, is_admin_claims(claims), None
    if not is_admin_claims(claims):
        raise ImpersonationError("impersonation requires admin access")
    if method.upper() not in _IMPERSONATION_SAFE_METHODS:
        raise ImpersonationError("impersonation is read-only")
    return target, False, real_sub


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
            request.state.is_demo = False
            request.state.claims = {}
            request.state.impersonator = None
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
            # Signed-out visitor: the demo principal covers a narrow GET-only
            # allowlist (see demo_access.py); everything else keeps the 401.
            if demo_path_allowed(request.method, path):
                demo_target = request.headers.get(IMPERSONATE_HEADER, "").strip()
                if demo_target:
                    # The demo principal can never be admin, same as the
                    # render-token branch below: refuse rather than silently
                    # ignore the header. Reachable with no credential at all
                    # and ahead of demo_rate_ok below, so cap what we log.
                    impersonation_audit.log_rejected(
                        "demo principal",
                        DEMO_USER_ID,
                        demo_target[: impersonation_audit.MAX_LOGGED_VALUE_LEN],
                    )
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "impersonation requires admin access"},
                    )
                client_ip = client_key(request)
                if not demo_rate_ok(client_ip):
                    return JSONResponse(
                        status_code=429, content={"detail": "demo rate limit"}
                    )
                request.state.user_id = DEMO_USER_ID
                request.state.is_admin = False
                request.state.is_demo = True
                request.state.claims = {}
                request.state.impersonator = None
                return await call_next(request)
            return JSONResponse(
                status_code=401, content={"detail": "missing bearer token"}
            )
        token = authz[len("Bearer ") :]
        internal_sub = verify_render_token(token)
        if internal_sub is not None:
            # The render token exists solely so the headless snapshot page can
            # READ as the alerted user; it must never authorize orders/writes,
            # and it travels in a URL query string (see verify_ws) so it's
            # more exposed than a header-only bearer token. Restrict it to
            # safe, read-only methods.
            if request.method not in ("GET", "HEAD"):
                return JSONResponse(status_code=401, content={"detail": INVALID_TOKEN_MSG})
            render_target = request.headers.get(IMPERSONATE_HEADER, "").strip()
            if render_target:
                impersonation_audit.log_rejected(
                    "render token",
                    internal_sub,
                    render_target[: impersonation_audit.MAX_LOGGED_VALUE_LEN],
                )
                return JSONResponse(
                    status_code=403,
                    content={"detail": "impersonation requires admin access"},
                )
            request.state.user_id = internal_sub
            request.state.is_admin = False
            # is_render lets deps.resolve_broker grant READ access to
            # restricted data brokers (the alerted user's chart is usually on
            # one); dealing and /api/admin/* stay refused via is_admin False,
            # and the GET/HEAD gate above bounds it to reads.
            request.state.is_render = True
            request.state.is_demo = False
            request.state.claims = {}
            request.state.impersonator = None
            return await call_next(request)
        raw_target = request.headers.get(IMPERSONATE_HEADER, "")
        try:
            # _verify_claims can block on a JWKS HTTP fetch (cold cache, key
            # rotation); keep that off the event loop.
            claims = await asyncio.to_thread(_verify_claims, token)
            user_id, is_admin, impersonator = resolve_impersonation(
                claims, raw_target, request.method
            )
            request.state.user_id = user_id
            request.state.is_admin = is_admin
            request.state.is_demo = False
            request.state.impersonator = impersonator
            # The admin console reads the `email` claim from here (whoami).
            request.state.claims = claims
            if impersonator:
                impersonation_audit.log_request(impersonator, user_id, request.url.path)
        except AuthError as e:
            return JSONResponse(status_code=401, content={"detail": str(e)})
        except ImpersonationError as e:
            impersonation_audit.log_rejected(
                e.message,
                claims.get("sub", "?") if isinstance(claims, dict) else "?",
                raw_target[: impersonation_audit.MAX_LOGGED_VALUE_LEN],
            )
            return JSONResponse(status_code=403, content={"detail": e.message})
        return await call_next(request)


# --- internal render token ---------------------------------------------------
#
# The snapshot renderer (core/chart_snapshot.py) drives a headless browser that
# must authenticate as the alerted user in hosted mode. It self-mints a
# short-TTL HS256 token with a per-process random secret — never exposed, never
# accepted across restarts. verify paths treat it as an ALTERNATIVE to a Clerk
# JWT; local dev (auth off) never needs one.

RENDER_TOKEN_ISS = "auto-trader-render"
_RENDER_TOKEN_TTL = 60  # seconds

_render_token_secret: str | None = None


def _render_secret() -> str:
    global _render_token_secret
    if _render_token_secret is None:
        import secrets

        _render_token_secret = secrets.token_hex(32)
    return _render_token_secret


def mint_render_token(user_id: str) -> str:
    import time

    return jwt.encode(
        {"sub": user_id, "iss": RENDER_TOKEN_ISS, "exp": int(time.time()) + _RENDER_TOKEN_TTL},
        _render_secret(),
        algorithm="HS256",
    )


def verify_render_token(token: str) -> str | None:
    """User id when `token` is a valid internal render token, else None.
    Never raises — callers fall through to Clerk verification on None."""
    try:
        claims = jwt.decode(
            token,
            _render_secret(),
            algorithms=["HS256"],
            issuer=RENDER_TOKEN_ISS,
            options={"require": ["exp", "sub", "iss"]},
        )
    except Exception:
        return None
    sub = claims.get("sub")
    return sub if isinstance(sub, str) and sub else None


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
        websocket.state.impersonator = None
        return DEV_USER_ID
    token = websocket.query_params.get("token", "")
    target = websocket.query_params.get(IMPERSONATE_PARAM, "").strip()
    internal_sub = verify_render_token(token) if token else None
    if internal_sub is not None:
        # Same stacking refusal as the HTTP path. A WS has no status code to
        # return, so this closes rather than 403s.
        if not target:
            websocket.state.is_admin = False
            websocket.state.is_render = True  # see the HTTP render branch
            websocket.state.impersonator = None
            return internal_sub
        else:
            impersonation_audit.log_rejected(
                "render token",
                internal_sub,
                target[: impersonation_audit.MAX_LOGGED_VALUE_LEN],
            )
    elif token:
        try:
            claims = await asyncio.to_thread(_verify_claims, token)
            user_id, is_admin, impersonator = resolve_impersonation(claims, target, "GET")
            websocket.state.is_admin = is_admin
            websocket.state.impersonator = impersonator
            if impersonator:
                impersonation_audit.log_request(impersonator, user_id, websocket.url.path)
            return user_id
        except AuthError:
            pass
        except ImpersonationError as e:
            impersonation_audit.log_rejected(
                e.message,
                claims.get("sub", "?") if isinstance(claims, dict) else "?",
                target[: impersonation_audit.MAX_LOGGED_VALUE_LEN],
            )
    await websocket.close(code=WS_AUTH_CLOSE_CODE)
    return None
