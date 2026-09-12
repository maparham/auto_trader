# Public Demo Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-out visitors to the hosted app see the real Chartkar UI on an admin-published layout with Dukascopy data, interactive but session-local, with browsable pre-baked backtest results and sign-up CTAs on locked features.

**Architecture:** A "demo principal" opens a narrow anonymous GET allowlist in the existing Clerk auth middleware (`user_id="demo"`, dukascopy-only, per-IP rate limited). A small versioned server-side store holds the published demo snapshot (layout JSON + symbol whitelist + canned backtest results) written by admin-gated endpoints. The frontend, when Clerk is enabled and the visitor is signed out, boots the real `App` in a demo mode that fixes the broker, disables the backend persistence mirror, hides locked features behind CTAs, and renders canned backtest results.

**Tech Stack:** FastAPI + stdlib sqlite3 (backend, matching `state_store.py` patterns), React + Vitest (frontend), Clerk (auth).

**Spec:** `docs/superpowers/specs/2026-09-12-public-demo-page-design.md`

## Global Constraints

- Never use "—" or "--" in UI copy or docs prose; split the sentence instead.
- Persistent toggle buttons use muted gray active states, not solid accent blue.
- Tooltip copy: short scannable lines; `Tooltip`/`InfoTip` components, never `title=`.
- Frontend tests: run ONLY the affected test files (`npx vitest run <file>`), never the whole suite.
- Frontend typecheck: `cd frontend && npx tsc -b` (not `--noEmit`), judge by per-file parity with main.
- Backend tests: `cd backend && python3 -m pytest <file> -q`.
- Commit after each task to the current branch; stage by explicit path only (shared worktree; never `git add -A`, never stash).
- Dev mode (`CLERK_JWKS_URL` unset) behavior must be byte-for-byte unchanged.

---

### Task 1: Demo request allowlist module

**Files:**
- Create: `backend/auto_trader/api/demo_access.py`
- Test: `backend/tests/test_demo_access.py`

**Interfaces:**
- Produces: `demo_path_allowed(method: str, path: str) -> bool`; `is_demo_request(obj) -> bool` (Request or WebSocket); `DEMO_USER_ID = "demo"`.
- Consumes: nothing project-specific.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_demo_access.py
from auto_trader.api.demo_access import DEMO_USER_ID, demo_path_allowed


def test_allowed_get_paths():
    for path in [
        "/api/candles",
        "/api/candles/synthetic",
        "/api/markets",
        "/api/market/US100",
        "/api/market/US100/details",
        "/api/brokers",
        "/api/demo/snapshot",
    ]:
        assert demo_path_allowed("GET", path), path


def test_writes_never_allowed():
    assert not demo_path_allowed("POST", "/api/candles")
    assert not demo_path_allowed("PUT", "/api/state/auto-trader.tabs")
    assert not demo_path_allowed("POST", "/api/demo/snapshot")


def test_sensitive_paths_never_allowed():
    for path in [
        "/api/state",
        "/api/alerts",
        "/api/backtest",
        "/api/admin/usage",
        "/api/admin/demo/publish",
        "/api/favorites",
        "/api/positions",
    ]:
        assert not demo_path_allowed("GET", path), path


def test_demo_user_id():
    assert DEMO_USER_ID == "demo"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_demo_access.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.api.demo_access`

- [ ] **Step 3: Implement the module**

```python
# backend/auto_trader/api/demo_access.py
"""Anonymous demo access: the narrow public surface for signed-out visitors.

In hosted mode (CLERK_JWKS_URL set) a request without a bearer token is not
always a 401 anymore: if it matches this GET-only allowlist it runs as the
shared read-only principal DEMO_USER_ID. Everything else keeps the 401.
Broker scoping (dukascopy only) is enforced in deps.resolve_broker, and
per-IP throttling in demo_limit.py; this module is ONLY the path gate.
"""

from __future__ import annotations

import re

DEMO_USER_ID = "demo"

# Exact-match paths and anchored patterns. Deliberately a literal allowlist,
# not a denylist: new routers are private-by-default.
_EXACT = frozenset(
    {
        "/api/candles",
        "/api/candles/synthetic",
        "/api/markets",
        "/api/brokers",
        "/api/demo/snapshot",
    }
)
_PATTERNS = (
    re.compile(r"^/api/market/[^/]+$"),
    re.compile(r"^/api/market/[^/]+/details$"),
)


def demo_path_allowed(method: str, path: str) -> bool:
    """Whether an anonymous request may run as the demo principal."""
    if method not in ("GET", "HEAD"):
        return False
    if path in _EXACT:
        return True
    return any(p.match(path) for p in _PATTERNS)


def is_demo_request(obj) -> bool:
    """Whether this Request/WebSocket runs as the demo principal (stamped by
    the auth middleware). Fail closed: absent flag means not demo."""
    return bool(getattr(obj.state, "is_demo", False))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_demo_access.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/demo_access.py backend/tests/test_demo_access.py
