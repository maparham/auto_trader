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
REQUIRE_TOKEN_ENV = "REQUIRE_API_TOKEN"  # "1" enables the gate
COMPUTE_ONLY_ENV = "COMPUTE_ONLY"  # "1" blocks dealing

DEALING_PATHS: tuple[tuple[str, str], ...] = (
    ("POST", "/api/orders"),
    ("PUT", "/api/positions/"),
    ("DELETE", "/api/positions/"),
    ("PUT", "/api/orders/working/"),
    ("DELETE", "/api/orders/working/"),
)


def install_guards(app: FastAPI) -> None:
    """Register one http middleware that reads env at REQUEST time.

    This middleware runs OUTERMOST (added after CORS so it wraps everything).
    401/403 responses carry no CORS headers and browser preflights are gated;
    this is fine because the remote host is only ever called server-to-server
    by the local backend proxy.
    """

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        # Token gate first, then compute-only.
        if os.environ.get(REQUIRE_TOKEN_ENV) == "1":
            token = os.environ.get(API_TOKEN_ENV, "")
            # Fail closed: if token is empty/unset, always return 401
            if not token:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "missing or invalid API token"},
                )
            expected = f"Bearer {token}"
            provided = request.headers.get("authorization", "")
            # Encode strictly so a header carrying a code point outside latin-1
            # raises UnicodeEncodeError (a ValueError), which the except below
            # turns into a 401 rather than silently dropping the bad bytes.
            try:
                if not hmac.compare_digest(
                    provided.encode("latin-1", "strict"),
                    expected.encode("latin-1", "strict"),
                ):
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "missing or invalid API token"},
                    )
            except (TypeError, ValueError):
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
