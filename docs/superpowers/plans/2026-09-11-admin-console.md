# Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only admin console at `/admin` showing Clerk users, system health, per-user usage and recent logs, with every data route gated on the existing admin identity.

**Architecture:** A new `/api/admin/*` router (router-level admin dependency, separate from the pinned dealing gate) serves five independent JSON endpoints backed by three new core modules: a Clerk Backend API client, an unscoped per-user usage aggregator, and an in-process log ring buffer. The frontend adds a pathname-dispatched `AdminApp` rendered inside the existing Clerk tree, with one component per panel and one fetch per panel so a failing panel never blanks the page.

**Tech Stack:** FastAPI, httpx, sqlite3, pytest (backend, run from `backend/` with `python3 -m pytest`); React + TypeScript + vitest/jsdom (frontend).

**Spec:** `docs/superpowers/specs/2026-09-11-admin-console-design.md`

## Global Constraints

- Read-only. No endpoint in this plan mutates Clerk, user data, jobs, or the filesystem.
- Dev mode (`CLERK_JWKS_URL` unset) stays admin-always and must keep working with no Clerk secret: `/api/admin/users` answers 200 with `configured: false`, never 500.
- Fail closed: `request_is_admin` is the only admin source; the frontend never decides admin-ness itself.
- Do NOT edit `deps.require_admin` or its message `dealing requires admin access`; existing tests pin that string. The new gate's 403 body is exactly `admin access required`.
- Never log, echo, or return `CLERK_SECRET_KEY` (or any part of it), not even in an error body.
- `core/admin_usage.py` holds the only cross-user (unscoped) queries. It must be imported by `routers/admin.py` and nothing else. Do not add unscoped helpers to the existing store modules.
- Usage returns counts and sizes only. No user content (no state values, alert params, run configs, strategy names).
- No em dashes (`—`) or double hyphens (`--`) in UI copy or comments; split the sentence instead.
- UI explanatory copy uses the shared `Tooltip`/`InfoTip` components, never `title=`.
- Frontend tests are run FILE-SCOPED only (`npx vitest run src/admin/X.test.tsx`). Never run the whole frontend suite.
- Backend tests run from `backend/`: `python3 -m pytest tests/<file> -q`.
- Commit after each task with the exact `git add` paths listed in the task (other sessions share this worktree; never `git add -A`).

---

### Task 1: Admin gate and `/api/admin/whoami`

**Files:**
- Modify: `backend/auto_trader/api/deps.py` (add `require_admin_console` next to `require_admin`)
- Create: `backend/auto_trader/api/routers/admin.py`
- Modify: `backend/auto_trader/api/app.py` (import + include the router)
- Test: `backend/tests/test_api_admin_console.py` (new)

**Interfaces:**
- Consumes: `deps.request_is_admin(obj) -> bool`, `deps.current_user(request) -> str`, `auth.auth_enabled() -> bool`.
- Produces: `deps.require_admin_console(request) -> None`; `routers.admin.router` (an `APIRouter` with `prefix="/api/admin"` and the gate as a router-level dependency); `GET /api/admin/whoami -> {"userId": str, "email": str | None, "isAdmin": True, "hostedMode": bool}`.

- [ ] **Step 1: Write the failing test** in `backend/tests/test_api_admin_console.py`:

```python
"""Admin console endpoints: the gate, whoami, logs, health, usage, users."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import auth
from auto_trader.api.app import app
from tests import clerk_fake


@pytest.fixture()
def client(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "user_admin")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_admin')}"}


@pytest.fixture()
def user_headers() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_pleb')}"}


ENDPOINTS = ("/api/admin/whoami", "/api/admin/health", "/api/admin/usage",
             "/api/admin/logs", "/api/admin/users")


@pytest.mark.parametrize("path", ENDPOINTS)
def test_non_admin_gets_403(client, user_headers, path):
    r = client.get(path, headers=user_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "admin access required"


@pytest.mark.parametrize("path", ENDPOINTS)
def test_unauthenticated_gets_401(client, path):
    assert client.get(path).status_code == 401


def test_whoami_for_admin(client, admin_headers):
    r = client.get("/api/admin/whoami", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["userId"] == "user_admin"
    assert body["isAdmin"] is True
    assert body["hostedMode"] is True


def test_whoami_carries_email_claim(client):
    tok = clerk_fake.make_token(sub="user_admin", extra={"email": "boss@example.com"})
    r = client.get("/api/admin/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["email"] == "boss@example.com"


def test_whoami_dev_mode(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    with TestClient(app) as c:
        body = c.get("/api/admin/whoami").json()
    assert body == {"userId": "dev", "email": None, "isAdmin": True, "hostedMode": False}
```

Note: the parametrized tests cover endpoints built in later tasks. That is intentional; they fail on 404 until each task lands, and Task 1 only needs the `whoami` cases plus its own gate cases green. Run the gate/whoami tests by name in this task (`-k "whoami or 403 or 401"` will still include the not-yet-built paths, so use `-k whoami` plus a manual check of the `/api/admin/whoami` parametrized cases). To avoid ambiguity: in Task 1, temporarily run with `ENDPOINTS` narrowed is NOT allowed; instead run `python3 -m pytest tests/test_api_admin_console.py -q -k "whoami"` and accept the other parametrized cases failing until Task 5.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_api_admin_console.py -q -k whoami`
Expected: FAIL, 404 on `/api/admin/whoami`.

- [ ] **Step 3: Add the gate to `deps.py`**

Insert directly after the existing `require_admin`:

```python
def require_admin_console(request: Request) -> None:
    """Router-level dependency for /api/admin/*. Deliberately separate from
    require_admin: that one's 403 copy is pinned by the dealing tests."""
    if not request_is_admin(request):
        raise HTTPException(403, "admin access required")
```

- [ ] **Step 4: Create `backend/auto_trader/api/routers/admin.py`**

```python
"""Read-only admin console API (/api/admin/*).

Every route is gated by deps.require_admin_console at the router level. The
console is read-only by design: nothing here mutates Clerk, user data or jobs.

See docs/superpowers/specs/2026-09-11-admin-console-design.md.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

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
```

- [ ] **Step 5: Stamp the verified claims on the request**

`whoami` needs the `email` claim. Check `backend/auto_trader/api/auth.py` around the middleware (near where it sets `request.state.is_admin`): if it does not already stamp the claims, add `request.state.claims = claims` immediately next to the `is_admin` assignment on the hosted path, and `request.state.claims = {}` on the dev path. Do not change any other behavior in that function.

- [ ] **Step 6: Mount the router in `app.py`**

Add `admin` to the `from .routers import ...` line (keep it alphabetical within the existing list style) and add `admin` to the `for _module in (...)` include tuple.

- [ ] **Step 7: Run the tests**

Run: `cd backend && python3 -m pytest tests/test_api_admin_console.py -q -k whoami`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the existing admin suites for regressions**

Run: `cd backend && python3 -m pytest tests/test_api_admin_gate.py tests/test_api_admin_identity.py tests/test_api_auth.py -q`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/api/deps.py backend/auto_trader/api/routers/admin.py \
  backend/auto_trader/api/app.py backend/auto_trader/api/auth.py \
  backend/tests/test_api_admin_console.py
git commit -m "feat(admin): gate /api/admin and serve whoami"
```

---

### Task 2: Log ring buffer and `/api/admin/logs`

**Files:**
- Create: `backend/auto_trader/core/log_buffer.py`
- Modify: `backend/auto_trader/api/app.py` (`_configure_logging` installs the handler)
- Modify: `backend/auto_trader/api/routers/admin.py` (add the route)
- Test: `backend/tests/test_log_buffer.py` (new)
- Test: `backend/tests/test_api_admin_console.py` (add the logs cases)

**Interfaces:**
- Consumes: Task 1's `router`.
- Produces: `core.log_buffer.LOG_BUFFER` (a `LogRingBuffer`), `LogRingBuffer.records(limit: int = 200, min_level: str = "DEBUG") -> list[dict]`, `LogRingBuffer.handler() -> logging.Handler`, `log_buffer.install() -> None`; `GET /api/admin/logs?limit=&level= -> {"records": [...], "capacity": int}`. A record is `{"time": int (epoch ms), "level": str, "logger": str, "message": str}`.

- [ ] **Step 1: Write the failing test** in `backend/tests/test_log_buffer.py`:

```python
"""In-process log ring buffer backing the admin console's Logs panel."""
from __future__ import annotations

import logging

from auto_trader.core.log_buffer import LogRingBuffer


def _emit(buf: LogRingBuffer, level: int, msg: str, name: str = "auto_trader.test") -> None:
    rec = logging.LogRecord(name, level, __file__, 1, msg, None, None)
    buf.handler().handle(rec)


def test_records_newest_first():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.INFO, "first")
    _emit(buf, logging.INFO, "second")
    msgs = [r["message"] for r in buf.records()]
    assert msgs == ["second", "first"]


