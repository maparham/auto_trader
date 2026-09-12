# User Impersonation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin boot the full app read-only as a specific Clerk user, to reproduce what that user sees.

**Architecture:** The admin's own Clerk token stays the credential on every request. The target user id rides alongside it: the `X-Impersonate-User` header on HTTP, the `impersonate` query param on WebSocket dials. One backend helper resolves it at both identity call sites, forcing `is_admin` false and refusing every non-GET/HEAD method. On the frontend the target lives in `sessionStorage`, entering and exiting wipe the local workspace and hard-reload, and persist stops mirroring writes to the backend.

**Tech Stack:** FastAPI + PyJWT (backend), pytest; React 19 + TypeScript + Clerk (frontend), vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-12-user-impersonation-design.md`

## Global Constraints

- Backend tests run with `cd backend && .venv/bin/python -m pytest`. Plain `python3 -m pytest` fails on a missing `py_vapid`.
- Frontend tests run only the affected files: `cd frontend && npx vitest run <paths>`. Never the full suite.
- Frontend typecheck is `npx tsc -b`, never `tsc --noEmit` (a no-op in this repo).
- No em dashes in UI copy or prose. Use a comma, a colon, or a second sentence.
- Use the shared `Tooltip` / `InfoTip` components, never a native `title=` attribute.
- `erasableSyntaxOnly` is on: no TypeScript parameter properties (`constructor(public x: number)`). Declare the field, assign it in the body.
- jsdom in this vitest config has no working Storage API. Any test touching `localStorage` or `sessionStorage` must call `installMemStorage()` from `frontend/src/lib/testMemStorage`.
- vitest runs without globals, so React Testing Library auto-cleanup is not wired. Every component test file needs an explicit `afterEach(cleanup)`.
- Commit to the current branch. Never create a branch, never push.
- The worktree is shared with other sessions: `git add` by explicit path only, never `git add -A`, never stash or clean.

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `backend/auto_trader/api/auth.py` (modify) | `resolve_impersonation` plus its two call sites: the HTTP middleware and `verify_ws`. |
| `backend/auto_trader/core/impersonation_audit.py` (create) | The throttled audit logger. No HTTP knowledge, so it is unit-testable on its own. |
| `backend/auto_trader/api/routers/admin.py` (modify) | `POST /api/admin/impersonate`: validate the target, log the start. |
| `backend/auto_trader/core/clerk_admin.py` (modify) | `get_user(user_id)` so the endpoint can 404 an unknown target. |
| `backend/tests/test_impersonation_http.py` (create) | Middleware behaviour against a real `install_auth` app. |
| `backend/tests/test_impersonation_ws.py` (create) | `verify_ws` behaviour. |
| `backend/tests/test_impersonation_audit.py` (create) | Throttle and log levels. |
| `backend/tests/test_api_admin_impersonate.py` (create) | The endpoint. |

**Frontend**

| File | Responsibility |
|---|---|
| `frontend/src/lib/impersonation.ts` (create) | The single source of truth for "am I impersonating and as whom", plus enter and exit. Everything else reads this. |
| `frontend/src/lib/http.ts` (modify) | Attach `X-Impersonate-User` in `apiFetch`. |
| `frontend/src/lib/feed.ts`, `lib/persist/core.ts`, `agent/bridge.ts` (modify) | Append `impersonate=` to the dial URL. |
| `frontend/src/lib/persist/core.ts` (modify) | Do not enable backend mirroring while impersonating. |
| `frontend/src/components/ImpersonationBanner.tsx` (create) | The pinned banner and its Exit control. |
| `frontend/src/lib/workspaceKeys.ts` (create) | Leaf module owning `PREFIX` and `wipeWorkspaceKeys`. A leaf on purpose: `persist/core` imports `impersonation` (Task 5) and `impersonation` needs the wipe, so the wipe cannot live in either without creating an import cycle. |
| `frontend/src/components/AccountGate.tsx` (modify) | Use the shared wipe instead of its own loop. |
| `frontend/src/main.tsx` (modify) | Render the banner above the app. |
| `frontend/src/admin/UsersPanel.tsx` (modify) | The "View as" button and its confirm. |
| `frontend/src/admin/api.ts` (modify) | `startImpersonation(userId)`. |

---

### Task 1: Backend identity resolution

**Files:**
- Modify: `backend/auto_trader/api/auth.py`
- Test: `backend/tests/test_impersonation_http.py`, `backend/tests/test_impersonation_ws.py`

**Interfaces:**
- Consumes: `is_admin_claims(claims) -> bool`, `auth_enabled() -> bool`, `AuthError` (all already in `auth.py`).
- Produces:
  - `IMPERSONATE_HEADER = "X-Impersonate-User"` and `IMPERSONATE_PARAM = "impersonate"`
  - `class ImpersonationError(Exception)` with a `.message` safe to return to the client
  - `resolve_impersonation(claims: dict, raw_target: str, method: str) -> tuple[str, bool, str | None]` returning `(user_id, is_admin, impersonator)`
  - `request.state.impersonator` / `websocket.state.impersonator`, `None` when not impersonating

- [ ] **Step 1: Write the failing unit tests for the helper**

Create `backend/tests/test_impersonation_http.py`:

```python
"""Impersonation: resolve_impersonation plus the HTTP middleware call site."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import (
    ADMIN_EMAILS_ENV,
    IMPERSONATE_HEADER,
    ImpersonationError,
    install_auth,
    resolve_impersonation,
)
from tests import clerk_fake

ADMIN_EMAIL = "boss@example.com"
ADMIN_CLAIMS = {"sub": "user_admin", "email": ADMIN_EMAIL}
PLAIN_CLAIMS = {"sub": "user_plain", "email": "nobody@example.com"}


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(ADMIN_EMAILS_ENV, ADMIN_EMAIL)


def test_no_target_is_unchanged(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "", "GET") == ("user_admin", True, None)


def test_admin_with_target_swaps_and_drops_admin(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "user_target", "GET") == (
        "user_target",
        False,
        "user_admin",
    )


def test_non_admin_with_target_raises(clerk):
    with pytest.raises(ImpersonationError) as exc:
        resolve_impersonation(PLAIN_CLAIMS, "user_target", "GET")
    assert exc.value.message == "impersonation requires admin access"


def test_write_method_raises(clerk):
    with pytest.raises(ImpersonationError) as exc:
        resolve_impersonation(ADMIN_CLAIMS, "user_target", "POST")
    assert exc.value.message == "impersonation is read-only"


def test_head_is_allowed(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "user_target", "HEAD")[0] == "user_target"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py -v`
Expected: FAIL at import, `ImportError: cannot import name 'IMPERSONATE_HEADER'`.

- [ ] **Step 3: Implement the helper**

In `backend/auto_trader/api/auth.py`, after `is_admin_claims`, add:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py -v`
Expected: 5 passed.

- [ ] **Step 5: Write the failing middleware tests**

Append to `backend/tests/test_impersonation_http.py`:

```python
def probe_app() -> TestClient:
    app = FastAPI()
    install_auth(app)

    @app.get("/api/whoami")
    def whoami(request: Request) -> dict:
        return {
            "user_id": request.state.user_id,
            "is_admin": request.state.is_admin,
            "impersonator": request.state.impersonator,
        }

    @app.post("/api/write")
    def write(request: Request) -> dict:
        return {"user_id": request.state.user_id}

    return TestClient(app)


def admin_token() -> str:
    return clerk_fake.make_token(sub="user_admin", extra={"email": ADMIN_EMAIL})


def plain_token() -> str:
    return clerk_fake.make_token(sub="user_plain")


def test_middleware_admin_impersonates(clerk):
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {admin_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 200
    assert r.json() == {
        "user_id": "user_target",
        "is_admin": False,
        "impersonator": "user_admin",
    }


def test_middleware_without_header_is_untouched(clerk):
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": f"Bearer {admin_token()}"}
    )
    assert r.json() == {
        "user_id": "user_admin",
        "is_admin": True,
        "impersonator": None,
    }


def test_middleware_non_admin_403(clerk):
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {plain_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation requires admin access"


def test_middleware_write_403(clerk):
    r = probe_app().post(
        "/api/write",
        headers={
            "Authorization": f"Bearer {admin_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation is read-only"


def test_dev_mode_ignores_the_header(monkeypatch):
    from auto_trader.api.auth import JWKS_URL_ENV

    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    r = probe_app().get("/api/whoami", headers={IMPERSONATE_HEADER: "user_target"})
    assert r.json() == {"user_id": "dev", "is_admin": True, "impersonator": None}


def test_render_token_rejects_the_header(clerk):
    from auto_trader.api.auth import mint_render_token

    tok = mint_render_token("user_rendered")
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {tok}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation requires admin access"


def test_render_token_without_the_header_still_works(clerk):
    from auto_trader.api.auth import mint_render_token

    tok = mint_render_token("user_rendered")
    r = probe_app().get("/api/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {
        "user_id": "user_rendered",
        "is_admin": False,
        "impersonator": None,
    }
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py -v`
Expected: the new tests FAIL with `AttributeError: 'State' object has no attribute 'impersonator'`.

- [ ] **Step 7: Wire the helper into the middleware**

In `backend/auto_trader/api/auth.py`, inside `install_auth`'s `_auth` middleware:

Dev branch, add the stamp so the attribute always exists:

```python
        if not auth_enabled():
            request.state.user_id = DEV_USER_ID
            request.state.is_admin = True
            request.state.claims = {}
            request.state.impersonator = None
            return await call_next(request)
```

Render-token branch: refuse the header outright rather than ignoring it. The
render token is already a "read as another user" mechanism, and letting the
two stack would let a 60s internal token pivot to any account.

```python
            if request.method not in ("GET", "HEAD"):
                return JSONResponse(status_code=401, content={"detail": INVALID_TOKEN_MSG})
            if request.headers.get(IMPERSONATE_HEADER, "").strip():
                return JSONResponse(
                    status_code=403,
                    content={"detail": "impersonation requires admin access"},
                )
            request.state.user_id = internal_sub
            request.state.is_admin = False
            request.state.claims = {}
            request.state.impersonator = None
            return await call_next(request)
```

Clerk branch:

```python
        try:
            # _verify_claims can block on a JWKS HTTP fetch (cold cache, key
            # rotation); keep that off the event loop.
            claims = await asyncio.to_thread(_verify_claims, token)
            user_id, is_admin, impersonator = resolve_impersonation(
                claims,
                request.headers.get(IMPERSONATE_HEADER, ""),
                request.method,
            )
            request.state.user_id = user_id
            request.state.is_admin = is_admin
            request.state.impersonator = impersonator
            # The admin console reads the `email` claim from here (whoami).
            request.state.claims = claims
        except AuthError as e:
            return JSONResponse(status_code=401, content={"detail": str(e)})
        except ImpersonationError as e:
            return JSONResponse(status_code=403, content={"detail": e.message})
        return await call_next(request)
```

- [ ] **Step 8: Run the HTTP tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py -v`
Expected: 12 passed.

- [ ] **Step 9: Write the failing WS tests**

Create `backend/tests/test_impersonation_ws.py`:

```python
"""Impersonation over WebSocket: browsers cannot set handshake headers, so the
target rides in the `impersonate` query param next to `token`."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from auto_trader.api.app import app
from auto_trader.api.auth import ADMIN_EMAILS_ENV
from tests import clerk_fake

