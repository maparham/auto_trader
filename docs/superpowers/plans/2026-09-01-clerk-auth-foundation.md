# Clerk Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every backend request (HTTP and WebSocket) carries a verified Clerk user identity on `request.state.user_id`, with zero behavior change in local dev (no Clerk keys set).

**Architecture:** A new `auto_trader/api/auth.py` mirrors `guard.py`'s opt-in-via-env pattern: unset env → no-op that stamps a fixed dev user id; `CLERK_JWKS_URL` set → PyJWT RS256 verification against Clerk's cached JWKS in one HTTP middleware (installed BEFORE the CORS middleware in source order so CORS wraps it and 401s carry CORS headers) plus an explicit `verify_ws` call in each of the three WebSocket routes. The frontend gets a token-getter module, an `apiFetch` wrapper in `lib/http.ts`, and a Clerk-gated `main.tsx` that renders exactly today's tree when `VITE_CLERK_PUBLISHABLE_KEY` is unset.

**Tech Stack:** FastAPI/Starlette middleware, `pyjwt[crypto]` (PyJWKClient), `@clerk/clerk-react`, pytest, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-clerk-auth-foundation-design.md`

## Global Constraints

- Env names (backend): `CLERK_JWKS_URL` (hosted-mode switch), `CLERK_AUTHORIZED_PARTIES` (comma-separated allowed `azp` values). Env is read PER REQUEST (guard.py convention) except the https-URL sanity check, which runs once at install.
- Dev user id is the literal string `"dev"` (constant `DEV_USER_ID`).
- Algorithm: RS256 only. Required claims: `exp`, `sub`. `azp` checked only when `CLERK_AUTHORIZED_PARTIES` is non-empty.
- WS auth close code is `4401` (reuse `WS_AUTH_CLOSE_CODE` semantics from `routers/agent.py`).
- `/mcp` and `/mcp/...` return 404 in hosted mode (bridge is local-only until sub-project 4).
- Exempt from HTTP auth: `OPTIONS` requests and `GET /api/health`.
- Frontend env name: `VITE_CLERK_PUBLISHABLE_KEY`. Unset → app renders exactly as today; the existing vitest suite must pass unchanged.
- Backend deps: add `pyjwt[crypto]>=2.9` to `backend/pyproject.toml`. Frontend: add `@clerk/clerk-react` (v5).
- Backend tests run from `backend/`: `uv run pytest tests/<file> -v`. Frontend from `frontend/`: `npx vitest run <file>` (full suite: `npm run test:unit`; types: `npx tsc -b`).
- Commit messages follow the repo's `feat(scope):`/`fix(scope):` style.

---

### Task 1: Backend token verification (`auth.py` core + shared test fake)

**Files:**
- Create: `backend/auto_trader/api/auth.py`
- Create: `backend/tests/clerk_fake.py`
- Test: `backend/tests/test_api_auth.py`
- Modify: `backend/pyproject.toml` (dependencies list, after `"mcp>=2.0",`)

**Interfaces:**
- Produces: `auth.JWKS_URL_ENV = "CLERK_JWKS_URL"`, `auth.AUTHORIZED_PARTIES_ENV = "CLERK_AUTHORIZED_PARTIES"`, `auth.DEV_USER_ID = "dev"`, `class AuthError(Exception)`, `auth.auth_enabled() -> bool`, `auth.verify_token(token: str) -> str` (returns the `sub` claim, raises `AuthError`), module globals `auth._jwk_client` / `auth._jwk_client_url` (monkeypatch seam for tests).
- Produces (test helper): `tests/clerk_fake.py` with `KID`, `keypair()`, `FakeJWKClient`, `make_token(...)` — Tasks 2 and 3 import these.

- [ ] **Step 1: Add the dependency**

In `backend/pyproject.toml` add to `dependencies`:

```toml
    "pyjwt[crypto]>=2.9",