def test_record_shape():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.WARNING, "careful", name="auto_trader.alerts")
    rec = buf.records()[0]
    assert set(rec) == {"time", "level", "logger", "message"}
    assert rec["level"] == "WARNING"
    assert rec["logger"] == "auto_trader.alerts"
    assert isinstance(rec["time"], int) and rec["time"] > 1_000_000_000_000


def test_capacity_drops_oldest():
    buf = LogRingBuffer(capacity=3)
    for i in range(5):
        _emit(buf, logging.INFO, f"m{i}")
    assert [r["message"] for r in buf.records()] == ["m4", "m3", "m2"]


def test_min_level_filter():
    buf = LogRingBuffer(capacity=10)
    _emit(buf, logging.DEBUG, "noise")
    _emit(buf, logging.ERROR, "boom")
    assert [r["message"] for r in buf.records(min_level="WARNING")] == ["boom"]


def test_limit_caps_returned_rows():
    buf = LogRingBuffer(capacity=10)
    for i in range(5):
        _emit(buf, logging.INFO, f"m{i}")
    assert len(buf.records(limit=2)) == 2


def test_exception_text_is_appended():
    buf = LogRingBuffer(capacity=10)
    try:
        raise ValueError("kaboom")
    except ValueError:
        import sys

        rec = logging.LogRecord(
            "auto_trader.test", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
        buf.handler().handle(rec)
    assert "kaboom" in buf.records()[0]["message"]


def test_handler_never_raises():
    buf = LogRingBuffer(capacity=10)
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "%d", ("not-an-int",), None)
    buf.handler().handle(rec)  # must not raise
    assert len(buf.records()) <= 1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_log_buffer.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.core.log_buffer`.

- [ ] **Step 3: Implement `backend/auto_trader/core/log_buffer.py`**

```python
"""In-process ring buffer of recent log records, for the admin console.

The hosted process logs to journald under systemd, which the API process
cannot read without extra privileges, so the Logs panel reads this instead.
Scope is deliberately narrow: the current process only, lost on restart, and
it does not include output emitted before the buffer is installed. Records
arrive already redacted (app.py's token filter runs on the handlers that feed
this one's loggers).
"""

from __future__ import annotations

import logging
import time
from collections import deque


class _BufferHandler(logging.Handler):
    def __init__(self, buf: "LogRingBuffer") -> None:
        super().__init__()
        self._buf = buf

    def emit(self, record: logging.LogRecord) -> None:
        # A logging handler must never raise: a bad format arg would otherwise
        # take down the call site that logged it.
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        try:
            if record.exc_info:
                message = f"{message}\n{logging.Formatter().formatException(record.exc_info)}"
            self._buf._append(
                {
                    "time": int(record.created * 1000),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": message,
                }
            )
        except Exception:
            pass


class LogRingBuffer:
    """Fixed-size newest-last deque of formatted records."""

    def __init__(self, capacity: int = 500) -> None:
        self.capacity = capacity
        self._records: deque[dict] = deque(maxlen=capacity)
        self._handler = _BufferHandler(self)

    def _append(self, rec: dict) -> None:
        self._records.append(rec)

    def handler(self) -> logging.Handler:
        return self._handler

    def records(self, limit: int = 200, min_level: str = "DEBUG") -> list[dict]:
        """Newest first, at most `limit`, at or above `min_level`."""
        floor = logging.getLevelName(min_level.upper())
        if not isinstance(floor, int):
            floor = logging.DEBUG
        out: list[dict] = []
        for rec in reversed(self._records):
            level = logging.getLevelName(rec["level"])
            if isinstance(level, int) and level < floor:
                continue
            out.append(rec)
            if len(out) >= limit:
                break
        return out


LOG_BUFFER = LogRingBuffer()