ADMIN_EMAIL = "boss@example.com"

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(ADMIN_EMAILS_ENV, ADMIN_EMAIL)


def admin_token() -> str:
    return clerk_fake.make_token(sub="user_admin", extra={"email": ADMIN_EMAIL})


def plain_token() -> str:
    return clerk_fake.make_token(sub="user_plain")


def test_ws_admin_impersonates(clerk):
    url = f"/ws/state?token={admin_token()}&impersonate=user_target"
    with client.websocket_connect(url):
        pass  # a clean handshake is the assertion: 4401 would raise


def test_ws_non_admin_impersonating_is_closed(clerk):
    url = f"/ws/state?token={plain_token()}&impersonate=user_target"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url):
            pass
    assert exc.value.code == 4401


def test_ws_render_token_with_impersonate_is_closed(clerk):
    from auto_trader.api.auth import mint_render_token

    url = f"/ws/state?token={mint_render_token('user_rendered')}&impersonate=user_target"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url):
            pass
    assert exc.value.code == 4401
```

- [ ] **Step 10: Run them to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_ws.py -v`
Expected: `test_ws_non_admin_impersonating_is_closed` and `test_ws_render_token_with_impersonate_is_closed` FAIL, because the param is ignored today and both handshakes succeed.

- [ ] **Step 11: Wire the helper into `verify_ws`**

Replace the body of `verify_ws` in `backend/auto_trader/api/auth.py`:

```python
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
            websocket.state.impersonator = None
            return internal_sub
    elif token:
        try:
            claims = await asyncio.to_thread(_verify_claims, token)
            user_id, is_admin, impersonator = resolve_impersonation(claims, target, "GET")
            websocket.state.is_admin = is_admin
            websocket.state.impersonator = impersonator
            return user_id
        except (AuthError, ImpersonationError):
            pass
    await websocket.close(code=WS_AUTH_CLOSE_CODE)
    return None
```

The method passed is `"GET"` because a WS dial is a read subscription. Writes
travel as messages on the socket, which is why Task 5 disables persist
mirroring rather than relying on this check alone.