```

Run: `cd backend && uv sync --extra dev`

- [ ] **Step 2: Write the shared fake + failing tests**

`backend/tests/clerk_fake.py`:

```python
"""Shared Clerk-JWT test doubles: a local RSA keypair, a fake JWKS client,
and a token mint. Used by the auth unit tests and the WS auth tests."""
from __future__ import annotations

import time

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

KID = "test-kid"
JWKS_URL = "https://clerk.example/.well-known/jwks.json"
PARTY = "http://localhost:5173"

_PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeKey:
    def __init__(self, key):
        self.key = key


class FakeJWKClient:
    """Stands in for auth._jwk_client: serves the local public key for KID,
    raises like PyJWKClient for any other kid."""

    def get_signing_key_from_jwt(self, token: str):
        kid = jwt.get_unverified_header(token).get("kid")
        if kid != KID:
            raise jwt.exceptions.PyJWKClientError(f"unknown kid: {kid}")
        return _FakeKey(_PRIVATE.public_key())


def make_token(
    *,
    sub: str | None = "user_123",
    azp: str | None = PARTY,
    exp_delta: int = 60,
    kid: str = KID,
    key=None,
) -> str:
    claims: dict = {"exp": int(time.time()) + exp_delta}
    if sub is not None:
        claims["sub"] = sub
    if azp is not None:
        claims["azp"] = azp
    return jwt.encode(claims, key or _PRIVATE, algorithm="RS256", headers={"kid": kid})


def install(monkeypatch) -> None:
    """Point auth at the fake: hosted mode ON, fake JWKS client wired in."""
    from auto_trader.api import auth

    monkeypatch.setenv(auth.JWKS_URL_ENV, JWKS_URL)
    monkeypatch.setenv(auth.AUTHORIZED_PARTIES_ENV, PARTY)
    monkeypatch.setattr(auth, "_jwk_client", FakeJWKClient())
    monkeypatch.setattr(auth, "_jwk_client_url", JWKS_URL)
```

`backend/tests/test_api_auth.py`:

```python
"""auth.verify_token against a locally-generated RSA keypair and fake JWKS."""
from __future__ import annotations

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from auto_trader.api import auth
from tests import clerk_fake


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_valid_token_returns_sub(clerk):
    assert auth.verify_token(clerk_fake.make_token()) == "user_123"


def test_expired_token_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(exp_delta=-60))


def test_wrong_signature_rejected(clerk):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(key=other))


def test_unknown_kid_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(kid="other-kid"))


def test_wrong_azp_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(azp="https://evil.example"))


def test_azp_unchecked_when_parties_unset(clerk, monkeypatch):
    monkeypatch.delenv(auth.AUTHORIZED_PARTIES_ENV)
    assert auth.verify_token(clerk_fake.make_token(azp=None)) == "user_123"


def test_missing_sub_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(sub=None))


def test_garbage_token_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token("not-a-jwt")


def test_auth_enabled_tracks_env(clerk, monkeypatch):
    assert auth.auth_enabled() is True
    monkeypatch.delenv(auth.JWKS_URL_ENV)
    assert auth.auth_enabled() is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_auth.py -v`
Expected: FAIL/ERROR with `ModuleNotFoundError: No module named 'auto_trader.api.auth'`

- [ ] **Step 4: Implement `auth.py` (verification core only — middleware comes in Task 2)**

```python
"""Clerk authentication: JWT verification for the hosted multi-user deployment.

Opt-in via env, exactly like guard.py: CLERK_JWKS_URL unset (local dev) means
no verification anywhere and a fixed dev user id; set (hosted) means every
HTTP request and WebSocket must present a valid Clerk session JWT. Env is read
per request so tests can monkeypatch without reloading the app.

- CLERK_JWKS_URL: Clerk instance JWKS endpoint (https). Presence = hosted mode.
- CLERK_AUTHORIZED_PARTIES: comma-separated allowed `azp` values (the frontend
  origin(s)). Empty = azp unchecked.
"""

from __future__ import annotations

import os

import jwt
from jwt import PyJWKClient

JWKS_URL_ENV = "CLERK_JWKS_URL"
AUTHORIZED_PARTIES_ENV = "CLERK_AUTHORIZED_PARTIES"
DEV_USER_ID = "dev"


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


