"""Remote-deployment request guards: bearer-token gate + compute-only dealing block.

Both are opt-in via env flags set ONLY on the remote EC2 deployment (locally
unset, so zero behavior change). Env is read PER REQUEST so tests can monkeypatch
without reloading the app.

- REQUIRE_API_TOKEN=1 gates the ENTIRE API: any request whose Authorization header
  is not exactly `Bearer <API_TOKEN>` gets 401.
- COMPUTE_ONLY=1 blocks dealing endpoints (DEALING_PATHS) with 403, rejected before
  body parsing/validation because this is a plain ASGI http middleware.
"""

from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

API_TOKEN_ENV = "API_TOKEN"  # the token value
CORS_ORIGINS_ENV = "CORS_ORIGINS"  # comma-separated extra allowed origins
REQUIRE_TOKEN_ENV = "REQUIRE_API_TOKEN"  # "1" enables the gate
COMPUTE_ONLY_ENV = "COMPUTE_ONLY"  # "1" blocks dealing

DEALING_PATHS: tuple[tuple[str, str], ...] = (
    ("POST", "/api/orders"),
    ("PUT", "/api/positions/"),
    ("DELETE", "/api/positions/"),
    ("PUT", "/api/orders/working/"),
    ("DELETE", "/api/orders/working/"),
)


def cors_origins() -> list[str]:
    """The CORS allowlist: the Vite dev origins plus any comma-separated
    CORS_ORIGINS entries (a deployment adds its frontend origin here, e.g.
    a Cloudflare Pages host). Trailing slashes are stripped — an Origin
    header never carries one, so leaving it would silently never match."""
    extra = [
        origin.strip().rstrip("/")
        for origin in os.environ.get(CORS_ORIGINS_ENV, "").split(",")
        if origin.strip()
    ]
    return ["http://localhost:5173", "http://127.0.0.1:5173"] + extra


def token_ok(authorization: str | None) -> bool:
    """True if `authorization` is exactly `Bearer <API_TOKEN>`.

    Fails closed when API_TOKEN is empty/unset. Encodes strictly so a header
    carrying a code point outside latin-1 raises UnicodeEncodeError (a
    ValueError), which we turn into a rejection rather than silently dropping
    the bad bytes. Shared by the http middleware below and the /ws/agent-ui
    route, which the middleware never sees (it is http-only).

    Callers must check REQUIRE_API_TOKEN themselves: this only answers whether
    the header matches, not whether the gate is on.
    """
    token = os.environ.get(API_TOKEN_ENV, "")
    if not token:
        return False
    expected = f"Bearer {token}"
    try:
        return hmac.compare_digest(
            (authorization or "").encode("latin-1", "strict"),
            expected.encode("latin-1", "strict"),
        )
    except (TypeError, ValueError):
        return False


def install_guards(app: FastAPI) -> None:
    """Register one http middleware that reads env at REQUEST time.

    This middleware is added after CORS so it wraps it (app.py later adds the
    /mcp path-rewrite middleware, which is outer still).
    401/403 responses carry no CORS headers and browser preflights are gated;
    this is fine because the remote host is only ever called server-to-server
    by the local backend proxy.
    """

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        # Token gate first, then compute-only.
        if os.environ.get(REQUIRE_TOKEN_ENV) == "1":
            if not token_ok(request.headers.get("authorization", "")):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "missing or invalid API token"},
                )

        if os.environ.get(COMPUTE_ONLY_ENV) == "1":
            method = request.method
            path = request.url.path
            for m, prefix in DEALING_PATHS:
                if method == m and path.startswith(prefix):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "dealing disabled on compute host"},
                    )

        return await call_next(request)