- [ ] **Step 12: Run the WS tests, then the whole auth suite**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_ws.py tests/test_api_auth_ws.py tests/test_api_auth_http.py tests/test_api_auth.py tests/test_auth_render_token.py tests/test_api_admin_identity.py tests/test_api_admin_gate.py -v`
Expected: all pass. The pre-existing files must be green too: the middleware changed under them.

- [ ] **Step 13: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/tests/test_impersonation_http.py backend/tests/test_impersonation_ws.py
git commit -m "feat(auth): resolve read-only impersonation at both identity call sites"
```

---

### Task 2: The audit logger

**Files:**
- Create: `backend/auto_trader/core/impersonation_audit.py`
- Modify: `backend/auto_trader/api/auth.py`
- Test: `backend/tests/test_impersonation_audit.py`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; the middleware call site added here sits next to the Task 1 code.
- Produces:
  - `log_start(admin_id: str, target_id: str) -> None`
  - `log_request(admin_id: str, target_id: str, path: str, now: float) -> None`
  - `log_rejected(reason: str, caller_id: str, target_id: str) -> None`
  - `reset() -> None` (test seam; clears the throttle state)
  - `SUMMARY_INTERVAL_S = 60.0`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_impersonation_audit.py`:

```python
"""The impersonation audit trail: a start line, a throttled summary, and an
unthrottled warning for every refused attempt."""
from __future__ import annotations

import logging

import pytest

from auto_trader.core import impersonation_audit as audit


@pytest.fixture(autouse=True)
def clean():
    audit.reset()
    yield
    audit.reset()