def _authorized_parties() -> list[str]:
    return [
        p.strip()
        for p in os.environ.get(AUTHORIZED_PARTIES_ENV, "").split(",")
        if p.strip()
    ]


def verify_token(token: str) -> str:
    """Verify a Clerk session JWT; return its `sub` (the Clerk user id).

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
        )
    except Exception as e:  # PyJWTError, JWKS/network errors: all 401
        raise AuthError(f"invalid token: {e}") from e
    parties = _authorized_parties()
    if parties and claims.get("azp") not in parties:
        raise AuthError("invalid token: azp not authorized")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise AuthError("invalid token: bad sub")
    return sub
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_auth.py -v`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/auto_trader/api/auth.py backend/tests/clerk_fake.py backend/tests/test_api_auth.py
git commit -m "feat(auth): Clerk JWT verification core (PyJWT + cached JWKS)"
```

---

### Task 2: HTTP auth middleware + app wiring

**Files:**
- Modify: `backend/auto_trader/api/auth.py` (append)
- Modify: `backend/auto_trader/api/app.py` (around line 105: `app = FastAPI(...)` then `app.add_middleware(CORSMiddleware, ...)`)
- Test: `backend/tests/test_api_auth_http.py`

**Interfaces:**
- Consumes: `verify_token`, `auth_enabled`, `AuthError`, `DEV_USER_ID` (Task 1); `tests/clerk_fake.py`.
- Produces: `auth.install_auth(app: FastAPI) -> None`; every HTTP request handler can read `request.state.user_id: str`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api_auth_http.py`:

```python
"""install_auth middleware: dev no-op, hosted 401s, exemptions, /mcp 404."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import JWKS_URL_ENV, install_auth
from tests import clerk_fake


def probe_app() -> TestClient:
    app = FastAPI()
    install_auth(app)

    @app.get("/api/whoami")
    def whoami(request: Request) -> dict:
        return {"user_id": request.state.user_id}

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    return TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_dev_mode_stamps_dev_user(monkeypatch):
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    r = probe_app().get("/api/whoami")
    assert r.status_code == 200
    assert r.json() == {"user_id": "dev"}


def test_hosted_missing_header_401(clerk):
    r = probe_app().get("/api/whoami")
    assert r.status_code == 401


def test_hosted_bad_token_401(clerk):
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": "Bearer nope"}
    )
    assert r.status_code == 401


def test_hosted_valid_token_stamps_sub(clerk):
    tok = clerk_fake.make_token()
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200
    assert r.json() == {"user_id": "user_123"}


def test_health_exempt(clerk):
    assert probe_app().get("/api/health").status_code == 200


def test_options_exempt(clerk):
    # 405 (no OPTIONS route), NOT 401: the middleware let it through.
    assert probe_app().options("/api/whoami").status_code == 405