def install() -> None:
    """Attach the buffer to the app and uvicorn loggers. Idempotent."""
    for name in ("auto_trader", "uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        if LOG_BUFFER.handler() not in logger.handlers:
            logger.addHandler(LOG_BUFFER.handler())
```

- [ ] **Step 4: Run the buffer tests**

Run: `cd backend && python3 -m pytest tests/test_log_buffer.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Install the handler at startup**

In `backend/auto_trader/api/app.py`, inside `_configure_logging()`, at the very end of the function add:

```python
    # Feed the admin console's Logs panel. Installed last so it sees records
    # only after the redaction filter is attached to the upstream handlers.
    from auto_trader.core.log_buffer import install as install_log_buffer

    install_log_buffer()
```

- [ ] **Step 6: Add the route** to `backend/auto_trader/api/routers/admin.py`:

```python
from fastapi import Query

from auto_trader.core.log_buffer import LOG_BUFFER


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
```

- [ ] **Step 7: Add the endpoint tests** to `backend/tests/test_api_admin_console.py`:

```python
def test_logs_returns_recent_records(client, admin_headers):
    import logging

    logging.getLogger("auto_trader.admin_test").warning("hello-admin-console")
    body = client.get("/api/admin/logs", headers=admin_headers).json()
    assert body["capacity"] >= 1
    assert any(r["message"] == "hello-admin-console" for r in body["records"])


def test_logs_level_filter(client, admin_headers):
    import logging

    logging.getLogger("auto_trader.admin_test").info("quiet-line-xyz")
    body = client.get("/api/admin/logs?level=ERROR", headers=admin_headers).json()
    assert all(r["level"] in ("ERROR", "CRITICAL") for r in body["records"])
```

- [ ] **Step 8: Run**

Run: `cd backend && python3 -m pytest tests/test_log_buffer.py tests/test_api_admin_console.py -q -k "logs or whoami"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/core/log_buffer.py backend/auto_trader/api/app.py \
  backend/auto_trader/api/routers/admin.py backend/tests/test_log_buffer.py \
  backend/tests/test_api_admin_console.py
git commit -m "feat(admin): in-process log ring buffer behind /api/admin/logs"
```

---

### Task 3: `/api/admin/health`

**Files:**
- Create: `backend/auto_trader/core/admin_health.py`
- Modify: `backend/auto_trader/core/alert_engine.py` (add a public `feeds_status()`)
- Modify: `backend/auto_trader/api/routers/admin.py` (add the route)
- Test: `backend/tests/test_admin_health.py` (new)
- Test: `backend/tests/test_api_admin_console.py` (add the health case)

**Interfaces:**
- Consumes: `api.activity.idle_seconds()`, `api.auth.auth_enabled()`, `api.deps._registry` (a `BrokerRegistry` with `describe(include_restricted=True)`, `default_data_id()`), `core.alert_engine.ALERT_ENGINE`, `auto_trader.config.settings` (`state_db_path`, `runs_db_path`, `sweeps_db_path`, `wfo_db_path`, `cost_profiles_db_path`, `alerts_db_path`, `patterns_db_path`, `candle_db_path`, `tick_db_path`).
- Produces: `core.admin_health.collect_health() -> dict` with keys `process`, `idleSeconds`, `feeds`, `alerts`, `brokers`, `databases`, `disk`, `snapshot`; `AlertEngine.feeds_status() -> list[dict]` where each row is `{"broker": str, "epic": str, "running": bool, "alerts": int}`; `GET /api/admin/health -> collect_health()`.

- [ ] **Step 1: Write the failing test** in `backend/tests/test_admin_health.py`:

```python
"""collect_health(): shape, per-probe isolation, and the feeds_status seam."""
from __future__ import annotations

import asyncio

import pytest

from auto_trader.core import admin_health
from auto_trader.core.alert_engine import AlertEngine


def test_shape_has_every_section():
    h = admin_health.collect_health()
    assert set(h) >= {
        "process", "idleSeconds", "feeds", "alerts", "brokers", "databases",
        "disk", "snapshot",
    }
    assert isinstance(h["process"]["uptimeSeconds"], (int, float))
    assert isinstance(h["process"]["pid"], int)
    assert isinstance(h["databases"], list)


def test_failing_probe_is_confined_to_its_key(monkeypatch):
    def boom():
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(admin_health, "_databases", boom)
    h = admin_health.collect_health()
    assert h["databases"] == {"error": "probe exploded"}
    assert "uptimeSeconds" in h["process"]  # the rest still worked


def test_databases_report_size_and_existence(tmp_path, monkeypatch):
    db = tmp_path / "app_state.db"
    db.write_bytes(b"x" * 17)
    monkeypatch.setattr(admin_health, "_DB_PATHS", lambda: {"state": str(db), "gone": str(tmp_path / "nope.db")})
    rows = {r["name"]: r for r in admin_health._databases()}
    assert rows["state"]["exists"] is True and rows["state"]["bytes"] == 17
    assert rows["gone"]["exists"] is False and rows["gone"]["bytes"] == 0


def test_feeds_status_lists_registered_pairs():
    eng = AlertEngine()
    eng._registry = {("capital", "US100"): [("u1", {}), ("u2", {})]}
    rows = eng.feeds_status()
    assert rows == [{"broker": "capital", "epic": "US100", "running": False, "alerts": 2}]


def test_feeds_status_marks_running_task():
    async def main():
        eng = AlertEngine()
        eng._registry = {("capital", "US100"): [("u1", {})]}

        async def forever():
            await asyncio.sleep(60)

        task = asyncio.create_task(forever())
        eng._feed_tasks[("capital", "US100")] = task
        try:
            assert eng.feeds_status()[0]["running"] is True
        finally:
            task.cancel()

    asyncio.run(main())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_admin_health.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.core.admin_health`.

- [ ] **Step 3: Add `feeds_status()` to `AlertEngine`**

In `backend/auto_trader/core/alert_engine.py`, next to the existing `feeds_needed()` method:

```python
    def feeds_status(self) -> list[dict]:
        """Admin-console view of the live feeds: one row per registered
        (broker, epic) with whether its task is running and how many alerts
        ride it. Read-only; never mutates engine state."""
        rows = []
        for (broker, epic), entries in sorted(self._registry.items()):
            task = self._feed_tasks.get((broker, epic))
            rows.append(
                {
                    "broker": broker,
                    "epic": epic,
                    "running": bool(task and not task.done()),
                    "alerts": len(entries),
                }
            )
        return rows
```

- [ ] **Step 4: Implement `backend/auto_trader/core/admin_health.py`**

```python
"""System-health snapshot for the admin console.

Assembled from what the process already knows: no new collectors, no polling,
no writes. Every probe is wrapped so one failure is confined to its own key
instead of failing the whole endpoint.
"""

from __future__ import annotations

import os
import shutil
import time
from typing import Callable

from auto_trader.config import settings

_STARTED = time.time()


def _DB_PATHS() -> dict[str, str]:
    return {
        "app_state": settings.state_db_path,
        "backtest_runs": settings.runs_db_path,
        "backtest_sweeps": settings.sweeps_db_path,
        "backtest_wfo": settings.wfo_db_path,
        "cost_profiles": settings.cost_profiles_db_path,
        "alerts": settings.alerts_db_path,
        "patterns": settings.patterns_db_path,
        "candle_history": settings.candle_db_path,
        "tick_history": settings.tick_db_path,
    }


def _process() -> dict:
    from auto_trader.api.auth import auth_enabled

    return {
        "uptimeSeconds": round(time.time() - _STARTED, 1),
        "pid": os.getpid(),
        "hostedMode": auth_enabled(),
    }


def _idle_seconds() -> float:
    from auto_trader.api import activity

    return round(activity.idle_seconds(), 1)


def _feeds() -> list[dict]:
    from auto_trader.core.alert_engine import ALERT_ENGINE

    return ALERT_ENGINE.feeds_status()


def _alerts() -> dict:
    from auto_trader.core.alert_engine import ALERT_ENGINE

    rows = ALERT_ENGINE.feeds_status()
    return {"armed": sum(r["alerts"] for r in rows), "feeds": len(rows)}


def _brokers() -> dict:
    from auto_trader.api import deps
    from auto_trader.brokers.registry import RESTRICTED_BROKER_IDS

    reg = deps._registry
    if reg is None:
        return {"registered": [], "restricted": sorted(RESTRICTED_BROKER_IDS), "default": None}
    described = reg.describe(include_restricted=True)
    return {
        "registered": sorted(described.get("data", {})),
        "restricted": sorted(RESTRICTED_BROKER_IDS),
        "default": reg.default_data_id(),
    }


def _databases() -> list[dict]:
    rows = []
    for name, path in _DB_PATHS().items():
        exists = os.path.exists(path)
        rows.append(
            {
                "name": name,
                "path": path,
                "exists": exists,
                "bytes": os.path.getsize(path) if exists else 0,
            }
        )
    return rows


def _disk() -> dict:
    target = os.path.dirname(os.path.abspath(settings.state_db_path)) or "."
    usage = shutil.disk_usage(target)
    return {"path": target, "totalBytes": usage.total, "freeBytes": usage.free}


def _snapshot() -> dict:
    return {
        "enabled": not os.environ.get("SNAPSHOT_DISABLED"),
        "frontendUrl": os.environ.get("FRONTEND_URL") or None,
    }


def _safe(fn: Callable):
    try:
        return fn()
    except Exception as exc:  # one bad probe must not blank the panel
        return {"error": str(exc)}


def collect_health() -> dict:
    return {
        "process": _safe(_process),
        "idleSeconds": _safe(_idle_seconds),
        "feeds": _safe(_feeds),
        "alerts": _safe(_alerts),
        "brokers": _safe(_brokers),
        "databases": _safe(_databases),
        "disk": _safe(_disk),
        "snapshot": _safe(_snapshot),
    }
```

Note on the monkeypatch seams: `collect_health` calls the module-level `_databases` by name at call time, so `monkeypatch.setattr(admin_health, "_databases", ...)` works only if `_safe` receives the current attribute. Write `collect_health` exactly as above (it looks the name up when the dict literal is built, which happens per call), and `_databases` must read `_DB_PATHS()` through the module global for the same reason.

- [ ] **Step 5: Add the route** to `backend/auto_trader/api/routers/admin.py`:

```python
from auto_trader.core.admin_health import collect_health


@router.get("/health")
async def health() -> dict:
    """Process, feeds, brokers, databases and disk, as of now."""
    return collect_health()
```

- [ ] **Step 6: Add the endpoint test** to `backend/tests/test_api_admin_console.py`:

```python
def test_health_for_admin(client, admin_headers):
    body = client.get("/api/admin/health", headers=admin_headers).json()
    assert "process" in body and "databases" in body
    assert body["process"]["hostedMode"] is True
```

- [ ] **Step 7: Run**

Run: `cd backend && python3 -m pytest tests/test_admin_health.py -q && python3 -m pytest tests/test_api_admin_console.py -q -k "health or whoami or logs"`
Expected: PASS.

- [ ] **Step 8: Regression check the alert engine**

Run: `cd backend && python3 -m pytest tests/ -q -k alert`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/core/admin_health.py backend/auto_trader/core/alert_engine.py \
  backend/auto_trader/api/routers/admin.py backend/tests/test_admin_health.py \
  backend/tests/test_api_admin_console.py
git commit -m "feat(admin): system health endpoint"
```

---

### Task 4: `/api/admin/usage`

**Files:**
- Create: `backend/auto_trader/core/admin_usage.py`
- Modify: `backend/auto_trader/api/routers/admin.py` (add the route)
- Test: `backend/tests/test_admin_usage.py` (new)
- Test: `backend/tests/test_api_admin_console.py` (add the usage case)

**Interfaces:**
- Consumes: `auto_trader.config.settings` db paths (same set as Task 3).
- Produces: `core.admin_usage.collect_usage() -> list[dict]`, one row per `user_id`:
  `{"userId": str, "stateRows": int, "stateBytes": int, "runs": int, "sweeps": int, "wfo": int, "alerts": int, "triggered": int, "costProfiles": int, "patternPresets": int, "lastSeen": int | None}`;
  `GET /api/admin/usage -> {"users": [...]}` sorted by `lastSeen` descending, then `userId`.

**This is the only module in the codebase that queries user-partitioned tables without a user filter.** It is imported by `routers/admin.py` and nothing else.

- [ ] **Step 1: Write the failing test** in `backend/tests/test_admin_usage.py`:

```python
"""collect_usage(): cross-user counts, no content, missing files tolerated."""
from __future__ import annotations

import sqlite3

import pytest

from auto_trader.core import admin_usage


def _seed(path, ddl: str, rows: list[tuple], insert: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute(ddl)
    conn.executemany(insert, rows)
    conn.commit()
    conn.close()


@pytest.fixture()
def dbs(tmp_path, monkeypatch):
    state = tmp_path / "app_state.db"
    runs = tmp_path / "runs.db"
    _seed(
        state,
        "CREATE TABLE app_state (user_id TEXT NOT NULL, key TEXT NOT NULL, "
        "value TEXT NOT NULL, updated_at INTEGER)",
        [("u1", "k1", "abcde", 1000), ("u1", "k2", "xy", 2000), ("u2", "k1", "z", 500)],
        "INSERT INTO app_state VALUES (?,?,?,?)",
    )
    _seed(
        runs,
        "CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER)",
        [("r1", "u1", 3000), ("r2", "u2", 400)],
        "INSERT INTO runs VALUES (?,?,?)",
    )
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (
            admin_usage.Source(str(state), "app_state", "stateRows", "updated_at", "value"),
            admin_usage.Source(str(runs), "runs", "runs", "created_at", None),
        ),
    )
    return tmp_path


def test_rows_per_user_with_counts(dbs):
    rows = {r["userId"]: r for r in admin_usage.collect_usage()}
    assert set(rows) == {"u1", "u2"}
    assert rows["u1"]["stateRows"] == 2
    assert rows["u1"]["stateBytes"] == 7  # "abcde" + "xy"
    assert rows["u1"]["runs"] == 1
    assert rows["u2"]["stateRows"] == 1


def test_last_seen_is_the_max_timestamp(dbs):
    rows = {r["userId"]: r for r in admin_usage.collect_usage()}
    assert rows["u1"]["lastSeen"] == 3000
    assert rows["u2"]["lastSeen"] == 500


def test_sorted_by_last_seen_desc(dbs):
    assert [r["userId"] for r in admin_usage.collect_usage()] == ["u1", "u2"]


def test_no_user_content_in_rows(dbs):
    row = admin_usage.collect_usage()[0]
    assert "abcde" not in str(row) and "k1" not in str(row)
    assert set(row) == {
        "userId", "stateRows", "stateBytes", "runs", "sweeps", "wfo", "alerts",
        "triggered", "costProfiles", "patternPresets", "lastSeen",
    }


def test_missing_db_file_is_empty_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (admin_usage.Source(str(tmp_path / "nope.db"), "runs", "runs", "created_at", None),),
    )
    assert admin_usage.collect_usage() == []