def test_start_logs_at_info(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        audit.log_start("user_admin", "user_target")
    assert "impersonation start" in caplog.text
    assert "user_admin" in caplog.text
    assert "user_target" in caplog.text


def test_rejection_logs_at_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        audit.log_rejected("not admin", "user_plain", "user_target")
    assert caplog.records[0].levelno == logging.WARNING
    assert "user_plain" in caplog.text


def test_requests_are_throttled_to_one_line_per_window(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        for i in range(50):
            audit.log_request("user_admin", "user_target", f"/api/alerts?{i}", now=1000.0)
    assert len(caplog.records) == 1


def test_a_new_window_logs_again_with_the_count(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        for i in range(5):
            audit.log_request("user_admin", "user_target", "/api/alerts", now=1000.0)
        audit.log_request("user_admin", "user_target", "/api/alerts", now=1000.0 + 61)
    assert len(caplog.records) == 2
    assert "6 requests" in caplog.records[1].message


def test_separate_pairs_throttle_separately(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        audit.log_request("user_admin", "user_a", "/api/alerts", now=1000.0)
        audit.log_request("user_admin", "user_b", "/api/alerts", now=1000.0)
    assert len(caplog.records) == 2
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_audit.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'auto_trader.core.impersonation_audit'`.

- [ ] **Step 3: Implement the module**

Create `backend/auto_trader/core/impersonation_audit.py`:

```python
"""Audit trail for admin impersonation.

Logging every impersonated request would drown the log: the app polls. So a
session emits one start line, then at most one summary per window carrying the
request count, and every REFUSED attempt is logged unthrottled, because a
non-admin sending the header is the line that actually matters.

These records reach stdout, which is journald on the box, so they survive a
restart. The admin console's Logs panel shows them from the in-process ring
buffer (core/log_buffer.py), which does not. Journald is the record of truth;
the panel is the convenient view."""

from __future__ import annotations

import logging
import time

log = logging.getLogger("auto_trader.impersonation")

SUMMARY_INTERVAL_S = 60.0

# (admin_id, target_id) -> [window_started_at, requests_in_window]. Process
# local, like every other counter here: an audit that needed to be exact across
# restarts would need a database, which is deliberately out of scope.
_windows: dict[tuple[str, str], list] = {}


def reset() -> None:
    """Drop the throttle state. Test seam; never called in production."""
    _windows.clear()


def log_start(admin_id: str, target_id: str) -> None:
    """The authoritative start-of-session record, emitted by the endpoint."""
    log.info("impersonation start: admin=%s target=%s", admin_id, target_id)


def log_request(admin_id: str, target_id: str, path: str, now: float | None = None) -> None:
    """Count one impersonated request, emitting a summary at most once per
    window. The path is a sample, not a list: it exists to make a line
    recognisable, not to reconstruct the session."""
    ts = time.monotonic() if now is None else now
    key = (admin_id, target_id)
    window = _windows.get(key)
    if window is None or ts - window[0] >= SUMMARY_INTERVAL_S:
        count = 1 if window is None else window[1] + 1
        _windows[key] = [ts, 0]
        log.info(
            "impersonation active: admin=%s target=%s %d requests, e.g. %s",
            admin_id,
            target_id,
            count,
            path,
        )
        return
    window[1] += 1


def log_rejected(reason: str, caller_id: str, target_id: str) -> None:
    """A refused attempt. Never throttled."""
    log.warning(
        "impersonation refused (%s): caller=%s target=%s", reason, caller_id, target_id
    )
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_audit.py -v`
Expected: 5 passed.

- [ ] **Step 5: Call it from the middleware**

In `backend/auto_trader/api/auth.py`, add the import at the top of the file:

```python
from auto_trader.core import impersonation_audit
```

In the Clerk branch of `_auth`, after the successful resolve:

```python
            request.state.claims = claims
            if impersonator:
                impersonation_audit.log_request(impersonator, user_id, request.url.path)
```

And in the `ImpersonationError` handler:

```python
        except ImpersonationError as e:
            impersonation_audit.log_rejected(
                e.message,
                claims.get("sub", "?") if isinstance(claims, dict) else "?",
                request.headers.get(IMPERSONATE_HEADER, ""),
            )
            return JSONResponse(status_code=403, content={"detail": e.message})
```

Note `claims` is bound before `resolve_impersonation` runs, so it is always
available in this handler. The render-token rejection branch added in Task 1
also gets a line, since that is the attempt worth seeing:

```python
            if request.headers.get(IMPERSONATE_HEADER, "").strip():
                impersonation_audit.log_rejected(
                    "render token", internal_sub,
                    request.headers.get(IMPERSONATE_HEADER, ""),
                )
                return JSONResponse(
                    status_code=403,
                    content={"detail": "impersonation requires admin access"},
                )
```

- [ ] **Step 6: Add a middleware-level audit test**

Append to `backend/tests/test_impersonation_http.py`:

```python
def test_middleware_logs_the_session(clerk, caplog):
    import logging

    from auto_trader.core import impersonation_audit

    impersonation_audit.reset()
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        probe_app().get(
            "/api/whoami",
            headers={
                "Authorization": f"Bearer {admin_token()}",
                IMPERSONATE_HEADER: "user_target",
            },
        )
    assert "impersonation active" in caplog.text
    impersonation_audit.reset()


def test_middleware_logs_a_refusal(clerk, caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        probe_app().get(
            "/api/whoami",
            headers={
                "Authorization": f"Bearer {plain_token()}",
                IMPERSONATE_HEADER: "user_target",
            },
        )
    assert "impersonation refused" in caplog.text
```

- [ ] **Step 7: Run both files**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py tests/test_impersonation_audit.py -v`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/core/impersonation_audit.py backend/auto_trader/api/auth.py backend/tests/test_impersonation_audit.py backend/tests/test_impersonation_http.py
git commit -m "feat(auth): audit impersonated sessions and refusals"
```

---

### Task 3: `POST /api/admin/impersonate`

**Files:**
- Modify: `backend/auto_trader/core/clerk_admin.py`, `backend/auto_trader/api/routers/admin.py`
- Test: `backend/tests/test_api_admin_impersonate.py`

**Interfaces:**
- Consumes: `impersonation_audit.log_start` (Task 2); `clerk_admin.map_user`, `clerk_admin._secret`, `clerk_admin._transport`, `clerk_admin.API_BASE`, `clerk_admin.TIMEOUT_SECONDS` (existing).
- Produces:
  - `clerk_admin.get_user(user_id: str) -> dict | None`, the mapped user or `None` when Clerk does not know the id
  - `POST /api/admin/impersonate` taking `{"user_id": str}`, returning `{"user": {...}}`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_admin_impersonate.py`:

```python
"""POST /api/admin/impersonate: validate the target, record the start."""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import clerk_admin

client = TestClient(app)

RAW_USER = {
    "id": "user_target",
    "primary_email_address_id": "idn_1",
    "email_addresses": [{"id": "idn_1", "email_address": "target@example.com"}],
    "first_name": "Tara",
    "last_name": "Get",
}


def fake_clerk(monkeypatch, status: int, body):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_fake")
    monkeypatch.setattr(
        clerk_admin, "_transport", lambda: httpx.MockTransport(handler)
    )


def test_known_user_returns_the_mapped_user(monkeypatch):
    fake_clerk(monkeypatch, 200, RAW_USER)
    r = client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "target@example.com"


def test_unknown_user_404s(monkeypatch):
    fake_clerk(monkeypatch, 404, {"errors": []})
    r = client.post("/api/admin/impersonate", json={"user_id": "user_nope"})
    assert r.status_code == 404


def test_unconfigured_clerk_503s(monkeypatch):
    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    r = client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert r.status_code == 503


def test_blank_user_id_422s(monkeypatch):
    fake_clerk(monkeypatch, 200, RAW_USER)
    r = client.post("/api/admin/impersonate", json={"user_id": "  "})
    assert r.status_code == 422


def test_it_logs_the_start(monkeypatch, caplog):
    import logging

    fake_clerk(monkeypatch, 200, RAW_USER)
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        client.post("/api/admin/impersonate", json={"user_id": "user_target"})
    assert "impersonation start" in caplog.text
```

These run in dev mode (no `CLERK_JWKS_URL`), where `require_admin_console`
passes because `request_is_admin` is unconditionally true. The gate itself is
already covered by `tests/test_api_admin_gate.py`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_admin_impersonate.py -v`
Expected: FAIL with 405 or 404 on the route, since the endpoint does not exist.

- [ ] **Step 3: Add `get_user` to `clerk_admin.py`**

```python
async def get_user(user_id: str) -> dict | None:
    """One mapped user, or None when Clerk does not know the id. Raises
    RuntimeError when the secret is unset, so a caller that REQUIRES a real
    answer cannot mistake 'not configured' for 'no such user'."""
    secret = _secret()
    if not secret:
        raise RuntimeError("Clerk secret not configured")
    headers = {"Authorization": f"Bearer {secret}"}
    async with httpx.AsyncClient(
        timeout=TIMEOUT_SECONDS, transport=_transport()
    ) as client:
        res = await client.get(f"{API_BASE}/users/{user_id}", headers=headers)
    if res.status_code == 404:
        return None
    if res.status_code >= 400:
        # Status only. The body can echo request details, and the secret must
        # never reach the client or the log.
        raise RuntimeError(f"Clerk API returned {res.status_code}")
    return map_user(res.json())
```

- [ ] **Step 4: Add the endpoint to `routers/admin.py`**

Add the imports:

```python
from pydantic import BaseModel

from auto_trader.core import impersonation_audit
```

Then, at the end of the file:

```python
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
```

Add `HTTPException` to the existing `from fastapi import ...` line.

- [ ] **Step 5: Run to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_admin_impersonate.py tests/test_clerk_admin.py tests/test_api_admin_console.py -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/clerk_admin.py backend/auto_trader/api/routers/admin.py backend/tests/test_api_admin_impersonate.py
git commit -m "feat(admin): add the impersonation start endpoint"
```

---

### Task 4: Frontend transport

**Files:**
- Create: `frontend/src/lib/impersonation.ts`
- Modify: `frontend/src/lib/http.ts`, `frontend/src/lib/feed.ts`, `frontend/src/lib/persist/core.ts`, `frontend/src/agent/bridge.ts`
- Test: `frontend/src/lib/impersonation.test.ts`, `frontend/src/lib/http.apiFetch.test.ts` (extend)

**Interfaces:**
- Consumes: `IMPERSONATE_HEADER` / `IMPERSONATE_PARAM` values from Task 1, as the literals `"X-Impersonate-User"` and `"impersonate"`.
- Produces:
  - `impersonatedUserId(): string | null`
  - `isImpersonating(): boolean`
  - `setImpersonatedUserId(id: string | null): void`
  - `withImpersonation(url: string): string` (appends the query param, picking `?` or `&`)
  - `IMPERSONATE_HEADER` re-exported for `http.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/impersonation.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

import {
  impersonatedUserId,
  isImpersonating,
  setImpersonatedUserId,
  withImpersonation,
} from "./impersonation";

beforeEach(() => {
  sessionStorage.clear();
});

it("reports nothing when the flag is unset", () => {
  expect(impersonatedUserId()).toBeNull();
  expect(isImpersonating()).toBe(false);
});

it("round-trips the target through sessionStorage", () => {
  setImpersonatedUserId("user_target");
  expect(impersonatedUserId()).toBe("user_target");
  expect(isImpersonating()).toBe(true);
});

it("clears the target on null", () => {
  setImpersonatedUserId("user_target");
  setImpersonatedUserId(null);
  expect(impersonatedUserId()).toBeNull();
});

it("treats a blank stored value as not impersonating", () => {
  sessionStorage.setItem("auto-trader.impersonateUserId", "   ");
  expect(isImpersonating()).toBe(false);
});

it("appends the param with ? when the url has no query", () => {
  setImpersonatedUserId("user_target");
  expect(withImpersonation("ws://x/ws/state")).toBe(
    "ws://x/ws/state?impersonate=user_target",
  );
});

it("appends the param with & when the url already has a query", () => {
  setImpersonatedUserId("user_target");
  expect(withImpersonation("ws://x/ws/candles?epic=US100")).toBe(
    "ws://x/ws/candles?epic=US100&impersonate=user_target",
  );
});

it("leaves the url alone when not impersonating", () => {
  expect(withImpersonation("ws://x/ws/state")).toBe("ws://x/ws/state");
});

it("encodes the target", () => {
  setImpersonatedUserId("user a/b");
  expect(withImpersonation("ws://x/ws/state")).toBe(
    "ws://x/ws/state?impersonate=user%20a%2Fb",
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/impersonation.test.ts`
Expected: FAIL, cannot resolve `./impersonation`.

- [ ] **Step 3: Implement the module**

Create `frontend/src/lib/impersonation.ts`:

```ts
// Admin impersonation: the ONE place that answers "am I viewing the app as
// someone else, and as whom". Every transport reads it from here, so a dialer
// added later cannot silently miss it and produce a split-brain session that
// reads as the target but writes live state as the admin.
//
// sessionStorage, deliberately: per-tab, and it dies with the tab. An
// impersonation that outlived the tab, or leaked into another window, is the
// failure mode worth engineering against.

const KEY = "auto-trader.impersonateUserId";

/** The Clerk id being impersonated, or null. */
export function impersonatedUserId(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const id = (raw ?? "").trim();
    return id || null;
  } catch {
    // Private-mode / disabled storage: treat as "not impersonating" rather
    // than throwing on every request.
    return null;
  }
}

export function isImpersonating(): boolean {
  return impersonatedUserId() !== null;
}

/** Set or clear the target. Callers are enter/exit only (see the banner). */
export function setImpersonatedUserId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* see impersonatedUserId */
  }
}

/** The header the backend reads on HTTP (auth.IMPERSONATE_HEADER). */
export const IMPERSONATE_HEADER = "X-Impersonate-User";

/** Add the impersonation query param to a WebSocket URL. Browsers cannot set
 *  headers on a handshake, which is why the token travels this way too. */
export function withImpersonation(url: string): string {
  const id = impersonatedUserId();
  if (!id) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}impersonate=${encodeURIComponent(id)}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/impersonation.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Write the failing apiFetch test**

Append to `frontend/src/lib/http.apiFetch.test.ts`:

```ts
it("attaches the impersonation header when impersonating", async () => {
  const { setImpersonatedUserId } = await import("./impersonation");
  setImpersonatedUserId("user_target");
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response("{}"));
  });
  await apiFetch("/api/alerts");
  expect(new Headers(calls[0]?.headers).get("X-Impersonate-User")).toBe(
    "user_target",
  );
  setImpersonatedUserId(null);
});

it("omits the impersonation header when not impersonating", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response("{}"));
  });
  await apiFetch("/api/alerts");
  expect(new Headers(calls[0]?.headers).get("X-Impersonate-User")).toBeNull();
});
```

Read the top of that file first: it already installs a token getter and stubs
`fetch`. Match its existing setup rather than duplicating it, and add
`installMemStorage()` at the top if it is not there, since these two tests
touch `sessionStorage`.

- [ ] **Step 6: Run to verify the first one fails**

Run: `cd frontend && npx vitest run src/lib/http.apiFetch.test.ts`
Expected: the impersonation test FAILS (header is null); the omit test passes vacuously.

- [ ] **Step 7: Attach the header in `apiFetch`**

In `frontend/src/lib/http.ts`, import at the top:

```ts
import { IMPERSONATE_HEADER, impersonatedUserId } from "./impersonation";
```

The no-token-getter fast path must still carry the header, because the header
is independent of the Clerk token plumbing. Replace the early return and the
header construction:

```ts
export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const asUser = impersonatedUserId();
  // No getter registered (local dev, most tests): dial fetch directly and
  // synchronously — no `await getAuthToken()` microtask in between — so this
  // really IS fetch, not just "fetch a tick later with no header."
  if (!hasTokenGetter()) {
    if (!asUser) return fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set(IMPERSONATE_HEADER, asUser);
    return fetch(input, { ...init, headers });
  }
  return (async () => {
    ...
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (asUser) headers.set(IMPERSONATE_HEADER, asUser);
    const res = await fetch(input, { ...init, headers });
    ...
    if (fresh) {
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${fresh}`);
      if (asUser) retryHeaders.set(IMPERSONATE_HEADER, asUser);
      ...
    }
```

Also handle the tokenless branch inside the async body (`if (!token) return
fetch(input, init);`): give it the same header treatment as the fast path.

- [ ] **Step 8: Run to verify they pass**

Run: `cd frontend && npx vitest run src/lib/http.apiFetch.test.ts src/lib/http.test.ts`
Expected: all pass.

- [ ] **Step 9: Wrap the three WS dial URLs**

`frontend/src/lib/feed.ts` around line 846:

```ts
      ws = new WebSocket(
        withImpersonation(
          token ? `${url}&token=${encodeURIComponent(token)}` : url,
        ),
      );
```

`frontend/src/lib/persist/core.ts` around line 588:

```ts
      ws = new WebSocket(
        withImpersonation(
          token ? `${url}?token=${encodeURIComponent(token)}` : url,
        ),
      );
```

`frontend/src/agent/bridge.ts` around line 140: wrap its URL the same way. The
bridge is dev-only and impersonation is hosted-only, so this is belt and
braces, not a live path. Wrapping it anyway keeps the rule "every dialer goes
through the helper" true with no exceptions to remember.

Add `import { withImpersonation } from "../lib/impersonation";` (or `"./impersonation"` in `lib/`) to each.

- [ ] **Step 10: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no new errors. Judge by per-file parity against the pre-change output if the build already has errors.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/impersonation.ts frontend/src/lib/impersonation.test.ts frontend/src/lib/http.ts frontend/src/lib/http.apiFetch.test.ts frontend/src/lib/feed.ts frontend/src/lib/persist/core.ts frontend/src/agent/bridge.ts
git commit -m "feat(impersonation): carry the target on every request and dial"
```

---

### Task 5: Suppress persist mirroring while impersonating

**Files:**
- Modify: `frontend/src/lib/persist/core.ts`
- Test: `frontend/src/lib/persist/core.impersonation.test.ts`

**Interfaces:**
- Consumes: `isImpersonating()` (Task 4).
- Produces: nothing new. This is a behaviour change inside `hydrateFromBackend`.

Why the enable flag and not the two `mirror*` guards: `mirrorEnabled` is
already the single "don't mirror" gate, flipped in exactly one place
(`hydrateFromBackend`, around line 448). Gating there covers `mirrorSet`,
`mirrorDelete` and `seedBackendFromLocal` at once, and cannot be missed by a
mirror path added later.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/persist/core.impersonation.test.ts`:

```ts
// @vitest-environment jsdom
//
// While impersonating, the backend refuses every write (the gate is read-only).
// Mirroring anyway would 403 on every autosave and spam errors, so the mirror
// is never enabled for the duration.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();

import { setImpersonatedUserId } from "../impersonation";
import { hydrateFromBackend, save } from "./core";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  setImpersonatedUserId(null);
  vi.unstubAllGlobals();
});

function stubFetch(): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit = {}) => {
    calls.push(init);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
  return calls;
}

it("does not mirror writes while impersonating", async () => {
  setImpersonatedUserId("user_target");
  const calls = stubFetch();
  await hydrateFromBackend();
  calls.length = 0;
  save("b.capital.layouts", [1]);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
});

it("mirrors writes normally when not impersonating", async () => {
  const calls = stubFetch();
  await hydrateFromBackend();
  calls.length = 0;
  save("b.capital.layouts", [1]);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
});
```

`mirrorSet` is module-private, which is why the test writes through the public
`save()` instead. Read `core.hosted.test.ts` first for how it drives
`hydrateFromBackend` and what key shape `save()` expects, and match it. The
assertion is about the PUT count, not the key, so any valid workspace key
works.

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd frontend && npx vitest run src/lib/persist/core.impersonation.test.ts`
Expected: the impersonating test FAILS with 1 PUT.

- [ ] **Step 3: Gate the flag**

In `frontend/src/lib/persist/core.ts`, import `isImpersonating` from
`../impersonation`, and change the enable site (around line 448):

```ts
  // Backend reachable and snapshot in hand: from here on, mirror every write up.
  // (Flipped BEFORE the writes below so seedBackendFromLocal's PUTs go through.)
  //
  // ...unless we are viewing the app as another user. Impersonation is
  // read-only server-side, so every mirrored write would 403; worse, the local
  // store currently holds THEIR workspace, so a mirror that did succeed would
  // write it into the admin's own account. Gated here rather than in
  // mirrorSet/mirrorDelete because this is the one flag both read.
  mirrorEnabled = !isImpersonating();
```

- [ ] **Step 4: Run to verify both pass**

Run: `cd frontend && npx vitest run src/lib/persist/core.impersonation.test.ts src/lib/persist/core.hosted.test.ts src/lib/persist/core.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/core.ts frontend/src/lib/persist/core.impersonation.test.ts
git commit -m "feat(impersonation): never mirror workspace writes while impersonating"
```

---

### Task 6: Enter, exit, and the banner

**Files:**
- Create: `frontend/src/lib/workspaceKeys.ts`, `frontend/src/components/ImpersonationBanner.tsx`, `frontend/src/components/ImpersonationBanner.test.tsx`
- Modify: `frontend/src/components/AccountGate.tsx`, `frontend/src/lib/persist/core.ts`, `frontend/src/lib/impersonation.ts`, `frontend/src/main.tsx`, `frontend/src/index.css`
- Test: `frontend/src/lib/impersonation.enter.test.ts`

**Interfaces:**
- Consumes: `setImpersonatedUserId` (Task 4).
- Produces:
  - `PREFIX` and `wipeWorkspaceKeys(): void` from `lib/workspaceKeys.ts`
  - `enterImpersonation(userId: string, email: string | null): void` and `exitImpersonation(): void` in `lib/impersonation.ts`
  - `impersonatedEmail(): string | null`
  - `<ImpersonationBanner />` default export

- [ ] **Step 1: Extract the wipe into a leaf module**

This exists to break an import cycle, so do it first and do it exactly this
way. `persist/core.ts` imports `impersonation.ts` (Task 5), and
`impersonation.ts` needs the wipe. If the wipe lives in `persist/core` or in
`AccountGate` (which imports `persist/core`), the graph closes on itself.

Create `frontend/src/lib/workspaceKeys.ts`:

```ts
// The workspace key namespace, and the one way to clear it. A leaf module with
// no imports of its own, deliberately: persist/core imports impersonation (for
// the mirror gate) and impersonation needs the wipe, so parking the wipe in
// either of them would close an import cycle.

export const PREFIX = "auto-trader";

/** Remove every namespaced workspace key from localStorage.
 *
 *  Two callers, wiping for the same reason: the local store is broker-keyed,
 *  not user-keyed, so without this one user's workspace sits on top of
 *  another's. AccountGate wipes when the signed-in Clerk user changes;
 *  impersonation wipes on entering and leaving a session, where the Clerk user
 *  does NOT change and so AccountGate never fires. */
export function wipeWorkspaceKeys(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(`${PREFIX}.`)) localStorage.removeItem(key);
  }
}
```

In `frontend/src/lib/persist/core.ts`, replace the `PREFIX` declaration on
line 10 with an import plus a re-export, so the 18 existing importers of
`PREFIX` from `persist/core` keep working untouched:

```ts
import { PREFIX } from "../workspaceKeys";

export { PREFIX };
```

In `frontend/src/components/AccountGate.tsx`, drop the inline loop and the
`PREFIX` import from `persist/core`:

```tsx
import { PREFIX, wipeWorkspaceKeys } from "../lib/workspaceKeys";
```

```tsx
  if (localStorage.getItem(LAST_USER_KEY) !== user.id) {
    wipeWorkspaceKeys();
    localStorage.setItem(LAST_USER_KEY, user.id);
  }
```

- [ ] **Step 2: Run the gate tests and typecheck the move**

Run: `cd frontend && npx vitest run src/components/AccountGate.test.tsx src/lib/persist/core.test.ts`
Expected: all pass, behaviour unchanged.

Run: `cd frontend && npx tsc -b`
Expected: no new errors. This is the step that proves the re-export did not
break any of the other importers.

- [ ] **Step 3: Write the failing enter/exit tests**

Create `frontend/src/lib/impersonation.enter.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

import {
  enterImpersonation,
  exitImpersonation,
  impersonatedEmail,
  impersonatedUserId,
} from "./impersonation";

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal("location", { assign: reload, href: "/" });
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.lastUserId", "user_admin");
  localStorage.setItem("unrelated.key", "1");
});