git commit -m "feat(demo): anonymous demo path allowlist"
```

---

### Task 2: Per-IP rate limiter for demo requests

**Files:**
- Create: `backend/auto_trader/api/demo_limit.py`
- Test: `backend/tests/test_demo_limit.py`

**Interfaces:**
- Produces: `demo_rate_ok(client_ip: str, now: float | None = None) -> bool` (token bucket; False means respond 429). Env knobs `DEMO_RATE_PER_MIN` (default 120) and `DEMO_RATE_BURST` (default 40), read per call so tests can monkeypatch.
- Consumes: nothing project-specific.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_demo_limit.py
from auto_trader.api import demo_limit
from auto_trader.api.demo_limit import demo_rate_ok


def setup_function(_):
    demo_limit._buckets.clear()


def test_burst_then_throttle(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_PER_MIN", "60")
    monkeypatch.setenv("DEMO_RATE_BURST", "5")
    t = 1000.0
    assert all(demo_rate_ok("1.2.3.4", now=t) for _ in range(5))
    assert not demo_rate_ok("1.2.3.4", now=t)


def test_refills_over_time(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_PER_MIN", "60")  # 1 token/sec
    monkeypatch.setenv("DEMO_RATE_BURST", "1")
    assert demo_rate_ok("5.6.7.8", now=1000.0)
    assert not demo_rate_ok("5.6.7.8", now=1000.1)
    assert demo_rate_ok("5.6.7.8", now=1001.5)


def test_ips_are_independent(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_BURST", "1")
    assert demo_rate_ok("a", now=0.0)
    assert demo_rate_ok("b", now=0.0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_demo_limit.py -q`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement the limiter**

```python
# backend/auto_trader/api/demo_limit.py
"""Per-IP token bucket for the anonymous demo surface.

The demo allowlist is the only unauthenticated app surface, so it gets the
only inbound rate limit. In-process and best-effort by design (single
uvicorn process today); env-tunable without restart since env is read per
call. Buckets are pruned lazily so the dict cannot grow unbounded."""

from __future__ import annotations

import os
import time

_buckets: dict[str, tuple[float, float]] = {}  # ip -> (tokens, last_ts)
_MAX_BUCKETS = 10_000


def _cfg() -> tuple[float, float]:
    per_min = float(os.environ.get("DEMO_RATE_PER_MIN", "120"))
    burst = float(os.environ.get("DEMO_RATE_BURST", "40"))
    return max(per_min, 1.0) / 60.0, max(burst, 1.0)


def demo_rate_ok(client_ip: str, now: float | None = None) -> bool:
    """Take one token for this IP; False when the bucket is empty (429)."""
    rate, burst = _cfg()
    ts = time.monotonic() if now is None else now
    tokens, last = _buckets.get(client_ip, (burst, ts))
    tokens = min(burst, tokens + (ts - last) * rate)
    if tokens < 1.0:
        _buckets[client_ip] = (tokens, ts)
        return False
    if len(_buckets) > _MAX_BUCKETS:
        _buckets.clear()  # crude but safe: full buckets refill instantly
    _buckets[client_ip] = (tokens - 1.0, ts)
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_demo_limit.py -q`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/demo_limit.py backend/tests/test_demo_limit.py
git commit -m "feat(demo): per-IP token bucket for the demo surface"
```

---

### Task 3: Demo principal in the auth middleware

**Files:**
- Modify: `backend/auto_trader/api/auth.py` (the `_auth` middleware, the `if not authz.startswith("Bearer ")` branch, ~line 155)
- Modify: `backend/auto_trader/api/deps.py` (`resolve_broker`, ~line 80; `request_is_admin` untouched)
- Test: `backend/tests/test_demo_principal.py`

**Interfaces:**
- Consumes: `demo_path_allowed`, `demo_rate_ok`, `DEMO_USER_ID`, `is_demo_request` from Tasks 1-2.
- Produces: hosted-mode anonymous requests on the allowlist run with `request.state.user_id == "demo"`, `request.state.is_admin == False`, `request.state.is_demo == True`, `request.state.claims == {}`. All authenticated paths stamp `is_demo = False`. `resolve_broker` raises 403 for demo requests naming any broker other than `"dukascopy"`, and defaults empty broker to `"dukascopy"` for demo requests.

- [ ] **Step 1: Write the failing tests**

Follow the existing auth test file's app-fixture pattern (look at `backend/tests/` for the file that tests `install_auth` with a dummy FastAPI app and `CLERK_JWKS_URL` monkeypatched; reuse its fixture style):

```python
# backend/tests/test_demo_principal.py
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import install_auth


@pytest.fixture()
def hosted_app(monkeypatch):
    monkeypatch.setenv("CLERK_JWKS_URL", "https://x.example/jwks.json")
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://app.example")
    app = FastAPI()
    install_auth(app)

    @app.get("/api/candles")
    async def candles(request: Request) -> dict:
        return {
            "user": request.state.user_id,
            "demo": request.state.is_demo,
            "admin": request.state.is_admin,
        }

    @app.get("/api/alerts")
    async def alerts(request: Request) -> dict:
        return {"user": request.state.user_id}

    @app.post("/api/candles")
    async def candles_post() -> dict:
        return {}

    return TestClient(app)


def test_anonymous_allowlisted_get_runs_as_demo(hosted_app):
    r = hosted_app.get("/api/candles")
    assert r.status_code == 200
    assert r.json() == {"user": "demo", "demo": True, "admin": False}


def test_anonymous_off_allowlist_still_401(hosted_app):
    assert hosted_app.get("/api/alerts").status_code == 401


def test_anonymous_post_still_401(hosted_app):
    assert hosted_app.post("/api/candles").status_code == 401