def test_missing_table_is_empty_not_an_error(tmp_path, monkeypatch):
    path = tmp_path / "empty.db"
    sqlite3.connect(path).close()
    monkeypatch.setattr(
        admin_usage,
        "_SOURCES",
        (admin_usage.Source(str(path), "runs", "runs", "created_at", None),),
    )
    assert admin_usage.collect_usage() == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_admin_usage.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.core.admin_usage`.

- [ ] **Step 3: Implement `backend/auto_trader/core/admin_usage.py`**

```python
"""Cross-user usage counts for the admin console.

THIS MODULE IS THE ONLY PLACE that queries the user-partitioned tables without
a user filter. Import it from auto_trader/api/routers/admin.py and from nowhere
else: every other caller must stay user-scoped through its store module.

It returns COUNTS AND SIZES ONLY. No key names, no values, no alert params, no
run configs. Nothing here can leak one user's content to another.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass

from auto_trader.config import settings


@dataclass(frozen=True)
class Source:
    """One (db file, table) to count rows in, grouped by user_id.

    field: the output key the count lands on.
    time_col: column to take max() of for lastSeen (None to skip).
    size_col: column whose total length counts toward stateBytes (None to skip).
    """

    path: str
    table: str
    field: str
    time_col: str | None
    size_col: str | None


def _sources() -> tuple[Source, ...]:
    return (
        Source(settings.state_db_path, "app_state", "stateRows", "updated_at", "value"),
        Source(settings.runs_db_path, "runs", "runs", "created_at", None),
        Source(settings.sweeps_db_path, "sweeps", "sweeps", "created_at", None),
        Source(settings.wfo_db_path, "wfo", "wfo", "created_at", None),
        Source(settings.alerts_db_path, "alerts", "alerts", "created_at", None),
        Source(settings.alerts_db_path, "triggered", "triggered", "time", None),
        Source(settings.cost_profiles_db_path, "cost_profiles", "costProfiles", "updated_at", None),
        Source(settings.patterns_db_path, "presets", "patternPresets", "updated_at", None),
    )


_SOURCES = _sources()

_FIELDS = (
    "stateRows", "runs", "sweeps", "wfo", "alerts", "triggered",
    "costProfiles", "patternPresets",
)


def _blank(user_id: str) -> dict:
    row = {"userId": user_id, "stateBytes": 0, "lastSeen": None}
    for f in _FIELDS:
        row[f] = 0
    return row


def _scan(src: Source, out: dict[str, dict]) -> None:
    """Fold one source's per-user aggregates into `out`. A missing file, a
    missing table, or a missing column contributes nothing."""
    if not os.path.exists(src.path):
        return
    cols = ["user_id", "COUNT(*)"]
    cols.append(f"MAX({src.time_col})" if src.time_col else "NULL")
    cols.append(f"SUM(LENGTH({src.size_col}))" if src.size_col else "0")
    sql = f"SELECT {', '.join(cols)} FROM {src.table} GROUP BY user_id"
    try:
        conn = sqlite3.connect(f"file:{src.path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return
    try:
        rows = conn.execute(sql).fetchall()
    except sqlite3.Error:
        return  # table or column absent on this deployment
    finally:
        conn.close()
    for user_id, count, last, size in rows:
        if not isinstance(user_id, str):
            continue
        row = out.setdefault(user_id, _blank(user_id))
        row[src.field] = row.get(src.field, 0) + int(count or 0)
        row["stateBytes"] += int(size or 0)
        if last is not None:
            row["lastSeen"] = max(row["lastSeen"] or 0, int(last))


def collect_usage() -> list[dict]:
    """One row per user id seen in any partitioned table, newest first."""
    out: dict[str, dict] = {}
    for src in _SOURCES:
        _scan(src, out)
    return sorted(out.values(), key=lambda r: (-(r["lastSeen"] or 0), r["userId"]))
```

If a column name in `_sources()` does not exist on this codebase's schema (check each table's `CREATE TABLE` in the matching store module before running), correct the column name in `_sources()` rather than deleting the source. `_scan` already tolerates a wrong name by contributing nothing, which would silently show zeros, so verify each one against the store module.

- [ ] **Step 4: Run the usage tests**

Run: `cd backend && python3 -m pytest tests/test_admin_usage.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify the real schemas line up**

Run:
```bash
cd backend && python3 -c "
from auto_trader.core import admin_usage
for s in admin_usage._SOURCES: print(s.path, s.table, s.time_col, s.size_col)
print(admin_usage.collect_usage())
"
```
Expected: no exception, and a row for `dev` with non-zero counts if the local dbs have data. Any source whose counts are unexpectedly zero means a wrong table/column name: fix `_sources()`.

- [ ] **Step 6: Add the route** to `backend/auto_trader/api/routers/admin.py`:

```python
from auto_trader.core.admin_usage import collect_usage


@router.get("/usage")
async def usage() -> dict:
    """Per-user row counts and sizes. Counts only: no user content."""
    return {"users": collect_usage()}
```

- [ ] **Step 7: Add the endpoint test** to `backend/tests/test_api_admin_console.py`:

```python
def test_usage_for_admin(client, admin_headers):
    body = client.get("/api/admin/usage", headers=admin_headers).json()
    assert isinstance(body["users"], list)
    for row in body["users"]:
        assert set(row) >= {"userId", "runs", "alerts", "lastSeen"}
```

- [ ] **Step 8: Run**

Run: `cd backend && python3 -m pytest tests/test_admin_usage.py -q && python3 -m pytest tests/test_api_admin_console.py -q -k "usage or health or logs or whoami"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/core/admin_usage.py backend/auto_trader/api/routers/admin.py \
  backend/tests/test_admin_usage.py backend/tests/test_api_admin_console.py
git commit -m "feat(admin): per-user usage counts endpoint"
```

---

### Task 5: Clerk user list and `/api/admin/users`

**Files:**
- Create: `backend/auto_trader/core/clerk_admin.py`
- Modify: `backend/auto_trader/api/routers/admin.py` (add the route)
- Test: `backend/tests/test_clerk_admin.py` (new)
- Test: `backend/tests/test_api_admin_console.py` (add the users cases)

**Interfaces:**
- Consumes: `httpx` (already a dependency, see `routers/compute.py`).
- Produces: `core.clerk_admin.SECRET_ENV = "CLERK_SECRET_KEY"`, `clerk_admin.configured() -> bool`, `async clerk_admin.list_users(limit: int = 50, offset: int = 0, query: str = "") -> dict`, `clerk_admin.map_user(raw: dict) -> dict`;
  `GET /api/admin/users?limit=&offset=&query= -> {"configured": bool, "users": [...], "total": int, "error": str | None}` with status 200 in every case.
  A mapped user is `{"id", "email", "firstName", "lastName", "imageUrl", "createdAt", "lastActiveAt", "lastSignInAt", "banned", "locked"}`; timestamps are Clerk's epoch milliseconds or `None`.

- [ ] **Step 1: Verify the real Clerk payload FIRST**

Before writing the mapping, confirm the field names against a live response. With the production secret available in the shell (never commit it, never paste it into a file):

```bash
curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  "https://api.clerk.com/v1/users?limit=1" | python3 -m json.tool | head -60
curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" "https://api.clerk.com/v1/users/count"
```

Expected: a list with one user object carrying `id`, `email_addresses`, `primary_email_address_id`, `first_name`, `last_name`, `image_url`, `created_at`, `last_active_at`, `last_sign_in_at`, `banned`, `locked`. If any name differs, use the observed name in `map_user` and in the test fixture below, and note the deviation in the commit message.

If the secret is not available in this session, implement against the field names above, mark the task's commit message with `(mapping unverified)`, and leave a `- [ ] verify Clerk field mapping against a live payload` line in the plan.

- [ ] **Step 2: Write the failing test** in `backend/tests/test_clerk_admin.py`:

```python
"""Clerk Backend API client: mapping, unconfigured degradation, error paths."""
from __future__ import annotations

import httpx
import pytest

from auto_trader.core import clerk_admin

RAW = {
    "id": "user_abc",
    "primary_email_address_id": "idn_2",
    "email_addresses": [
        {"id": "idn_1", "email_address": "old@example.com"},
        {"id": "idn_2", "email_address": "boss@example.com"},
    ],
    "first_name": "Ada",
    "last_name": "Lovelace",
    "image_url": "https://img.clerk.com/x",
    "created_at": 1700000000000,
    "last_active_at": 1800000000000,
    "last_sign_in_at": 1750000000000,
    "banned": False,
    "locked": False,
}


def test_map_user_picks_the_primary_email():
    u = clerk_admin.map_user(RAW)
    assert u["id"] == "user_abc"
    assert u["email"] == "boss@example.com"
    assert u["firstName"] == "Ada"
    assert u["createdAt"] == 1700000000000
    assert u["lastActiveAt"] == 1800000000000
    assert u["banned"] is False


def test_map_user_tolerates_missing_fields():
    u = clerk_admin.map_user({"id": "user_x"})
    assert u["id"] == "user_x"
    assert u["email"] is None and u["firstName"] is None and u["createdAt"] is None


def test_map_user_never_leaks_unmapped_keys():
    u = clerk_admin.map_user({**RAW, "private_metadata": {"secret": "s3cr3t"}})
    assert "s3cr3t" not in str(u)
    assert set(u) == {
        "id", "email", "firstName", "lastName", "imageUrl", "createdAt",
        "lastActiveAt", "lastSignInAt", "banned", "locked",
    }


@pytest.mark.anyio
async def test_unconfigured_returns_empty_not_an_error(monkeypatch):
    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    out = await clerk_admin.list_users()
    assert out == {"configured": False, "users": [], "total": 0, "error": None}


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_list_users_maps_and_counts(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer sk_test_x"
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"object": "total_count", "total_count": 7})
        assert request.url.params["limit"] == "2"
        return httpx.Response(200, json=[RAW])

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users(limit=2)
    assert out["configured"] is True and out["error"] is None
    assert out["total"] == 7
    assert out["users"][0]["email"] == "boss@example.com"


@pytest.mark.anyio
async def test_upstream_error_degrades_inline(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errors": [{"message": "Invalid key"}]})

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users()
    assert out["configured"] is True and out["users"] == []
    assert "401" in out["error"]
    assert "sk_test_x" not in out["error"]


@pytest.mark.anyio
async def test_transport_failure_degrades_inline(monkeypatch):
    monkeypatch.setenv(clerk_admin.SECRET_ENV, "sk_test_x")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(clerk_admin, "_transport", lambda: _transport(handler))
    out = await clerk_admin.list_users()
    assert out["configured"] is True and out["users"] == []
    assert out["error"]
```

If `pytest.mark.anyio` is not configured in this repo, check how other async tests are marked (`grep -rn "asyncio_mode\|anyio_backend\|pytest.mark.asyncio" backend/pytest.ini backend/pyproject.toml backend/tests | head`) and use the established marker instead. Do not introduce a new async test plugin.

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_clerk_admin.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.core.clerk_admin`.

- [ ] **Step 4: Implement `backend/auto_trader/core/clerk_admin.py`**

```python
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

    params = {
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
```

- [ ] **Step 5: Run the client tests**

Run: `cd backend && python3 -m pytest tests/test_clerk_admin.py -q`
Expected: PASS.

- [ ] **Step 6: Add the route** to `backend/auto_trader/api/routers/admin.py`:

```python
from auto_trader.core import clerk_admin


@router.get("/users")
async def users(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    query: str = Query(""),
) -> dict:
    """Clerk users, read-only. Always 200: an unset secret or an upstream
    failure is reported in the body so the panel can say what is wrong."""
    return await clerk_admin.list_users(limit=limit, offset=offset, query=query)
```

- [ ] **Step 7: Add the endpoint tests** to `backend/tests/test_api_admin_console.py`:

```python
def test_users_unconfigured_is_200_not_500(client, admin_headers, monkeypatch):
    from auto_trader.core import clerk_admin

    monkeypatch.delenv(clerk_admin.SECRET_ENV, raising=False)
    r = client.get("/api/admin/users", headers=admin_headers)
    assert r.status_code == 200
    assert r.json() == {"configured": False, "users": [], "total": 0, "error": None}
```

- [ ] **Step 8: Run the whole console suite**

Run: `cd backend && python3 -m pytest tests/test_api_admin_console.py tests/test_clerk_admin.py tests/test_admin_usage.py tests/test_admin_health.py tests/test_log_buffer.py -q`
Expected: PASS, all of it, including every parametrized gate case from Task 1.

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/core/clerk_admin.py backend/auto_trader/api/routers/admin.py \
  backend/tests/test_clerk_admin.py backend/tests/test_api_admin_console.py
git commit -m "feat(admin): Clerk user list endpoint"
```

---

### Task 6: Frontend admin console at `/admin`

**Files:**
- Create: `frontend/src/admin/api.ts`
- Create: `frontend/src/admin/AdminApp.tsx`
- Create: `frontend/src/admin/UsersPanel.tsx`
- Create: `frontend/src/admin/HealthPanel.tsx`
- Create: `frontend/src/admin/UsagePanel.tsx`
- Create: `frontend/src/admin/LogsPanel.tsx`
- Create: `frontend/src/admin/admin.css`
- Create: `frontend/src/lib/adminBoot.ts`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/admin/AdminApp.test.tsx`
- Test: `frontend/src/admin/UsagePanel.test.tsx`
- Test: `frontend/src/lib/adminBoot.test.ts`

**Interfaces:**
- Consumes: Task 1-5 endpoints; `lib/http.ts` (`API_BASE`, `apiFetch`, `errorDetail`); `components/Tooltip.tsx` / `components/InfoTip.tsx`.
- Produces: `lib/adminBoot.ts` exporting `shouldBootAdmin(pathname: string): boolean`; `admin/api.ts` exporting `fetchWhoami`, `fetchUsers`, `fetchHealth`, `fetchUsage`, `fetchLogs` plus the TS types `AdminWhoami`, `ClerkUser`, `UsageRow`, `LogRecord`, `HealthSnapshot`; `AdminApp` as the default export of `AdminApp.tsx`.

- [ ] **Step 1: Write the failing boot test** in `frontend/src/lib/adminBoot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldBootAdmin } from "./adminBoot";

describe("shouldBootAdmin", () => {
  it("matches /admin", () => {
    expect(shouldBootAdmin("/admin")).toBe(true);
  });
  it("tolerates a trailing slash", () => {
    expect(shouldBootAdmin("/admin/")).toBe(true);
  });
  it("does not match the app root or lookalikes", () => {
    expect(shouldBootAdmin("/")).toBe(false);
    expect(shouldBootAdmin("/administrators")).toBe(false);
    expect(shouldBootAdmin("/x/admin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/adminBoot.test.ts`
Expected: FAIL, cannot resolve `./adminBoot`.

- [ ] **Step 3: Implement `frontend/src/lib/adminBoot.ts`**

```ts
// The admin console is a separate top-level screen reached at /admin. Pages
// and the vite dev server both serve index.html for unmatched paths, so this
// pathname check is the whole router.
export function shouldBootAdmin(pathname: string = window.location.pathname): boolean {
  return pathname.replace(/\/+$/, "") === "/admin";
}
```

- [ ] **Step 4: Run**

Run: `cd frontend && npx vitest run src/lib/adminBoot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write `frontend/src/admin/api.ts`**

```ts
// Typed fetches for the admin console. One call per panel so a failing panel
// never blanks the page. Everything goes through apiFetch, which attaches the
// Clerk session token and handles the 401 refresh.
import { API_BASE, apiFetch, errorDetail } from "../lib/http";

export interface AdminWhoami {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  hostedMode: boolean;
}

export interface ClerkUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
  lastSignInAt: number | null;
  banned: boolean;
  locked: boolean;
}

export interface UsersPage {
  configured: boolean;
  users: ClerkUser[];
  total: number;
  error: string | null;
}

export interface UsageRow {
  userId: string;
  stateRows: number;
  stateBytes: number;
  runs: number;
  sweeps: number;
  wfo: number;
  alerts: number;
  triggered: number;
  costProfiles: number;
  patternPresets: number;
  lastSeen: number | null;
}

export interface LogRecord {
  time: number;
  level: string;
  logger: string;
  message: string;
}

// Each probe is either its payload or {error}, so the panel renders per-section.
export type Probe<T> = T | { error: string };

export interface FeedRow {
  broker: string;
  epic: string;
  running: boolean;
  alerts: number;
}

export interface DbRow {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
}

export interface HealthSnapshot {
  process: Probe<{ uptimeSeconds: number; pid: number; hostedMode: boolean }>;
  idleSeconds: Probe<number>;
  feeds: Probe<FeedRow[]>;
  alerts: Probe<{ armed: number; feeds: number }>;
  brokers: Probe<{ registered: string[]; restricted: string[]; default: string | null }>;
  databases: Probe<DbRow[]>;
  disk: Probe<{ path: string; totalBytes: number; freeBytes: number }>;
  snapshot: Probe<{ enabled: boolean; frontendUrl: string | null }>;
}

/** Thrown with status so the page can tell "not an admin" from "it broke". */
export class AdminHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new AdminHttpError(res.status, await errorDetail(res));
  return (await res.json()) as T;
}

export const fetchWhoami = () => get<AdminWhoami>("/api/admin/whoami");
export const fetchUsers = (limit = 50, offset = 0, query = "") =>
  get<UsersPage>(
    `/api/admin/users?limit=${limit}&offset=${offset}&query=${encodeURIComponent(query)}`,
  );
export const fetchHealth = () => get<HealthSnapshot>("/api/admin/health");
export const fetchUsage = () => get<{ users: UsageRow[] }>("/api/admin/usage");
export const fetchLogs = (limit = 200, level = "DEBUG") =>
  get<{ records: LogRecord[]; capacity: number }>(
    `/api/admin/logs?limit=${limit}&level=${level}`,
  );
```

- [ ] **Step 6: Write the failing `AdminApp` test** in `frontend/src/admin/AdminApp.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AdminApp from "./AdminApp";
import * as api from "./api";

function stubPanels() {
  vi.spyOn(api, "fetchUsers").mockResolvedValue({
    configured: true,
    users: [
      {
        id: "user_1",
        email: "boss@example.com",
        firstName: "Ada",
        lastName: null,
        imageUrl: null,
        createdAt: 1700000000000,
        lastActiveAt: 1800000000000,
        lastSignInAt: null,
        banned: false,
        locked: false,
      },
    ],
    total: 1,
    error: null,
  });
  vi.spyOn(api, "fetchHealth").mockResolvedValue({
    process: { uptimeSeconds: 12, pid: 7, hostedMode: true },
    idleSeconds: 3,
    feeds: [],
    alerts: { armed: 0, feeds: 0 },
    brokers: { registered: ["dukascopy"], restricted: ["capital"], default: "dukascopy" },
    databases: [{ name: "app_state", path: "app_state.db", exists: true, bytes: 10 }],
    disk: { path: ".", totalBytes: 100, freeBytes: 50 },
    snapshot: { enabled: true, frontendUrl: null },
  } as never);
  vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: [] });
  vi.spyOn(api, "fetchLogs").mockResolvedValue({ records: [], capacity: 500 });
}

describe("AdminApp", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the denial state when whoami is 403", async () => {
    vi.spyOn(api, "fetchWhoami").mockRejectedValue(
      new api.AdminHttpError(403, "admin access required"),
    );
    render(<AdminApp />);
    expect(await screen.findByText(/do not have admin access/i)).toBeTruthy();
  });

  it("renders the panels for an admin", async () => {
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "user_1",
      email: "boss@example.com",
      isAdmin: true,
      hostedMode: true,
    });
    stubPanels();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getByText(/boss@example.com/)).toBeTruthy());
    expect(screen.getByRole("heading", { name: /users/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /health/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /usage/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /logs/i })).toBeTruthy();
  });

  it("shows a load error without blanking the page", async () => {
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "user_1",
      email: null,
      isAdmin: true,
      hostedMode: false,
    });
    stubPanels();
    vi.spyOn(api, "fetchUsers").mockRejectedValue(new Error("network down"));
    render(<AdminApp />);
    expect(await screen.findByText(/network down/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /health/i })).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd frontend && npx vitest run src/admin/AdminApp.test.tsx`
Expected: FAIL, cannot resolve `./AdminApp`.

- [ ] **Step 8: Implement the panels and the shell**

`frontend/src/admin/admin.css` (imported by `AdminApp.tsx`) reuses the existing theme tokens:

```css
.admin-page { min-height: 100vh; background: var(--bg); color: var(--text);
  font: 13px/1.5 var(--sans, system-ui, sans-serif); padding: 0 0 48px; }
.admin-header { display: flex; align-items: center; gap: 12px;
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  background: var(--surface); position: sticky; top: 0; z-index: 2; }
.admin-header h1 { font-size: 15px; margin: 0; font-weight: 600; }
.admin-header .spacer { flex: 1; }
.admin-who { color: var(--text-dim); }
.admin-body { display: flex; flex-direction: column; gap: 16px;
  padding: 16px 20px; max-width: 1200px; margin: 0 auto; }
.admin-card { background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; overflow: hidden; }
.admin-card > header { display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid var(--border); }
.admin-card > header h2 { font-size: 13px; margin: 0; font-weight: 600; }
.admin-card > header .stamp { margin-left: auto; color: var(--text-faint);
  font-size: 11px; }
.admin-card .content { padding: 12px 14px; overflow-x: auto; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.admin-table th { text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  white-space: nowrap; cursor: pointer; }
.admin-table td { padding: 6px 10px; border-bottom: 1px solid var(--border);
  white-space: nowrap; }
.admin-table tr:last-child td { border-bottom: none; }
.admin-mono { font-family: var(--mono); font-size: 11px; }
.admin-dim { color: var(--text-dim); }
.admin-error { color: var(--neg); }
.admin-btn { background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px;
  cursor: pointer; }
.admin-btn:hover { background: var(--hover); }
.admin-logs { font-family: var(--mono); font-size: 11px; max-height: 340px;
  overflow: auto; }
.admin-logs .lvl-ERROR, .admin-logs .lvl-CRITICAL { color: var(--neg); }
.admin-logs .lvl-WARNING { color: #d9a441; }
```

`AdminApp.tsx` owns the header, the shared refresh signal, and the whoami gate:

```tsx
import { useCallback, useEffect, useState } from "react";
import "./admin.css";
import { AdminHttpError, fetchWhoami, type AdminWhoami } from "./api";
import UsersPanel from "./UsersPanel";
import HealthPanel from "./HealthPanel";
import UsagePanel from "./UsagePanel";
import LogsPanel from "./LogsPanel";
import type { ClerkUser } from "./api";

export default function AdminApp() {
  const [who, setWho] = useState<AdminWhoami | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Users loads first and the usage table joins to it by id, so the ids live
  // here rather than being fetched twice.
  const [users, setUsers] = useState<ClerkUser[]>([]);

  useEffect(() => {
    let live = true;
    fetchWhoami()
      .then((w) => live && setWho(w))
      .catch((e) => {
        if (!live) return;
        if (e instanceof AdminHttpError && e.status === 403) setDenied(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (denied) {
    return (
      <div className="admin-page">
        <div className="admin-body">
          <div className="admin-card">
            <div className="content">
              You do not have admin access. Ask the operator to add your account
              to the admin list.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>Admin</h1>
        <span className="spacer" />
        {error ? <span className="admin-error">{error}</span> : null}
        <span className="admin-who">{who?.email ?? who?.userId ?? ""}</span>
        <button className="admin-btn" onClick={refresh}>Refresh</button>
        <a className="admin-btn" href="/">Back to app</a>
      </header>
      <div className="admin-body">
        <UsersPanel refreshKey={refreshKey} onUsers={setUsers} />
        <HealthPanel refreshKey={refreshKey} />
        <UsagePanel refreshKey={refreshKey} users={users} />
        <LogsPanel refreshKey={refreshKey} />
      </div>
    </div>
  );
}
```

Every panel follows one shape. Write a tiny shared `Card` in `AdminApp.tsx`'s folder if it helps, but each panel MUST: take `refreshKey: number`, refetch in a `useEffect` keyed on it, hold `{data, loading, error}`, render its `<h2>` inside `<header>` (so `getByRole("heading")` finds it), show `error` in a `.admin-error` element, and show a `.stamp` with the last refresh time.

The four panel components are given in full in the **Panel reference implementations** appendix at the end of this plan. Copy them from there. Shared rules they all obey: take `refreshKey: number`, refetch in a `useEffect` keyed on it, hold `{data, loading, error}`, render their `<h2>` inside `<header>` so `getByRole("heading")` finds it, show `error` in a `.admin-error` element, and show a `.stamp` with the last refresh time. `HealthPanel` and `LogsPanel` poll every 30s; `UsersPanel` and `UsagePanel` do not. Explanatory copy uses `InfoTip` from `../components/InfoTip`, never `title=`.

- [ ] **Step 9: Write the failing `UsagePanel` test** in `frontend/src/admin/UsagePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UsagePanel from "./UsagePanel";
import * as api from "./api";
import type { ClerkUser, UsageRow } from "./api";

const ROWS: UsageRow[] = [
  { userId: "user_1", stateRows: 3, stateBytes: 300, runs: 5, sweeps: 1, wfo: 0,
    alerts: 2, triggered: 7, costProfiles: 0, patternPresets: 1, lastSeen: 2000 },
  { userId: "user_2", stateRows: 1, stateBytes: 100, runs: 9, sweeps: 0, wfo: 0,
    alerts: 0, triggered: 0, costProfiles: 0, patternPresets: 0, lastSeen: 1000 },
];

const CLERK: ClerkUser[] = [
  { id: "user_1", email: "ada@example.com", firstName: null, lastName: null,
    imageUrl: null, createdAt: null, lastActiveAt: null, lastSignInAt: null,
    banned: false, locked: false },
];

afterEach(() => vi.restoreAllMocks());

describe("UsagePanel", () => {
  it("joins rows to Clerk emails and falls back to the raw id", async () => {
    vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: ROWS });
    render(<UsagePanel refreshKey={0} users={CLERK} />);
    await waitFor(() => expect(screen.getByText("ada@example.com")).toBeTruthy());
    expect(screen.getByText("user_2")).toBeTruthy();
  });

  it("renders the error state", async () => {
    vi.spyOn(api, "fetchUsage").mockRejectedValue(new Error("usage blew up"));
    render(<UsagePanel refreshKey={0} users={[]} />);
    expect(await screen.findByText(/usage blew up/)).toBeTruthy();
  });

  it("sorts by a clicked column", async () => {
    vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: ROWS });
    render(<UsagePanel refreshKey={0} users={[]} />);
    await waitFor(() => expect(screen.getByText("user_1")).toBeTruthy());
    await userEvent.click(screen.getByRole("columnheader", { name: /runs/i }));
    const ids = screen.getAllByTestId("usage-user").map((el) => el.textContent);
    expect(ids[0]).toContain("user_2"); // 9 runs sorts above 5
  });
});
```

`UsagePanel` must therefore give each user cell `data-testid="usage-user"`, render column headers as `<th>` (role `columnheader`) with click-to-sort, and default to the server's order.

- [ ] **Step 10: Run both component tests**

Run: `cd frontend && npx vitest run src/admin/AdminApp.test.tsx src/admin/UsagePanel.test.tsx`
Expected: PASS. Iterate on the components until they do. Do NOT run the whole frontend suite.

- [ ] **Step 11: Wire `/admin` into `main.tsx`**

The admin console renders INSIDE the Clerk tree (it needs `ClerkTokenBridge` to have run so `apiFetch` attaches a token), unlike the snapshot boot which renders outside it. The path check wins over `shouldBootMobile()`.

```tsx
import AdminApp from './admin/AdminApp.tsx'
import { shouldBootAdmin } from './lib/adminBoot.ts'

// ... alongside the existing `bootMobile` line:
const bootAdmin = shouldBootAdmin()
```

Then in the render tree, inside `<AccountGate>`:

```tsx
          <AccountGate>
            {bootAdmin ? <AdminApp /> : bootMobile ? <MobileApp /> : <App />}
          </AccountGate>
```

and in the no-Clerk fallback branch:

```tsx
    ) : bootAdmin ? (
      <AdminApp />
    ) : bootMobile ? (
      <MobileApp />
    ) : (
      <App />
    )}
```

- [ ] **Step 12: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors in `src/admin/*` or `src/lib/adminBoot.ts` (judge by per-file parity with the pre-change baseline, not by a clean exit).

- [ ] **Step 13: Verify in the running app**

Start the backend (`cd backend && python3 -m uvicorn auto_trader.api.app:app --port 8000`) and the frontend (`cd frontend && npm run dev`), open `http://localhost:5173/admin`, and confirm: all four panels render, Users says "Clerk not configured" in local dev, Health shows real db sizes, Usage shows the `dev` row, Logs shows recent lines. Take note of anything visibly broken and fix before committing.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/admin frontend/src/lib/adminBoot.ts frontend/src/lib/adminBoot.test.ts \
  frontend/src/main.tsx
git commit -m "feat(admin): admin console page at /admin"
```

---

### Task 7: Deploy wiring for `CLERK_SECRET_KEY`

**Files:**
- Modify: `scripts/deploy-demo.sh`
- Modify: `CLAUDE.md` (document the console)
- Test: manual, on the box.

**Interfaces:**
- Consumes: `core.clerk_admin.SECRET_ENV`.
- Produces: no code interfaces. A documented env var and a preflight.

- [ ] **Step 1: Read the deploy script's env handling**

Run: `grep -n "ADMIN_EMAILS\|ADMIN_USER_IDS\|demo.env\|leak\|prefix" scripts/deploy-demo.sh`
Understand how the existing broker-credential leak guard and the admin-env preflight work before editing.

- [ ] **Step 2: Teach the leak guard about the new var**

`CLERK_SECRET_KEY` belongs on the box and must NEVER reach the frontend bundle. In `scripts/deploy-demo.sh`, add an explicit check in the frontend-build section that fails the deploy if `CLERK_SECRET_KEY` appears anywhere in the built assets:

```bash
# The Clerk BACKEND secret must never ship to the browser. Fail closed.
if grep -rqE 'sk_(live|test)_' frontend/dist 2>/dev/null; then
  echo "FATAL: a Clerk secret key appears in the frontend bundle" >&2
  exit 1
fi
```

Place it immediately after the existing frontend build step, matching the script's existing error style (adjust the `frontend/dist` path if the script builds elsewhere).

- [ ] **Step 3: Document the env var in the script header**

Add `CLERK_SECRET_KEY` to the list of `/etc/auto-trader/demo.env` variables in the script's header comment, with the note: "backend only, powers the admin console Users panel; without it the panel reports Clerk not configured".

- [ ] **Step 4: Document the console in `CLAUDE.md`**

Add a short section after the Alerts section:

```markdown
## Admin console

`/admin` is a read-only operator page (Clerk users, system health, per-user
usage counts, recent logs). Every panel reads a gated `/api/admin/*` endpoint;
the gate is `deps.require_admin_console` (403 `admin access required`), which
is separate from the dealing gate on purpose. Admin identity is unchanged:
`ADMIN_EMAILS` / `ADMIN_USER_IDS`, with dev mode always admin.

The Users panel needs `CLERK_SECRET_KEY` (Clerk Backend API, backend only);
without it the endpoint answers `configured: false` and the panel says so.
Logs come from an in-process ring buffer (`core/log_buffer.py`), so they cover
the current process only and reset on restart. Cross-user queries live in
`core/admin_usage.py` and must not be imported anywhere else.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-demo.sh CLAUDE.md
git commit -m "chore(admin): deploy wiring and docs for the admin console"
```

- [ ] **Step 6: Deploy and verify (operator step, needs the box)**

1. Add `CLERK_SECRET_KEY=sk_live_...` to `/etc/auto-trader/demo.env` on the Lightsail box and restart `auto-trader-demo`.
2. Run `scripts/deploy-demo.sh`.
3. Open `https://chartkar.app/admin` signed in as an admin: all four panels populate, Users lists real accounts.
4. Sign in as a non-admin (or clear `ADMIN_EMAILS` locally in a scratch env) and confirm the denial state, plus `curl -s -o /dev/null -w '%{http_code}' https://api.chartkar.app/api/admin/users` returning 401 unauthenticated.

---

## Panel reference implementations

Copy these four files verbatim in Task 6 Step 8. They share one shape: a
`refreshKey` prop, a keyed `useEffect`, and a `{data, loading, error}` triple.

`frontend/src/admin/format.ts`:

```ts
// Small shared formatters for the console tables.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Epoch ms to a local short timestamp; null renders as a placeholder. */
export function formatTime(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
  return new Date(ms).toLocaleString();
}

/** A probe that failed carries {error}; narrow with this before rendering. */
export function probeError(value: unknown): string | null {
  if (value && typeof value === "object" && "error" in (value as Record<string, unknown>)) {
    return String((value as { error: unknown }).error);
  }
  return null;
}
```

`frontend/src/admin/Card.tsx`:

```tsx
import type { ReactNode } from "react";

/** One console panel: heading, optional controls, a last-refreshed stamp, and
 *  a body that shows either the error, the loading line, or the content. */
export default function Card({
  title,
  info,
  controls,
  stamp,
  loading,
  error,
  children,
}: {
  title: string;
  info?: ReactNode;
  controls?: ReactNode;
  stamp: number | null;
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <section className="admin-card">
      <header>
        <h2>{title}</h2>
        {info}
        {controls}
        <span className="stamp">
          {loading ? "loading" : stamp ? new Date(stamp).toLocaleTimeString() : ""}
        </span>
      </header>
      <div className="content">
        {error ? <div className="admin-error">{error}</div> : children}
      </div>
    </section>
  );
}
```

`frontend/src/admin/UsersPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchUsers, type ClerkUser, type UsersPage } from "./api";
import { formatTime } from "./format";

export default function UsersPanel({
  refreshKey,
  onUsers,
}: {
  refreshKey: number;
  onUsers: (users: ClerkUser[]) => void;
}) {
  const [page, setPage] = useState<UsersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");

  // Debounce the search box: Clerk's API is rate limited.
  useEffect(() => {
    const id = setTimeout(() => setTerm(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUsers(50, 0, term)
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(null);
        setStamp(Date.now());
        onUsers(p.users);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [refreshKey, term, onUsers]);

  return (
    <Card
      title="Users"
      info={
        <InfoTip
          title="Clerk users"
          text={[
            "Read from the Clerk Backend API.",
            "Read only: no ban, delete or metadata writes.",
          ]}
        />
      }
      controls={
        <input
          className="admin-btn"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      {page && !page.configured ? (
        <div className="admin-dim">
          Clerk not configured. Set CLERK_SECRET_KEY on the backend to list users.
        </div>
      ) : page?.error ? (
        <div className="admin-error">{page.error}</div>
      ) : (
        <>
          <div className="admin-dim" style={{ marginBottom: 8 }}>
            {page ? `${page.users.length} shown of ${page.total}` : ""}
          </div>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>User id</th>
                <th>Created</th>
                <th>Last active</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {(page?.users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>{u.email ?? "–"}</td>
                  <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "–"}</td>
                  <td className="admin-mono">{u.id}</td>
                  <td>{formatTime(u.createdAt)}</td>
                  <td>{formatTime(u.lastActiveAt)}</td>
                  <td>
                    {u.banned ? "banned" : u.locked ? "locked" : "active"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
```

`frontend/src/admin/HealthPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import Card from "./Card";
import { fetchHealth, type HealthSnapshot } from "./api";
import { formatBytes, formatDuration, probeError } from "./format";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="admin-dim" style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

export default function HealthPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchHealth()
      .then((h) => {
        if (!live) return;
        setData(h);
        setError(null);
        setStamp(Date.now());
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [refreshKey, tick]);

  if (!data) {
    return <Card title="Health" stamp={stamp} loading={loading} error={error}>{null}</Card>;
  }

  const proc = probeError(data.process) ? null : (data.process as { uptimeSeconds: number; pid: number; hostedMode: boolean });
  const feeds = probeError(data.feeds) ? null : (data.feeds as HealthSnapshot["feeds"] & object[]);
  const dbs = probeError(data.databases) ? null : (data.databases as { name: string; path: string; exists: boolean; bytes: number }[]);
  const disk = probeError(data.disk) ? null : (data.disk as { path: string; totalBytes: number; freeBytes: number });
  const brokers = probeError(data.brokers) ? null : (data.brokers as { registered: string[]; restricted: string[]; default: string | null });
  const snap = probeError(data.snapshot) ? null : (data.snapshot as { enabled: boolean; frontendUrl: string | null });

  return (
    <Card title="Health" stamp={stamp} loading={loading} error={error}>
      <Section label="Process">
        {proc ? (
          <div>
            up {formatDuration(proc.uptimeSeconds)}, pid {proc.pid},{" "}
            {proc.hostedMode ? "hosted" : "local"} mode, idle{" "}
            {typeof data.idleSeconds === "number" ? `${data.idleSeconds}s` : "?"}
          </div>
        ) : (
          <div className="admin-error">{probeError(data.process)}</div>
        )}
      </Section>

      <Section label="Live feeds">
        {feeds ? (
          feeds.length === 0 ? (
            <div className="admin-dim">No feeds running.</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr><th>Broker</th><th>Epic</th><th>Running</th><th>Alerts</th></tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <tr key={`${f.broker}:${f.epic}`}>
                    <td>{f.broker}</td>
                    <td>{f.epic}</td>
                    <td>{f.running ? "yes" : "no"}</td>
                    <td>{f.alerts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <div className="admin-error">{probeError(data.feeds)}</div>
        )}
      </Section>

      <Section label="Brokers">
        {brokers ? (
          <div>
            {brokers.registered.join(", ") || "none"}{" "}
            <span className="admin-dim">
              (default {brokers.default ?? "none"}; restricted {brokers.restricted.join(", ")})
            </span>
          </div>
        ) : (
          <div className="admin-error">{probeError(data.brokers)}</div>
        )}
      </Section>

      <Section label="Databases">
        {dbs ? (
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Size</th><th>Path</th></tr></thead>
            <tbody>
              {dbs.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td>{d.exists ? formatBytes(d.bytes) : "missing"}</td>
                  <td className="admin-mono admin-dim">{d.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="admin-error">{probeError(data.databases)}</div>
        )}
      </Section>

      <Section label="Disk">
        {disk ? (
          <div>
            {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}{" "}
            <span className="admin-mono admin-dim">{disk.path}</span>
          </div>
        ) : (
          <div className="admin-error">{probeError(data.disk)}</div>
        )}
      </Section>

      <Section label="Chart snapshots">
        {snap ? (
          <div>
            {snap.enabled ? "enabled" : "disabled"}
            {snap.frontendUrl ? `, frontend ${snap.frontendUrl}` : ", FRONTEND_URL not set"}
          </div>
        ) : (
          <div className="admin-error">{probeError(data.snapshot)}</div>
        )}
      </Section>
    </Card>
  );
}
```

`frontend/src/admin/UsagePanel.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchUsage, type ClerkUser, type UsageRow } from "./api";
import { formatBytes, formatTime } from "./format";

const COLUMNS: { key: keyof UsageRow; label: string }[] = [
  { key: "stateRows", label: "State rows" },
  { key: "stateBytes", label: "State size" },
  { key: "runs", label: "Runs" },
  { key: "sweeps", label: "Sweeps" },
  { key: "wfo", label: "WFO" },
  { key: "alerts", label: "Alerts" },
  { key: "triggered", label: "Triggered" },
  { key: "costProfiles", label: "Costs" },
  { key: "patternPresets", label: "Presets" },
  { key: "lastSeen", label: "Last seen" },
];

export default function UsagePanel({
  refreshKey,
  users,
}: {
  refreshKey: number;
  users: ClerkUser[];
}) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [sort, setSort] = useState<keyof UsageRow | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUsage()
      .then((u) => {
        if (!live) return;
        setRows(u.users);
        setError(null);
        setStamp(Date.now());
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const emailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) if (u.email) m.set(u.id, u.email);
    return m;
  }, [users]);

  // Server order is the default; a clicked column sorts descending by value.
  const shown = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0));
  }, [rows, sort]);

  return (
    <Card
      title="Usage"
      info={
        <InfoTip
          title="Per-user usage"
          text={[
            "Row counts and sizes only.",
            "No user content is read or shown here.",
          ]}
        />
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            {COLUMNS.map((c) => (
              <th key={c.key} onClick={() => setSort(c.key)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.userId}>
              <td data-testid="usage-user">
                {emailById.get(r.userId) ?? r.userId}
              </td>
              {COLUMNS.map((c) => (
                <td key={c.key}>
                  {c.key === "lastSeen"
                    ? formatTime(r.lastSeen)
                    : c.key === "stateBytes"
                      ? formatBytes(r.stateBytes)
                      : String(r[c.key] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

`frontend/src/admin/LogsPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchLogs, type LogRecord } from "./api";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];

export default function LogsPanel({ refreshKey }: { refreshKey: number }) {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [level, setLevel] = useState("INFO");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchLogs(200, level)
      .then((r) => {
        if (!live) return;
        setRecords(r.records);
        setError(null);
        setStamp(Date.now());
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [refreshKey, level, tick]);

  return (
    <Card
      title="Logs"
      info={
        <InfoTip
          title="Recent logs"
          text={[
            "In-process buffer, newest first.",
            "Current process only; cleared on restart.",
          ]}
        />
      }
      controls={
        <select
          className="admin-btn"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          aria-label="Minimum level"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      <div className="admin-logs">
        {records.length === 0 ? (
          <div className="admin-dim">No records at this level.</div>
        ) : (
          records.map((r, i) => (
            <div key={`${r.time}-${i}`} className={`lvl-${r.level}`}>
              {new Date(r.time).toLocaleTimeString()} {r.level} {r.logger}{" "}
              {r.message}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
```

Note on the `HealthPanel` narrowing casts: they exist because each probe is
`T | {error}`. If `tsc -b` complains about the `feeds` cast, type it as
`FeedRow[]` directly rather than reaching for `any`.

## Notes for the executor

- The Task 1 test file is written once and grows across tasks 2-5. Until Task 5 lands, the parametrized 403/401 cases for not-yet-built endpoints fail with 404. That is expected; each task's own `-k` filter is what must be green, and Task 5 Step 8 is where the whole file must pass.
- If `pytest.mark.anyio` is not how this repo marks async tests, follow the repo's existing convention (Task 5 Step 2 says how to find it).
- Never run the full frontend vitest suite; it locks the machine.