it("entering wipes the workspace, stores the target, and reloads to /", () => {
  enterImpersonation("user_target", "target@example.com");
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("unrelated.key")).toBe("1");
  expect(impersonatedUserId()).toBe("user_target");
  expect(impersonatedEmail()).toBe("target@example.com");
  expect(reload).toHaveBeenCalledWith("/");
});

it("exiting wipes the workspace, clears the target, and reloads to /admin", () => {
  enterImpersonation("user_target", "target@example.com");
  localStorage.setItem("auto-trader.b.capital.layouts", "[2]");
  reload.mockClear();
  exitImpersonation();
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(impersonatedUserId()).toBeNull();
  expect(impersonatedEmail()).toBeNull();
  expect(reload).toHaveBeenCalledWith("/admin");
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/impersonation.enter.test.ts`
Expected: FAIL, `enterImpersonation` is not exported.

- [ ] **Step 5: Implement enter and exit**

Append to `frontend/src/lib/impersonation.ts`:

```ts
import { wipeWorkspaceKeys } from "./workspaceKeys";

const EMAIL_KEY = "auto-trader.impersonateEmail";

/** The impersonated user's email, for the banner. Display only. */
export function impersonatedEmail(): string | null {
  try {
    return sessionStorage.getItem(EMAIL_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Start viewing the app as `userId`, then hard-reload.
 *
 * The reload is deliberate: re-plumbing a live app's dialers, caches and
 * hydrated stores mid-flight half-works, and a reload guarantees every module
 * boots in one mode.
 *
 * The wipe is required because the workspace keys are broker-keyed, not
 * user-keyed, and the Clerk client identity does NOT change under this
 * approach, so AccountGate never fires. Without it the target's hydrated
 * workspace would land on top of the admin's own keys. It is safe because the
 * admin's workspace lives on the backend and hydrate is backend-wins-on-load,
 * so it returns on exit. The device-local set (activeLayoutId, scratch,
 * autosave) genuinely does not survive, exactly as when signing in on a new
 * browser, and the confirm dialog says so.
 */
export function enterImpersonation(userId: string, email: string | null): void {
  wipeWorkspaceKeys();
  setImpersonatedUserId(userId);
  try {
    if (email) sessionStorage.setItem(EMAIL_KEY, email);
    else sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* see impersonatedUserId */
  }
  location.assign("/");
}

/** Stop impersonating and return to the console. Wipes again: the target's
 *  workspace is sitting in localStorage right now. */
export function exitImpersonation(): void {
  wipeWorkspaceKeys();
  setImpersonatedUserId(null);
  try {
    sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* see impersonatedUserId */
  }
  location.assign("/admin");
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/impersonation.enter.test.ts src/lib/impersonation.test.ts`
Expected: all pass.

- [ ] **Step 7: Write the failing banner test**

Create `frontend/src/components/ImpersonationBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { setImpersonatedUserId } from "../lib/impersonation";
import ImpersonationBanner from "./ImpersonationBanner";

const assign = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  assign.mockClear();
  vi.stubGlobal("location", { assign, href: "/" });
});

afterEach(() => {
  cleanup();
  setImpersonatedUserId(null);
});

it("renders nothing when not impersonating", () => {
  const { container } = render(<ImpersonationBanner />);
  expect(container.firstChild).toBeNull();
});

it("names the impersonated user and says it is read-only", () => {
  setImpersonatedUserId("user_target");
  sessionStorage.setItem("auto-trader.impersonateEmail", "target@example.com");
  render(<ImpersonationBanner />);
  expect(screen.getByText(/target@example.com/)).toBeDefined();
  expect(screen.getByText(/read-only/i)).toBeDefined();
});

it("falls back to the user id when no email is stored", () => {
  setImpersonatedUserId("user_target");
  render(<ImpersonationBanner />);
  expect(screen.getByText(/user_target/)).toBeDefined();
});

it("exits on click", () => {
  setImpersonatedUserId("user_target");
  render(<ImpersonationBanner />);
  fireEvent.click(screen.getByRole("button", { name: /exit/i }));
  expect(assign).toHaveBeenCalledWith("/admin");
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/ImpersonationBanner.test.tsx`
Expected: FAIL, cannot resolve `./ImpersonationBanner`.

- [ ] **Step 9: Implement the banner**

Create `frontend/src/components/ImpersonationBanner.tsx`:

```tsx
import {
  exitImpersonation,
  impersonatedEmail,
  impersonatedUserId,
} from "../lib/impersonation";

/** Pinned across the top while an admin is viewing the app as another user.
 *  Pure client state on purpose: is_admin is false for the duration, so
 *  /api/admin/* refuses this session and the exit cannot ask the server. */
export default function ImpersonationBanner() {
  const id = impersonatedUserId();
  if (!id) return null;
  const who = impersonatedEmail() ?? id;
  return (
    <div className="impersonation-banner" role="status">
      <span>
        Viewing as <strong>{who}</strong>, read-only
      </span>
      <button type="button" onClick={() => exitImpersonation()}>
        Exit
      </button>
    </div>
  );
}
```

- [ ] **Step 10: Style it**

Append to `frontend/src/index.css`:

```css
/* Admin impersonation. Deliberately loud: this is a safety affordance, not a
   preference toggle, and the one thing worse than not knowing you are
   impersonating is thinking you are not. */
.impersonation-banner {
  position: sticky;
  top: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 6px 12px;
  font-size: 13px;
  background: #b45309;
  color: #fff;
}

.impersonation-banner button {
  padding: 2px 10px;
  font: inherit;
  color: inherit;
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 4px;
  cursor: pointer;
}

.impersonation-banner button:hover {
  background: rgba(255, 255, 255, 0.3);
}
```

The amber reads on both themes, so it needs no `[data-theme]` variant.

- [ ] **Step 11: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/ImpersonationBanner.test.tsx`
Expected: 4 passed.

- [ ] **Step 12: Render it in main.tsx**

Import it and wrap the app branch inside `AccountGate` so it sits above every
boot mode:

```tsx
            <AccountGate>
              <ImpersonationBanner />
              {bootAdmin ? <AdminApp /> : bootMobile ? <MobileApp /> : <App />}
            </AccountGate>
```

`AccountGate` returns a fragment, so two children are fine. The banner renders
`null` when not impersonating, which is every normal session.

- [ ] **Step 13: Typecheck and commit**

Run: `cd frontend && npx tsc -b`

```bash
git add frontend/src/lib/workspaceKeys.ts frontend/src/components/ImpersonationBanner.tsx frontend/src/components/ImpersonationBanner.test.tsx frontend/src/components/AccountGate.tsx frontend/src/lib/persist/core.ts frontend/src/lib/impersonation.ts frontend/src/lib/impersonation.enter.test.ts frontend/src/main.tsx frontend/src/index.css
git commit -m "feat(impersonation): enter, exit, and the read-only banner"
```

---

### Task 7: The Users panel control

**Files:**
- Modify: `frontend/src/admin/api.ts`, `frontend/src/admin/UsersPanel.tsx`, `frontend/src/admin/admin.css`
- Test: `frontend/src/admin/UsersPanel.impersonate.test.tsx`

**Interfaces:**
- Consumes: `enterImpersonation` (Task 6); `ClerkUser` and `AdminHttpError` (existing in `admin/api.ts`).
- Produces: `startImpersonation(userId: string): Promise<{ user: ClerkUser }>` in `admin/api.ts`.

- [ ] **Step 1: Add the API call**

In `frontend/src/admin/api.ts`, next to the other exports:

```ts
export async function startImpersonation(
  userId: string,
): Promise<{ user: ClerkUser }> {
  const res = await apiFetch(`${API_BASE}/api/admin/impersonate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new AdminHttpError(res.status, await errorDetail(res));
  return (await res.json()) as { user: ClerkUser };
}
```

Check the file's existing imports: `errorDetail` may not be imported yet.

- [ ] **Step 2: Write the failing panel test**

Create `frontend/src/admin/UsersPanel.impersonate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const api = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  startImpersonation: vi.fn(),
}));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  fetchUsers: api.fetchUsers,
  startImpersonation: api.startImpersonation,
}));