def test_demo_rate_limited(hosted_app, monkeypatch):
    from auto_trader.api import demo_limit

    demo_limit._buckets.clear()
    monkeypatch.setenv("DEMO_RATE_BURST", "2")
    assert hosted_app.get("/api/candles").status_code == 200
    assert hosted_app.get("/api/candles").status_code == 200
    assert hosted_app.get("/api/candles").status_code == 429
    demo_limit._buckets.clear()


def test_dev_mode_unchanged(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    app = FastAPI()
    install_auth(app)

    @app.get("/x")
    async def x(request: Request) -> dict:
        return {"user": request.state.user_id, "demo": request.state.is_demo}

    r = TestClient(app).get("/x")
    assert r.json() == {"user": "dev", "demo": False}
```

And the broker scoping tests (same file):

```python
def _demo_request() -> Request:
    scope = {"type": "http", "method": "GET", "path": "/api/candles", "headers": []}
    req = Request(scope)
    req.state.is_demo = True
    req.state.is_admin = False
    return req


def test_resolve_broker_demo_is_dukascopy_only(monkeypatch):
    from auto_trader.api import deps
    from auto_trader.brokers.registry import BrokerRegistry

    reg = BrokerRegistry()
    # register a fake dukascopy + one other data broker the way existing
    # registry tests do (copy the stub pattern from the registry test file)
    monkeypatch.setattr(deps, "_registry", reg, raising=True)
    monkeypatch.setenv("CLERK_JWKS_URL", "https://x.example/jwks.json")
    # ... register stubs "dukascopy" and "yfinance" per existing test helpers
    assert deps.resolve_broker(_demo_request(), "") == "dukascopy"
    assert deps.resolve_broker(_demo_request(), "dukascopy") == "dukascopy"
    with pytest.raises(Exception) as ei:
        deps.resolve_broker(_demo_request(), "yfinance")
    assert getattr(ei.value, "status_code", None) == 403
```

(The registry stub registration must copy the exact helper used by the existing `resolve_broker` tests; find them with `grep -rn "resolve_broker" backend/tests/`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_demo_principal.py -q`
Expected: FAIL (`is_demo` attribute missing → AttributeError / 401 on allowlisted GET)

- [ ] **Step 3: Modify `auth.py`**

In the `_auth` middleware:

1. Dev-mode branch (`if not auth_enabled():`): add `request.state.is_demo = False` next to the existing stamps.
2. Render-token branch and Clerk branch: add `request.state.is_demo = False` next to their existing stamps.
3. Replace the bare 401 for a missing bearer token:

```python
        authz = request.headers.get("authorization", "")
        if not authz.startswith("Bearer "):
            # Signed-out visitor: the demo principal covers a narrow GET-only
            # allowlist (see demo_access.py); everything else keeps the 401.
            if demo_path_allowed(request.method, path):
                client_ip = request.client.host if request.client else "?"
                if not demo_rate_ok(client_ip):
                    return JSONResponse(
                        status_code=429, content={"detail": "demo rate limit"}
                    )
                request.state.user_id = DEMO_USER_ID
                request.state.is_admin = False
                request.state.is_demo = True
                request.state.claims = {}
                return await call_next(request)
            return JSONResponse(
                status_code=401, content={"detail": "missing bearer token"}
            )
```

With imports at top: `from auto_trader.api.demo_access import DEMO_USER_ID, demo_path_allowed` and `from auto_trader.api.demo_limit import demo_rate_ok`.

`verify_ws` is untouched: no token still closes 4401, so `/ws/state` stays shut to demo visitors.

- [ ] **Step 4: Modify `deps.resolve_broker`**

```python
def resolve_broker(request: Request, broker_id: str) -> str:
    """Resolve a caller-supplied broker id (possibly empty) to a data broker
    this request may use; 403 for non-admin access to a restricted broker.
    The anonymous demo principal is pinned to dukascopy outright."""
    assert _registry is not None, "registry not initialised"
    if is_demo_request(request):
        bid = broker_id or "dukascopy"
        if bid != "dukascopy":
            raise HTTPException(403, "demo access is limited to dukascopy")
        return bid
    if request_is_admin(request):
        return broker_id or _registry.default_data_id()
    bid = broker_id or _registry.default_data_id(unrestricted_only=True)
    if _registry.is_restricted(bid):
        raise HTTPException(403, f"broker '{bid}' requires admin access")
    return bid
```

Import: `from auto_trader.api.demo_access import is_demo_request`.

- [ ] **Step 5: Run tests to verify they pass, plus the existing auth and deps test files**

Run: `cd backend && python3 -m pytest tests/test_demo_principal.py -q`, then the existing auth/deps test files (find them via `grep -rln "install_auth\|resolve_broker" backend/tests/`).
Expected: all PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/auto_trader/api/deps.py backend/tests/test_demo_principal.py
git commit -m "feat(demo): anonymous demo principal, dukascopy-scoped and rate limited"
```

---

### Task 4: Versioned demo snapshot store

**Files:**
- Create: `backend/auto_trader/core/demo_store.py`
- Test: `backend/tests/test_demo_store.py`

**Interfaces:**
- Produces: `class DemoStore(db_path)` with async methods `publish(payload: str, published_by: str) -> int` (returns new version), `latest() -> tuple[int, str] | None`, `versions() -> list[dict]` (`{"version", "publishedBy", "createdAt", "size"}`, newest first), `get(version: int) -> str | None`. Payload is an opaque JSON string, exactly like `state_store.py` values. Module global `DEMO_STORE = DemoStore(os.environ.get("DEMO_DB", "demo_store.db"))` built lazily via `get_demo_store()` (mirrors how `state_store` is instantiated; copy that instantiation pattern from `api/routers/state.py`).
- Consumes: `auto_trader.core.db_migrate.run_migrations` (same as `state_store.py`).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_demo_store.py
import asyncio

from auto_trader.core.demo_store import DemoStore


def test_publish_and_latest(tmp_path):
    store = DemoStore(str(tmp_path / "demo.db"))
    assert asyncio.run(store.latest()) is None
    v1 = asyncio.run(store.publish('{"layout": 1}', "admin@x"))
    v2 = asyncio.run(store.publish('{"layout": 2}', "admin@x"))
    assert (v1, v2) == (1, 2)
    assert asyncio.run(store.latest()) == (2, '{"layout": 2}')


def test_versions_and_get(tmp_path):
    store = DemoStore(str(tmp_path / "demo.db"))
    asyncio.run(store.publish('{"a": 1}', "admin@x"))
    asyncio.run(store.publish('{"a": 2}', "other@x"))
    vs = store.versions_sync()
    assert [v["version"] for v in vs] == [2, 1]
    assert vs[0]["publishedBy"] == "other@x"
    assert asyncio.run(store.get(1)) == '{"a": 1}'
    assert asyncio.run(store.get(99)) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_demo_store.py -q`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement the store**

Copy `state_store.py`'s structure exactly (module docstring style, fresh connection per op, schema on every connection, `asyncio.to_thread` wrappers):

```python
# backend/auto_trader/core/demo_store.py
"""Published demo snapshots: the layout + watchlist + canned backtests the
public home page serves to signed-out visitors.

Append-only and versioned: every publish is a new row, latest wins, rollback
is republishing an old payload as a new version (done in the router). Payload
is an opaque JSON string, never parsed here, exactly like state_store."""

from __future__ import annotations

import asyncio
import sqlite3
import time

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS demo_snapshot ("
    "version INTEGER PRIMARY KEY AUTOINCREMENT, "
    "payload TEXT NOT NULL, published_by TEXT NOT NULL, "
    "created_at INTEGER NOT NULL)"
)


class DemoStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        conn.commit()
        return conn

    async def publish(self, payload: str, published_by: str) -> int:
        return await asyncio.to_thread(self._publish_sync, payload, published_by)

    def _publish_sync(self, payload: str, published_by: str) -> int:
        conn = self._connect()
        try:
            cur = conn.execute(
                "INSERT INTO demo_snapshot (payload, published_by, created_at) "
                "VALUES (?, ?, ?)",
                (payload, published_by, int(time.time())),
            )
            conn.commit()
            return int(cur.lastrowid)
        finally:
            conn.close()

    async def latest(self) -> tuple[int, str] | None:
        return await asyncio.to_thread(self._latest_sync)

    def _latest_sync(self) -> tuple[int, str] | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT version, payload FROM demo_snapshot "
                "ORDER BY version DESC LIMIT 1"
            ).fetchone()
            return (int(row[0]), row[1]) if row else None
        finally:
            conn.close()

    async def get(self, version: int) -> str | None:
        return await asyncio.to_thread(self._get_sync, version)

    def _get_sync(self, version: int) -> str | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT payload FROM demo_snapshot WHERE version = ?", (version,)
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    async def versions(self) -> list[dict]:
        return await asyncio.to_thread(self.versions_sync)

    def versions_sync(self) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT version, published_by, created_at, length(payload) "
                "FROM demo_snapshot ORDER BY version DESC LIMIT 50"
            ).fetchall()
            return [
                {
                    "version": int(v),
                    "publishedBy": by,
                    "createdAt": int(ts),
                    "size": int(size),
                }
                for v, by, ts, size in rows
            ]
        finally:
            conn.close()
```

Then add the lazy singleton, copying the exact instantiation/env pattern the state store uses (read `backend/auto_trader/api/routers/state.py` first; mirror it with env var `DEMO_DB`, default `demo_store.db`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_demo_store.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/demo_store.py backend/tests/test_demo_store.py
git commit -m "feat(demo): versioned demo snapshot store"
```

---

### Task 5: Demo routers (public snapshot + admin publish/rollback)

**Files:**
- Create: `backend/auto_trader/api/routers/demo.py`
- Modify: `backend/auto_trader/api/app.py` (register the router where the other routers are included)
- Test: `backend/tests/test_demo_router.py`

**Interfaces:**
- Consumes: `DemoStore` (Task 4), `deps.require_admin_console`, `deps.current_user`, `deps.get_data("dukascopy")`.
- Produces:
  - `GET /api/demo/snapshot` (public via Task 1 allowlist) → `{"version": int, "payload": {...}}` or 404 `{"detail": "no demo published"}`.
  - `POST /api/admin/demo/publish` (admin) body `{"layout": object, "watchlist": [epic...], "backtests": [{"name": str, "result": object}...]}` → `{"version": int}`. Validates: watchlist non-empty; every epic resolves on the dukascopy broker (404 from the broker → 422 listing the bad epics); layout is a JSON object.
  - `GET /api/admin/demo/versions` (admin) → `{"versions": [...]}` from `DemoStore.versions()`.
  - `POST /api/admin/demo/rollback` (admin) body `{"version": int}` → republishes that payload as a new version, `{"version": int}`; 404 for unknown version.

- [ ] **Step 1: Write the failing tests**

Use the project's existing API test fixture for a full app with a stub registry (find it: `grep -rln "TestClient(app)\|create_app\|build_app" backend/tests/ | head`; reuse the fixture that other router tests use, monkeypatching `DEMO_DB` to a tmp_path file and running in dev mode so every request is admin). Cover:

```python
# backend/tests/test_demo_router.py  (sketch; adapt to the shared fixture)
def test_snapshot_404_before_publish(client):
    r = client.get("/api/demo/snapshot")
    assert r.status_code == 404
    assert r.json()["detail"] == "no demo published"


def test_publish_then_fetch_roundtrip(client):
    body = {
        "layout": {"tabs": []},
        "watchlist": ["US100", "EURUSD"],
        "backtests": [{"name": "NQ breakout", "result": {"trades": []}}],
    }
    r = client.post("/api/admin/demo/publish", json=body)
    assert r.status_code == 200 and r.json()["version"] == 1
    snap = client.get("/api/demo/snapshot").json()
    assert snap["version"] == 1
    assert snap["payload"]["watchlist"] == ["US100", "EURUSD"]


def test_publish_rejects_empty_watchlist(client):
    r = client.post(
        "/api/admin/demo/publish",
        json={"layout": {}, "watchlist": [], "backtests": []},
    )
    assert r.status_code == 422


def test_publish_rejects_unknown_epic(client):
    # stub dukascopy data broker raises for "NOPE" per the fixture's stub
    r = client.post(
        "/api/admin/demo/publish",
        json={"layout": {}, "watchlist": ["NOPE"], "backtests": []},
    )
    assert r.status_code == 422
    assert "NOPE" in r.json()["detail"]


def test_rollback(client):
    for i in (1, 2):
        client.post(
            "/api/admin/demo/publish",
            json={"layout": {"v": i}, "watchlist": ["US100"], "backtests": []},
        )
    r = client.post("/api/admin/demo/rollback", json={"version": 1})
    assert r.status_code == 200 and r.json()["version"] == 3
    assert client.get("/api/demo/snapshot").json()["payload"]["layout"] == {"v": 1}
    assert client.post("/api/admin/demo/rollback", json={"version": 99}).status_code == 404


def test_versions_listing(client):
    client.post(
        "/api/admin/demo/publish",
        json={"layout": {}, "watchlist": ["US100"], "backtests": []},
    )
    vs = client.get("/api/admin/demo/versions").json()["versions"]
    assert vs[0]["version"] == 1
```

Epic validation in the stub: whatever market-lookup method the dukascopy broker exposes (check `backend/auto_trader/brokers/dukascopy.py` and `base.py` for the method `markets.py:51` `/api/market/{epic}` uses), the fixture's stub must accept `US100`/`EURUSD` and raise/404 for `NOPE`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_demo_router.py -q`
Expected: FAIL (404 route not found)

- [ ] **Step 3: Implement the router**

```python
# backend/auto_trader/api/routers/demo.py
"""Public demo snapshot + admin publish endpoints.

GET /api/demo/snapshot is reachable anonymously through the demo allowlist
(api/demo_access.py); the admin surface is gated exactly like the admin
console. Rollback republished as a NEW version so history stays append-only.
See docs/superpowers/specs/2026-09-12-public-demo-page-design.md.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auto_trader.core.demo_store import get_demo_store

from .. import deps
from ..deps import current_user, require_admin_console

router = APIRouter()
admin_router = APIRouter(
    prefix="/api/admin/demo", dependencies=[Depends(require_admin_console)]
)


@router.get("/api/demo/snapshot")
async def demo_snapshot() -> dict:
    latest = await get_demo_store().latest()
    if latest is None:
        raise HTTPException(404, "no demo published")
    version, payload = latest
    return {"version": version, "payload": json.loads(payload)}


class PublishBody(BaseModel):
    layout: dict
    watchlist: list[str]
    backtests: list[dict] = []


class RollbackBody(BaseModel):
    version: int


def _validate_watchlist(epics: list[str]) -> None:
    if not epics:
        raise HTTPException(422, "watchlist must not be empty")
    broker = deps.get_data("dukascopy")
    bad = []
    for epic in epics:
        try:
            # same lookup /api/market/{epic} uses; adapt the call to the
            # actual MarketDataBroker method name found in markets.py:51
            broker.get_market(epic)
        except Exception:
            bad.append(epic)
    if bad:
        raise HTTPException(422, f"unknown dukascopy epics: {', '.join(bad)}")


@admin_router.post("/publish")
async def publish(body: PublishBody, request: Request) -> dict:
    _validate_watchlist(body.watchlist)
    payload = json.dumps(
        {"layout": body.layout, "watchlist": body.watchlist, "backtests": body.backtests}
    )
    version = await get_demo_store().publish(payload, current_user(request))
    return {"version": version}


@admin_router.get("/versions")
async def versions() -> dict:
    return {"versions": await get_demo_store().versions()}


@admin_router.post("/rollback")
async def rollback(body: RollbackBody, request: Request) -> dict:
    payload = await get_demo_store().get(body.version)
    if payload is None:
        raise HTTPException(404, f"no demo version {body.version}")
    version = await get_demo_store().publish(payload, current_user(request))
    return {"version": version}
```

Adjust `_validate_watchlist` to the real broker lookup method (read `markets.py:51-72` first; if the lookup is async, await it). If lookups can block (network), wrap the loop in `asyncio.to_thread`. Register both routers in `app.py` next to the other `include_router` calls.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_demo_router.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/demo.py backend/auto_trader/api/app.py backend/tests/test_demo_router.py
git commit -m "feat(demo): public snapshot endpoint and admin publish/rollback"
```

---

### Task 6: Frontend demo mode flag and persistence lockdown

**Files:**
- Create: `frontend/src/lib/demoMode.ts`
- Modify: `frontend/src/lib/persist/core.ts` (`save()` ~line 300, `mirrorDelete()` ~line 253, `hydrateFromBackend()` ~line 429)
- Test: `frontend/src/lib/__tests__/demoMode.test.ts` (or the directory where persist tests live; check `ls frontend/src/lib/persist/__tests__ frontend/src/**/__tests__` first and follow suit)

**Interfaces:**
- Produces: `setDemoMode(): void` (one-way, called once at boot before React renders), `isDemoMode(): boolean`. In demo mode: `save()` and `mirrorDelete()` never issue network calls; `hydrateFromBackend()` returns `false` immediately without fetching.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

```typescript
// demoMode.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("demo mode persistence lockdown", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("flag is one-way and default off", async () => {
    const { isDemoMode, setDemoMode } = await import("../demoMode");
    expect(isDemoMode()).toBe(false);
    setDemoMode();
    expect(isDemoMode()).toBe(true);
  });

  it("save() writes localStorage but never fetches in demo mode", async () => {
    const { setDemoMode } = await import("../demoMode");
    setDemoMode();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { save, hydrateFromBackend } = await import("../persist/core");
    await hydrateFromBackend(); // would normally enable mirroring
    save("auto-trader.test-key", { a: 1 });
    expect(localStorage.getItem("auto-trader.test-key")).toBe('{"a":1}');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hydrateFromBackend resolves false without fetching in demo mode", async () => {
    const { setDemoMode } = await import("../demoMode");
    setDemoMode();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { hydrateFromBackend } = await import("../persist/core");
    await expect(hydrateFromBackend()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/demoMode.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```typescript
// frontend/src/lib/demoMode.ts
// Anonymous demo boot flag. Set ONCE in main.tsx before React renders when a
// signed-out visitor gets the demo home page; read by the persist layer (no
// backend mirror, no hydrate) and by App feature gates. One-way by design so
// no code path can accidentally re-enable mirroring mid-session.
let demo = false;

export function setDemoMode(): void {
  demo = true;
}

export function isDemoMode(): boolean {
  return demo;
}
```

In `persist/core.ts`: import `isDemoMode`; add `if (isDemoMode()) return;` as the first line of `mirrorSet` and `mirrorDelete`, and `if (isDemoMode()) return false;` at the top of `hydrateFromBackend` (before any fetch and before `mirrorEnabled` flips true). Also gate the `/ws/state` subscription if it is opened inside `persist/core.ts` or wherever `hydrateFromBackend`'s caller opens it (grep `ws/state` in `frontend/src`; the demo boot must never dial it).

- [ ] **Step 4: Run tests to verify they pass, plus existing persist tests**

Run: `cd frontend && npx vitest run src/lib/__tests__/demoMode.test.ts` plus the existing persist core test file(s) only.
Expected: PASS, no regressions.

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && npx tsc -b` (judge by per-file parity).

```bash
git add frontend/src/lib/demoMode.ts frontend/src/lib/persist/core.ts frontend/src/lib/__tests__/demoMode.test.ts
git commit -m "feat(demo): demo mode flag locks out the backend persistence mirror"
```

---

### Task 7: Demo boot in main.tsx and the DemoApp shell

**Files:**
- Create: `frontend/src/DemoApp.tsx`, `frontend/src/lib/demoBoot.ts`, `frontend/src/lib/demoSnapshot.ts`
- Modify: `frontend/src/main.tsx` (the `<SignedOut>` branch, line ~64)
- Test: `frontend/src/lib/__tests__/demoBoot.test.ts`

**Interfaces:**
- Consumes: `setDemoMode` (Task 6), `parseShellAuthParams` (existing), the `/api/demo/snapshot` endpoint (Task 5).
- Produces:
  - `shouldShowSignIn(search: string): boolean` in `demoBoot.ts`: true for `?sign_in=1` or when running inside the native shell (detect the shell the same way existing code does; `grep -rn "isShell\|__TAURI" frontend/src/lib` and reuse that helper). Demo renders only when this is false.
  - `demoSnapshot.ts`: `fetchDemoSnapshot(): Promise<DemoSnapshot | null>` where `type DemoSnapshot = { version: number; layout: Record<string, unknown>; watchlist: string[]; backtests: { name: string; result: Record<string, unknown> }[] }`; `null` on 404 or network error. Module-level `let current: DemoSnapshot | null` with `getDemoSnapshot()` so App components read it synchronously after boot.
  - `DemoApp.tsx`: calls `setDemoMode()`, `setPersistBroker("dukascopy")`, fetches the snapshot, seeds the published layout into localStorage under the dukascopy workspace keys (using the same key builders `persist/workspace.ts` uses to store named layouts; read that file first), then renders `<App />`. While loading: the app's standard loading treatment. On `null` snapshot: render `<App />` anyway with a built-in fallback (single chart, first whitelist symbol or `US100`).
- The `<SignedOut>` branch becomes:

```tsx
<SignedOut>
  {shellAuthParams || shouldShowSignIn(window.location.search) ? (
    <ShellTicketSignIn />
  ) : (
    <DemoApp />
  )}
</SignedOut>
```

- [ ] **Step 1: Write the failing tests**

```typescript
// demoBoot.test.ts
import { describe, expect, it } from "vitest";
import { shouldShowSignIn } from "../demoBoot";

describe("shouldShowSignIn", () => {
  it("false for a plain visit (demo renders)", () => {
    expect(shouldShowSignIn("")).toBe(false);
  });
  it("true for ?sign_in=1", () => {
    expect(shouldShowSignIn("?sign_in=1")).toBe(true);
  });
});
```

Plus a `demoSnapshot.test.ts` mocking `fetch`: 200 with a payload → parsed `DemoSnapshot`; 404 → `null`; network reject → `null`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/__tests__/demoBoot.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `demoBoot.ts`, `demoSnapshot.ts`, `DemoApp.tsx`, wire `main.tsx`**

`demoSnapshot.ts` fetches via plain `fetch` (NOT `apiFetch`: there is no token and the endpoint is public; check whether `apiFetch` tolerates a missing token and use it only if it degrades to a bare request). Layout seeding: read `frontend/src/lib/persist/workspace.ts` and reuse its exact key builders and layout body shape; the published `layout` object must be produced by the same serializer (Task 9 publishes it from the same module), so seeding is writing the same keys back. Keep `DemoApp.tsx` under ~120 lines; all logic that is not React lives in the two lib modules.

- [ ] **Step 4: Run the new tests plus a manual smoke**

Run: `cd frontend && npx vitest run src/lib/__tests__/demoBoot.test.ts src/lib/__tests__/demoSnapshot.test.ts`
Expected: PASS.
Smoke (dev servers running): visit `http://localhost:5173` with `VITE_CLERK_PUBLISHABLE_KEY` set and signed out; the demo app renders instead of the sign-in card; `?sign_in=1` shows the sign-in card.

- [ ] **Step 5: Typecheck and commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/DemoApp.tsx frontend/src/lib/demoBoot.ts frontend/src/lib/demoSnapshot.ts frontend/src/main.tsx frontend/src/lib/__tests__/demoBoot.test.ts frontend/src/lib/__tests__/demoSnapshot.test.ts
git commit -m "feat(demo): signed-out visitors boot the app in demo mode"
```

---

### Task 8: Feature gates and CTAs inside App

**Files:**
- Create: `frontend/src/DemoCta.tsx`
- Modify: `frontend/src/App.tsx` (BrokerSelector site line ~2576, plus each gated feature's render site), `frontend/src/SymbolSearchModal.tsx`
- Test: `frontend/src/__tests__/demoGates.test.tsx`

**Interfaces:**
- Consumes: `isDemoMode()` (Task 6), `getDemoSnapshot()` (Task 7).
- Produces: `DemoCta` component: a compact tab-bar button "Sign up free" linking to `/?sign_in=1`, styled like existing `tabbar-action` buttons (gray idle, no solid accent fill), plus an inline variant `<DemoCta inline label="Sign up to run backtests" />` for locked panels.

- [ ] **Step 1: Inventory the gate sites**

Grep `frontend/src/App.tsx` (and `Toolbar.tsx`) for the render sites of: `BrokerSelector`, alerts sidebar/bell, `LiveTradingPanel` and positions dock, `OrderTicket`, sweep/WFO/pattern panel launchers, snapshot gallery, notification settings entry. Record exact lines in the task notes before editing.

- [ ] **Step 2: Write the failing tests**

```tsx
// demoGates.test.tsx (jsdom; follow the setup of existing App-level tests if
// any exist; otherwise test the gate helper + DemoCta rendering in isolation)
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

it("DemoCta renders a sign-up link to /?sign_in=1", async () => {
  const { default: DemoCta } = await import("../DemoCta");
  render(<DemoCta />);
  const link = screen.getByRole("link", { name: /sign up/i });
  expect(link.getAttribute("href")).toBe("/?sign_in=1");
});

it("demo symbol list is limited to the published watchlist", async () => {
  vi.doMock("../lib/demoMode", () => ({ isDemoMode: () => true, setDemoMode: () => {} }));
  vi.doMock("../lib/demoSnapshot", () => ({
    getDemoSnapshot: () => ({ version: 1, layout: {}, watchlist: ["US100", "EURUSD"], backtests: [] }),
  }));
  const { demoAllowedEpics } = await import("../lib/demoBoot");
  expect(demoAllowedEpics()).toEqual(["US100", "EURUSD"]);
});
```

(`demoAllowedEpics(): string[] | null` goes in `demoBoot.ts`: `null` when not in demo mode, the published watchlist otherwise; `SymbolSearchModal` filters its results with it and hides the full-catalog path when non-null.)

- [ ] **Step 3: Run tests to verify they fail; implement**

Gate pattern in `App.tsx`, applied at each inventoried site:

```tsx
{isDemoMode() ? <DemoCta /> : (
  <BrokerSelector accounts={accounts} activeBroker={brokerId} onChange={selectBroker} />
)}
```

Hidden-outright features (alerts, dealing, sweeps/WFO/pattern launchers, snapshot gallery, server-writing settings sections) render `null` in demo mode; only Backtest (Task 9) and the broker slot get CTAs. Keep every gate a one-line conditional on `isDemoMode()`; no prop drilling.

- [ ] **Step 4: Run the new test file plus any existing tests for the touched components**

Run: `cd frontend && npx vitest run src/__tests__/demoGates.test.tsx` plus existing SymbolSearchModal tests if present. Then `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/DemoCta.tsx frontend/src/App.tsx frontend/src/SymbolSearchModal.tsx frontend/src/lib/demoBoot.ts frontend/src/__tests__/demoGates.test.tsx
git commit -m "feat(demo): feature gates and sign-up CTAs in demo mode"
```

---

### Task 9: Canned backtests in the demo, publish tools for the admin

**Files:**
- Modify: `frontend/src/BacktestPanel.tsx` (demo branch), `frontend/src/Settings.tsx` (admin Demo section)
- Create: `frontend/src/lib/demoPublish.ts`
- Test: `frontend/src/__tests__/demoBacktests.test.tsx`, `frontend/src/lib/__tests__/demoPublish.test.ts`

**Interfaces:**
- Consumes: `getDemoSnapshot()` (Task 7), `POST /api/admin/demo/publish`, `GET /api/admin/demo/versions`, `POST /api/admin/demo/rollback` (Task 5), `apiFetch` from `lib/http.ts`, the workspace serializer in `persist/workspace.ts`.
- Produces:
  - Demo branch of `BacktestPanel`: when `isDemoMode()`, the panel shows a picker over `getDemoSnapshot().backtests` (by `name`), renders the selected `result` through the exact same result-rendering path a live run uses (find where the panel stores a completed run's result state and set that state from the canned object), and replaces the Run button with `<DemoCta inline label="Sign up to run your own" />`. Empty published list: the panel shows "No demo backtests published" plus the CTA.
  - `demoPublish.ts`: `publishDemo(opts: { watchlist: string[]; backtests: { name: string; result: unknown }[] }): Promise<number>` which serializes the CURRENT workspace layout via the same function `persist/workspace.ts` uses to save a named layout, POSTs to `/api/admin/demo/publish`, returns the new version; `listDemoVersions()`, `rollbackDemo(version)`.
  - Settings admin-only "Public demo" section (visible via the same admin check the Clerk menu admin-console link uses; `grep -rn "isAdmin\|admin" frontend/src/Settings.tsx frontend/src/components/` to find it): watchlist editor (comma-separated epics input), a "capture current backtest result" add-button that snapshots the most recent completed backtest result plus a name field, the staged list, a Publish button calling `publishDemo`, and a versions list with per-row Roll back. All copy without em dashes; toggles gray when active.
- Note for the "capture current result" wiring: whatever store/state currently holds the last completed backtest result (find it from `BacktestPanel.tsx`'s result state; if it is component-local, lift the latest-result into a small module `lib/lastBacktestResult.ts` set on run completion and read by Settings), the capture button reads it and refuses with a notice when none exists.

- [ ] **Step 1: Write the failing tests**

`demoBacktests.test.tsx`: with demoMode mocked true and a snapshot holding two named backtests, render `BacktestPanel` and assert the picker lists both names, no Run button, CTA link present. `demoPublish.test.ts`: mock `apiFetch`; `publishDemo` POSTs the serialized layout + args and resolves the returned version; `rollbackDemo(1)` POSTs `{version: 1}`.

- [ ] **Step 2: Run to verify failure, then implement**

Read `BacktestPanel.tsx` fully before editing; reuse its result-rendering internals rather than duplicating markup. Keep the demo branch at the top of the component small: pick canned result, feed the existing render path.

- [ ] **Step 3: Run the new test files plus existing BacktestPanel/Settings tests only; typecheck**

Run: `cd frontend && npx vitest run src/__tests__/demoBacktests.test.tsx src/lib/__tests__/demoPublish.test.ts` and `npx tsc -b`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/BacktestPanel.tsx frontend/src/Settings.tsx frontend/src/lib/demoPublish.ts frontend/src/__tests__/demoBacktests.test.tsx frontend/src/lib/__tests__/demoPublish.test.ts
git commit -m "feat(demo): canned backtest browsing and admin demo publishing"
```

---

### Task 10: End-to-end verification pass

**Files:**
- Modify: `CLAUDE.md` (add a short "Public demo" section: what it is, the env switches, the publish flow, the allowlist location)

**Interfaces:** none new.

- [ ] **Step 1: Backend integration check**

Run every backend test file touched or created by this plan in one command:
`cd backend && python3 -m pytest tests/test_demo_access.py tests/test_demo_limit.py tests/test_demo_principal.py tests/test_demo_store.py tests/test_demo_router.py -q`
Expected: all PASS.

- [ ] **Step 2: Hosted-mode manual probe**

Start the backend with `CLERK_JWKS_URL` + `CLERK_AUTHORIZED_PARTIES` set (values from the Clerk dev instance; see the clerk-auth-setup memory) and the frontend with `VITE_CLERK_PUBLISHABLE_KEY`. Signed out, verify: home page renders the demo (published layout or fallback), candles load (network tab: `/api/candles?broker=dukascopy` 200 without auth header), `/api/state` is never called, drawing + indicator edits survive reload via localStorage, `?sign_in=1` reaches sign-in, and signing in lands in the normal app unchanged. As admin: publish a demo (layout + watchlist + one canned backtest) from Settings, reload signed out, confirm the published layout and canned result render.

- [ ] **Step 3: Document in CLAUDE.md and commit**

Write the section (a paragraph, matching the existing sections' tone; no em dashes), then:

```bash
git add CLAUDE.md
git commit -m "docs: public demo section in CLAUDE.md"
```