def test_mcp_hidden_in_hosted_mode(clerk):
    tok = clerk_fake.make_token()
    r = probe_app().get("/mcp", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 404


def test_install_rejects_non_https_jwks(monkeypatch):
    monkeypatch.setenv(JWKS_URL_ENV, "http://insecure.example/jwks.json")
    with pytest.raises(RuntimeError):
        install_auth(FastAPI())


def test_real_app_dev_mode_still_open(monkeypatch):
    """Regression guarantee: with no Clerk env the real app behaves as today."""
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    from auto_trader.api.app import app

    r = TestClient(app).get("/api/agent/sessions")
    assert r.status_code == 200


def test_real_app_hosted_mode_gated(clerk):
    from auto_trader.api.app import app

    client = TestClient(app)
    assert client.get("/api/agent/sessions").status_code == 401
    tok = clerk_fake.make_token()
    r = client.get(
        "/api/agent/sessions", headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_auth_http.py -v`
Expected: FAIL with `ImportError: cannot import name 'install_auth'`

- [ ] **Step 3: Append the middleware to `auth.py`**

Add imports at the top (`FastAPI`, `Request` from fastapi; `JSONResponse` from starlette.responses), then append:

```python
def install_auth(app: FastAPI) -> None:
    """Register the auth middleware. MUST be called BEFORE app.add_middleware(
    CORSMiddleware, ...) in app.py source order: Starlette stacks later-added
    middleware OUTSIDE earlier, so adding auth first puts CORS around it and
    our 401s carry CORS headers the browser can read (unlike guard.py's gate,
    which is server-to-server only and skips CORS on purpose).

    Sanity-checks CLERK_JWKS_URL once at install (fail fast on a non-https
    URL); everything else reads env per request."""
    url = os.environ.get(JWKS_URL_ENV)
    if url and not url.startswith("https://"):
        raise RuntimeError(f"{JWKS_URL_ENV} must be an https URL, got {url!r}")

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        if not auth_enabled():
            request.state.user_id = DEV_USER_ID
            return await call_next(request)
        path = request.url.path
        # The MCP bridge is local-only; in hosted mode it does not exist.
        if path == "/mcp" or path.startswith("/mcp/"):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        # Preflights carry no auth by design; /api/health serves LB probes.
        if request.method == "OPTIONS" or path == "/api/health":
            return await call_next(request)
        authz = request.headers.get("authorization", "")
        if not authz.startswith("Bearer "):
            return JSONResponse(
                status_code=401, content={"detail": "missing bearer token"}
            )
        try:
            request.state.user_id = verify_token(authz[len("Bearer ") :])
        except AuthError as e:
            return JSONResponse(status_code=401, content={"detail": str(e)})
        return await call_next(request)
```

- [ ] **Step 4: Wire into `app.py`**

In `backend/auto_trader/api/app.py`, import `install_auth` alongside the existing guard import, then add the call between `app = FastAPI(...)` and `app.add_middleware(CORSMiddleware, ...)`:

```python
app = FastAPI(title="Auto Trader API", version="0.1.0", lifespan=lifespan)

# Clerk auth. Installed BEFORE CORSMiddleware so CORS wraps it (Starlette
# stacks later-added middleware outside earlier ones) and auth 401s carry
# CORS headers a cross-origin browser frontend can read. No-op without
# CLERK_JWKS_URL. See auto_trader/api/auth.py.
install_auth(app)

# Vite dev origins + any CORS_ORIGINS deployment origins (read once at startup).
app.add_middleware(
    CORSMiddleware,
    ...
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_auth_http.py tests/test_api_auth.py -v`
Expected: all PASS

- [ ] **Step 6: Run the full backend suite (dev-path regression)**

Run: `cd backend && uv run pytest`
Expected: same pass/fail set as before this task (no new failures — the middleware must be invisible without Clerk env).

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/auto_trader/api/app.py backend/tests/test_api_auth_http.py
git commit -m "feat(auth): require Clerk JWTs on all HTTP routes in hosted mode"
```

---

### Task 3: WebSocket verification (`verify_ws`) on all three WS routes

**Files:**
- Modify: `backend/auto_trader/api/auth.py` (append)
- Modify: `backend/auto_trader/api/routers/stream.py` (`ws_candles`, accept at ~line 67)
- Modify: `backend/auto_trader/api/routers/state.py` (`ws_state`, ~line 83)
- Modify: `backend/auto_trader/api/routers/agent.py` (`ws_agent_ui`, ~line 22)
- Test: `backend/tests/test_api_auth_ws.py`

**Interfaces:**
- Consumes: `verify_token`, `auth_enabled`, `AuthError`, `DEV_USER_ID` (Task 1); `WS_AUTH_CLOSE_CODE = 4401` already defined in `routers/agent.py`.
- Produces: `auth.verify_ws(websocket: WebSocket) -> str | None` — returns user id, or closes the socket with 4401 and returns None.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api_auth_ws.py`:

```python
"""Hosted mode gates every WS route via a `token` query param; dev mode open."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auto_trader.api.app import app
from auto_trader.api.auth import JWKS_URL_ENV
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_ws_state_dev_mode_open(monkeypatch):
    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    with client.websocket_connect("/ws/state"):
        pass


@pytest.mark.parametrize("path", ["/ws/state", "/ws/agent-ui"])
def test_ws_rejected_without_token(clerk, path):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(path):
            pass
    assert exc.value.code == 4401


@pytest.mark.parametrize("path", ["/ws/state", "/ws/agent-ui"])
def test_ws_rejected_with_bad_token(clerk, path):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"{path}?token=nope"):
            pass
    assert exc.value.code == 4401


def test_ws_state_accepts_valid_token(clerk):
    tok = clerk_fake.make_token()
    with client.websocket_connect(f"/ws/state?token={tok}"):
        pass


def test_ws_agent_ui_accepts_valid_token(clerk):
    tok = clerk_fake.make_token()
    with client.websocket_connect(f"/ws/agent-ui?token={tok}") as ws:
        del ws
```

(`/ws/candles` needs a live broker registry, so its gate is covered by the
same `verify_ws` unit path via `/ws/state`; the wiring there is review-checked.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_auth_ws.py -v`
Expected: the hosted-mode tests FAIL (connections currently accepted / no `verify_ws`).

- [ ] **Step 3: Append `verify_ws` to `auth.py`**

Add `from fastapi import WebSocket` to the imports, then append:

```python
WS_AUTH_CLOSE_CODE = 4401  # same app-defined code routers/agent.py already uses


async def verify_ws(websocket: WebSocket) -> str | None:
    """WS counterpart of the HTTP middleware (which never sees WS upgrades).

    Browsers cannot set headers on WebSocket dials, so hosted mode passes the
    short-lived Clerk token as a `token` query param. Returns the user id, or
    closes with 4401 and returns None — callers must bail on None. Safe to
    call before OR after accept(); Starlette turns a pre-accept close into a
    handshake denial."""
    if not auth_enabled():
        return DEV_USER_ID
    token = websocket.query_params.get("token", "")
    if token:
        try:
            return verify_token(token)
        except AuthError:
            pass
    await websocket.close(code=WS_AUTH_CLOSE_CODE)
    return None
```

- [ ] **Step 4: Wire the three routes**

`routers/state.py` — at the top of `ws_state`, before `await websocket.accept()`:

```python
    from ..auth import verify_ws

    if await verify_ws(websocket) is None:
        return
    await websocket.accept()
```

(Put the import at module top with the other relative imports, not inline; shown inline here only for placement clarity. Same for the other two files.)

`routers/stream.py` — in `ws_candles`, immediately before the existing `await websocket.accept()`:

```python
    if await verify_ws(websocket) is None:
        return
    await websocket.accept()
```

`routers/agent.py` — in `ws_agent_ui`, after the existing REQUIRE_API_TOKEN and origin checks, before its accept/HUB registration:

```python
    if await verify_ws(websocket) is None:
        return
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_auth_ws.py tests/test_api_agent_ws.py -v`
Expected: all PASS (including the pre-existing agent WS suite — dev path unchanged).

- [ ] **Step 6: Full backend suite**

Run: `cd backend && uv run pytest`
Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/auto_trader/api/routers/state.py backend/auto_trader/api/routers/stream.py backend/auto_trader/api/routers/agent.py backend/tests/test_api_auth_ws.py
git commit -m "feat(auth): gate all three WebSocket routes with Clerk tokens"
```

---

### Task 4: Frontend token plumbing (`authToken.ts` + `apiFetch`)

**Files:**
- Create: `frontend/src/lib/authToken.ts`
- Modify: `frontend/src/lib/http.ts` (append)
- Test: `frontend/src/lib/http.apiFetch.test.ts`

**Interfaces:**
- Produces: `authToken.ts`: `CLERK_ENABLED: boolean`, `setTokenGetter(fn: (() => Promise<string | null>) | null): void`, `getAuthToken(): Promise<string | null>`.
- Produces: `http.ts`: `apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>`, `setUnauthorizedHandler(fn: (() => void) | null): void`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/http.apiFetch.test.ts`:

```typescript
// apiFetch: plain fetch when no token getter is registered (local dev), bearer
// header injection when one is, and the 401 → unauthorized-handler hook.
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch, setUnauthorizedHandler } from "./http";
import { setTokenGetter } from "./authToken";

afterEach(() => {
  setTokenGetter(null);
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

it("passes through untouched when no token getter is registered", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  await apiFetch("http://x/api/y", { method: "POST" });
  expect(spy).toHaveBeenCalledWith("http://x/api/y", { method: "POST" });
});

it("attaches the bearer header when a token is available", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  setTokenGetter(async () => "tok-123");
  await apiFetch("http://x/api/y");
  const init = spy.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-123");
});

it("preserves caller-supplied headers alongside the bearer header", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  setTokenGetter(async () => "tok-123");
  await apiFetch("http://x/api/y", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const init = spy.mock.calls[0][1] as RequestInit;
  const headers = new Headers(init.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("Authorization")).toBe("Bearer tok-123");
  expect(init.method).toBe("POST");
});

it("fires the unauthorized handler on 401 in token mode", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  setTokenGetter(async () => "tok-123");
  const onAuthFail = vi.fn();
  setUnauthorizedHandler(onAuthFail);
  const res = await apiFetch("http://x/api/y");
  expect(res.status).toBe(401);
  expect(onAuthFail).toHaveBeenCalledOnce();
});

it("does NOT fire the unauthorized handler without a token (local dev)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  const onAuthFail = vi.fn();
  setUnauthorizedHandler(onAuthFail);
  await apiFetch("http://x/api/y");
  expect(onAuthFail).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/http.apiFetch.test.ts`
Expected: FAIL — `authToken` module not found / `apiFetch` not exported.

- [ ] **Step 3: Implement**

`frontend/src/lib/authToken.ts`:

```typescript
// Bridge between Clerk (which only exists inside <ClerkProvider>) and the
// plain-module API/WS clients. main.tsx's ClerkTokenBridge registers Clerk's
// getToken here; apiFetch and the WS dialers pull from it. With no getter
// registered (local dev, tests) getAuthToken resolves null and everything
// behaves exactly as before auth existed.

export const CLERK_ENABLED = Boolean(
  (import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } })
    .env?.VITE_CLERK_PUBLISHABLE_KEY,
);

type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;

export function setTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

export async function getAuthToken(): Promise<string | null> {
  return getter ? getter() : null;
}
```

Append to `frontend/src/lib/http.ts` (plus `import { getAuthToken } from "./authToken";` at the top):

```typescript
let onUnauthorized: (() => void) | null = null;

/** Called when an authed request gets a 401 (session expired). main.tsx's
 *  ClerkTokenBridge registers Clerk's signOut here. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * fetch with the Clerk session token attached (when signed in). Every backend
 * call goes through this so hosted mode authenticates uniformly; with no
 * token (local dev) it IS fetch. A 401 on an authed call means the session
 * died — notify so the app can sign out cleanly rather than error-spam.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = await getAuthToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) onUnauthorized?.();
  return res;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/http.apiFetch.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/authToken.ts frontend/src/lib/http.ts frontend/src/lib/http.apiFetch.test.ts
git commit -m "feat(auth): apiFetch bearer-token wrapper + token-getter bridge"
```

---

### Task 5: Route every backend call through `apiFetch`; token on WS dials

**Files:**
- Modify: `frontend/src/api.ts` (~40 `fetch(` sites)
- Modify: `frontend/src/lib/feed.ts` (`fetch(` sites incl. inside `fetchWithTimeout`; WS dial in `connectLive` at ~line 802)
- Modify: `frontend/src/lib/patternSearch.ts`
- Modify: `frontend/src/lib/trading.ts`
- Modify: `frontend/src/lib/persist/core.ts` (fetch sites + `/ws/state` dial at ~line 519)
- Modify: `frontend/src/agent/bridge.ts` (WS dial at ~line 120)

**Interfaces:**
- Consumes: `apiFetch` from `lib/http.ts`, `getAuthToken` from `lib/authToken.ts` (Task 4).
- Produces: no new exports — behavior-only change. In dev mode every call is byte-identical to before (apiFetch with null token IS fetch).

- [ ] **Step 1: Convert HTTP call sites (mechanical)**

For each of `src/api.ts`, `src/lib/feed.ts`, `src/lib/patternSearch.ts`, `src/lib/trading.ts`, `src/lib/persist/core.ts`:

1. Replace call sites: `sed -i '' 's/\bfetch(/apiFetch(/g' <file>` (word boundary keeps `fetchWithTimeout(` calls intact; the `fetch(` INSIDE `fetchWithTimeout`'s body is correctly converted — timed requests need auth too).
2. Add `apiFetch` to each file's existing import from the http module (every one of these files already imports `API_BASE`/`BASE` or `errorDetail` from `./lib/http` / `../http` / `./http`; extend that import). `src/lib/http.ts` itself is NOT touched by the sed (its `fetch` calls are the real ones).

- [ ] **Step 2: Verify nothing bare remains**

Run: `cd frontend && grep -rn '\bfetch(' src --include='*.ts' --include='*.tsx' | grep -v test | grep -v 'src/lib/http.ts' | grep -v apiFetch`
Expected: no output (any hit is an unconverted call site — convert it).

- [ ] **Step 3: Add tokens to the three WS dials**

Pattern (a token must be fetched fresh per dial — Clerk tokens live ~60 s, so grabbing one at module load or first connect would break every reconnect):

`src/lib/feed.ts` `connectLive` — wrap the body of the existing `connect` closure:

```typescript
  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    void (async () => {
      const token = await getAuthToken();
      if (closed) return;
      ws = new WebSocket(
        token ? `${url}&token=${encodeURIComponent(token)}` : url,
      );
      // ...all existing ws.onopen / onmessage / onerror / onclose assignments
      // move inside this async IIFE unchanged...
    })();
  };
```

`src/lib/persist/core.ts` — same wrap around its `ws = new WebSocket(url)` (~line 526); the state URL has no query string yet, so append `?token=`:

```typescript
      ws = new WebSocket(
        token ? `${url}?token=${encodeURIComponent(token)}` : url,
      );
```

`src/agent/bridge.ts` — same wrap at the `ws = new WebSocket(url)` site (~line 138), also `?token=` (the agent-ui URL has no query string).

Each file adds `import { getAuthToken } from "../lib/authToken";` (path adjusted: `./authToken` from `src/lib/`, `../lib/authToken` from `src/agent/`).

- [ ] **Step 4: Type-check and run the full unit suite**

Run: `cd frontend && npx tsc -b && npm run test:unit`
Expected: clean type-check; same pass set as before this task. (This suite running with no Clerk key IS the dev-path regression test.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/feed.ts frontend/src/lib/patternSearch.ts frontend/src/lib/trading.ts frontend/src/lib/persist/core.ts frontend/src/agent/bridge.ts
git commit -m "feat(auth): route all backend calls through apiFetch; tokens on WS dials"
```

---

### Task 6: Clerk UI — provider gate, token bridge, UserButton

**Files:**
- Modify: `frontend/package.json` (add `@clerk/clerk-react`)
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/components/ClerkTokenBridge.tsx`
- Modify: `frontend/src/Toolbar.tsx` (before `</header>` at ~line 865)
- Test: `frontend/src/components/ClerkTokenBridge.test.tsx`

**Interfaces:**
- Consumes: `setTokenGetter`, `CLERK_ENABLED` (Task 4 `authToken.ts`); `setUnauthorizedHandler` (Task 4 `http.ts`).
- Produces: `ClerkTokenBridge` (default export, renders null). No other exports.

- [ ] **Step 1: Install the dependency**

Run: `cd frontend && npm install @clerk/clerk-react`

- [ ] **Step 2: Write the failing test**

`frontend/src/components/ClerkTokenBridge.test.tsx`:

```typescript
// @vitest-environment jsdom
//
// The bridge is the only place Clerk's hook world meets the plain-module
// clients: mounting it must register a working token getter, and unmounting
// must deregister (otherwise a signed-out app would keep minting headers).
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { getAuthToken, setTokenGetter } from "../lib/authToken";
import ClerkTokenBridge from "./ClerkTokenBridge";

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ getToken: async () => "clerk-tok" }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  setTokenGetter(null);
});

it("registers Clerk's getToken while mounted, deregisters on unmount", async () => {
  const { unmount } = render(<ClerkTokenBridge />);
  expect(await getAuthToken()).toBe("clerk-tok");
  unmount();
  expect(await getAuthToken()).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ClerkTokenBridge.test.tsx`
Expected: FAIL — `ClerkTokenBridge` module not found.

- [ ] **Step 4: Implement the bridge**

`frontend/src/components/ClerkTokenBridge.tsx`:

```typescript
// Registers Clerk's token getter and sign-out with the plain-module HTTP/WS
// clients (lib/authToken, lib/http). Rendered inside ClerkProvider only; in
// local dev (no Clerk key) it never mounts and both hooks stay null.
import { useEffect } from "react";
import { useAuth, useClerk } from "@clerk/clerk-react";
import { setTokenGetter } from "../lib/authToken";
import { setUnauthorizedHandler } from "../lib/http";

export default function ClerkTokenBridge() {
  const { getToken } = useAuth();
  const clerk = useClerk();
  useEffect(() => {
    setTokenGetter(() => getToken());
    setUnauthorizedHandler(() => {
      void clerk.signOut();
    });
    return () => {
      setTokenGetter(null);
      setUnauthorizedHandler(null);
    };
  }, [getToken, clerk]);
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ClerkTokenBridge.test.tsx`
Expected: PASS

- [ ] **Step 6: Gate `main.tsx`**

Replace `frontend/src/main.tsx` with:

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import ClerkTokenBridge from './components/ClerkTokenBridge.tsx'
import { CLERK_ENABLED } from './lib/authToken.ts'

// The publishable key doubles as the feature switch: unset (local dev) renders
// exactly the pre-auth tree — no provider, no sign-in, no behavior change.
const clerkKey = (
  import.meta as unknown as { env?: { VITE_CLERK_PUBLISHABLE_KEY?: string } }
).env?.VITE_CLERK_PUBLISHABLE_KEY

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {CLERK_ENABLED && clerkKey ? (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <ClerkTokenBridge />
        <SignedIn>
          <App />
        </SignedIn>
        <SignedOut>
          <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
            <SignIn />
          </div>
        </SignedOut>
      </ClerkProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
)
```

- [ ] **Step 7: UserButton in the toolbar**

In `frontend/src/Toolbar.tsx`: add imports

```typescript
import { UserButton } from "@clerk/clerk-react";
import { CLERK_ENABLED } from "./lib/authToken";
```

and immediately before the closing `</header>` (~line 865):

```tsx
      {CLERK_ENABLED && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <UserButton />
        </div>
      )}
```

- [ ] **Step 8: Type-check, full suite, dev smoke**

Run: `cd frontend && npx tsc -b && npm run test:unit`
Expected: clean; no new failures (Toolbar renders identically with `CLERK_ENABLED === false`).

Manual smoke (no Clerk key): `npm run dev` → app loads and charts work exactly as before. Hosted-path smoke needs a Clerk dev instance (publishable key in `frontend/.env.local` as `VITE_CLERK_PUBLISHABLE_KEY`, backend run with `CLERK_JWKS_URL=https://<instance>.clerk.accounts.dev/.well-known/jwks.json` and `CLERK_AUTHORIZED_PARTIES=http://localhost:5173`) — sign-up screen appears, sign-in loads the app, network tab shows `Authorization: Bearer` on API calls. This is manual per the spec; record the result in the commit message.

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/main.tsx frontend/src/components/ClerkTokenBridge.tsx frontend/src/components/ClerkTokenBridge.test.tsx frontend/src/Toolbar.tsx
git commit -m "feat(auth): Clerk sign-in gate, token bridge, and UserButton"
```