const entered = vi.fn();
vi.mock("../lib/impersonation", () => ({ enterImpersonation: entered }));

import UsersPanel from "./UsersPanel";

const USER = {
  id: "user_target",
  email: "target@example.com",
  firstName: "Tara",
  lastName: "Get",
  imageUrl: null,
  createdAt: 0,
  lastActiveAt: 0,
  lastSignInAt: 0,
  banned: false,
  locked: false,
};

beforeEach(() => {
  entered.mockClear();
  api.fetchUsers.mockResolvedValue({
    configured: true,
    users: [USER],
    total: 1,
    error: null,
  });
  api.startImpersonation.mockResolvedValue({ user: USER });
  vi.stubGlobal("confirm", () => true);
});

afterEach(cleanup);

it("enters impersonation after the endpoint confirms the target", async () => {
  render(<UsersPanel />);
  const button = await screen.findByRole("button", { name: /view as/i });
  fireEvent.click(button);
  await waitFor(() =>
    expect(entered).toHaveBeenCalledWith("user_target", "target@example.com"),
  );
});

it("does nothing when the confirm is declined", async () => {
  vi.stubGlobal("confirm", () => false);
  render(<UsersPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /view as/i }));
  await waitFor(() => expect(api.startImpersonation).not.toHaveBeenCalled());
  expect(entered).not.toHaveBeenCalled();
});

it("shows the error and stays put when the endpoint rejects", async () => {
  api.startImpersonation.mockRejectedValue(new Error("no such user"));
  render(<UsersPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /view as/i }));
  expect(await screen.findByText(/no such user/)).toBeDefined();
  expect(entered).not.toHaveBeenCalled();
});
```

Read `UsersPanel.tsx` first and match how it already fetches and renders. If
its data comes in via props rather than `fetchUsers`, drop the `fetchUsers`
mock and pass props instead.

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/admin/UsersPanel.impersonate.test.tsx`
Expected: FAIL, no "View as" button.

- [ ] **Step 4: Add the column and the handler**

In `frontend/src/admin/UsersPanel.tsx`, add state and a handler:

```tsx
const [impersonateError, setImpersonateError] = useState<string | null>(null);

async function viewAs(user: ClerkUser) {
  const who = user.email ?? user.id;
  const ok = confirm(
    `View the app as ${who}?\n\n` +
      "Read-only: you will not be able to change their data.\n\n" +
      "This clears this browser's local workspace state. Your saved layouts " +
      "come back from the server when you exit, but unsaved scratch state and " +
      "the layout this device had open do not.",
  );
  if (!ok) return;
  setImpersonateError(null);
  try {
    const res = await startImpersonation(user.id);
    enterImpersonation(res.user.id, res.user.email);
  } catch (e) {
    setImpersonateError(e instanceof Error ? e.message : String(e));
  }
}
```

Add a header cell and, per row, the control:

```tsx
                  <td>
                    <button
                      type="button"
                      className="admin-view-as"
                      onClick={() => void viewAs(u)}
                    >
                      View as
                    </button>
                  </td>
```

Render the error above the table when set:

```tsx
      {impersonateError && <p className="admin-error">{impersonateError}</p>}
```

Reuse whatever error class the panel already uses for its Clerk error, rather
than adding a second one.

- [ ] **Step 5: Style the button**

Append to `frontend/src/admin/admin.css`:

```css
.admin-view-as {
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.admin-view-as:hover {
  background: var(--surface);
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd frontend && npx vitest run src/admin/UsersPanel.impersonate.test.tsx src/admin/UsagePanel.test.tsx src/admin/AdminApp.test.tsx src/admin/useIsAdmin.test.tsx`
Expected: all pass.

- [ ] **Step 7: Typecheck and commit**

Run: `cd frontend && npx tsc -b`

```bash
git add frontend/src/admin/api.ts frontend/src/admin/UsersPanel.tsx frontend/src/admin/admin.css frontend/src/admin/UsersPanel.impersonate.test.tsx
git commit -m "feat(admin): add View as to the Users panel"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Add the section**

Append to the "## Admin console" section in `CLAUDE.md`:

```markdown
### Impersonation

An admin can view the app read-only as any Clerk user. The admin's own token
stays the credential: the target id rides in the `X-Impersonate-User` header
(HTTP) or the `impersonate` query param (WebSocket), and
`auth.resolve_impersonation` swaps the identity at both call sites, forces
`is_admin` false and refuses every method outside GET/HEAD. Nothing is minted,
so ending a session is dropping the header.

Because `is_admin` is false for the duration, `/api/admin/*` refuses an
impersonating session: the exit control is pure client state
(`components/ImpersonationBanner.tsx`). The frontend keeps the target in
`sessionStorage` via `lib/impersonation.ts`, which every transport reads;
entering and exiting wipe the local workspace and hard-reload, because the
workspace keys are broker-keyed rather than user-keyed. Persist stops
mirroring writes while impersonating.

Audit lines go to the `auto_trader.impersonation` logger: a start line per
session, a throttled summary while active, and an unthrottled warning for
every refusal. They reach stdout, so journald keeps them across a restart; the
Logs panel shows them from the ring buffer, which does not.

The render-token path refuses the header outright, so the two "act as another
user" mechanisms cannot stack. Impersonation is inert in local dev.

See docs/superpowers/specs/2026-09-12-user-impersonation-design.md.
```

- [ ] **Step 2: Run the full affected test set once more**

Run: `cd backend && .venv/bin/python -m pytest tests/test_impersonation_http.py tests/test_impersonation_ws.py tests/test_impersonation_audit.py tests/test_api_admin_impersonate.py tests/test_api_auth_http.py tests/test_api_auth_ws.py tests/test_api_admin_console.py tests/test_api_admin_gate.py tests/test_clerk_admin.py -v`

Run: `cd frontend && npx vitest run src/lib/impersonation.test.ts src/lib/impersonation.enter.test.ts src/lib/http.apiFetch.test.ts src/lib/persist/core.impersonation.test.ts src/components/ImpersonationBanner.test.tsx src/components/AccountGate.test.tsx src/admin/UsersPanel.impersonate.test.tsx`

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document admin impersonation"
```

---

## Manual verification

After Task 7, before deploying, check by hand in the browser. Automated tests
cannot catch the split-brain failure this feature is most likely to have.

1. Sign in as an admin, open `/admin`, click View as on a non-admin user.
2. The app loads with the amber banner naming that user.
3. Their workspace, not yours, is on screen. Their alerts list is theirs.
4. The account menu no longer shows the Admin entry.
5. The browser console shows no repeating 403s. A stream of them means the
   mirror gate in Task 5 is not holding.
6. Navigating to `/admin` directly shows the denial, not the panels.
7. Click Exit. Your own workspace comes back from the server.
8. On the box, `journalctl -u auto-trader-demo | grep impersonation` shows the
   start line and a summary.
