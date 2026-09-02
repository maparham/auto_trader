# Per-User Data Partitioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-data store row, workspace broadcast, and in-memory job/progress entry is scoped by `request.state.user_id`; market data stays shared; dev mode ('dev' user) behaves exactly as today.

**Architecture:** Approach A from the spec — add a `user_id` column to the five user-data SQLite stores via a tiny reusable `PRAGMA user_version` migration helper; thread `user_id` from `request.state` (HTTP) / `verify_ws` (WS) into every store call; scope the `/ws/state` fan-out per user; tag in-memory sweep/WFO jobs and backtest progress entries with an owner and filter all reads; replace the heavy-job semaphore with a per-user round-robin FairGate. Frontend change is one guarded branch in the hydrate path.

**Tech Stack:** stdlib sqlite3 (WAL, per-op connections via asyncio.to_thread — the existing house pattern), FastAPI, threading primitives, pytest + tests/clerk_fake.py, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-per-user-data-partitioning-design.md`

## Global Constraints

- The scoping key is the literal `request.state.user_id` (set by auth middleware; `"dev"` in dev mode). New helper `current_user(request)` in `api/deps.py` is the ONLY way routes read it.
- Existing rows migrate to `user_id = 'dev'` — the constant string `dev`, matching `auth.DEV_USER_ID`.
- Caps become per-user with the same numbers: 200 runs, 50 sweeps, 50 WFO rows per user.
- Composite PKs after migration: `app_state(user_id, key)`, `cost_profiles(user_id, epic)`. `runs`/`sweeps`/`wfo` keep PK `id` and gain `user_id` + index `(user_id, created_at)`.
- Migrations are guarded by `PRAGMA user_version` per DB file AND introspect with `PRAGMA table_info` so a fresh new-schema DB is just stamped, never rebuilt.
- Candle/tick stores and the compute-host proxy are NOT touched.
- Cross-user access to a job/run/sweep/wfo id returns 404 (indistinguishable from missing).
- Backend tests: `cd backend && uv run pytest ...`; frontend: `cd frontend && npx vitest run <file>` / `npm run test:unit`; types `npx tsc -b`.
- Dev-path regression gate: the FULL existing backend and frontend suites must pass unchanged (everything resolves to user 'dev').
- Commit style `feat(scope):` / `fix(scope):`.

---

### Task 1: Migration helper (`core/db_migrate.py`)

**Files:**
- Create: `backend/auto_trader/core/db_migrate.py`
- Test: `backend/tests/test_db_migrate.py`

**Interfaces:**
- Produces: `run_migrations(conn: sqlite3.Connection, steps: dict[int, Callable[[sqlite3.Connection], None]]) -> None` — for each version v in sorted order with v > current `PRAGMA user_version`, runs `steps[v](conn)` inside the same transaction then sets `user_version = v`, committing per step. Also `table_columns(conn, table) -> list[str]` (from `PRAGMA table_info`).
- Tasks 2–5 pass `{1: <their step>}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_db_migrate.py`:

```python
"""run_migrations: user_version-gated, per-step transaction, idempotent."""
from __future__ import annotations

import sqlite3

from auto_trader.core.db_migrate import run_migrations, table_columns


def _mem() -> sqlite3.Connection:
    return sqlite3.connect(":memory:")


def test_runs_pending_steps_and_stamps_version():
    conn = _mem()
    calls: list[int] = []
    run_migrations(conn, {1: lambda c: calls.append(1), 2: lambda c: calls.append(2)})
    assert calls == [1, 2]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2


def test_skips_already_applied_versions():
    conn = _mem()
    conn.execute("PRAGMA user_version = 1")
    calls: list[int] = []
    run_migrations(conn, {1: lambda c: calls.append(1), 2: lambda c: calls.append(2)})
    assert calls == [2]


def test_noop_when_current():
    conn = _mem()
    conn.execute("PRAGMA user_version = 2")
    run_migrations(conn, {1: lambda c: (_ for _ in ()).throw(AssertionError)})
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2


def test_failing_step_does_not_stamp():
    conn = _mem()
    conn.execute("CREATE TABLE t (a)")

    def bad(c: sqlite3.Connection) -> None:
        c.execute("INSERT INTO t VALUES (1)")
        raise RuntimeError("boom")

    try:
        run_migrations(conn, {1: bad})
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0  # rolled back


def test_table_columns():
    conn = _mem()
    conn.execute("CREATE TABLE t (a TEXT, b INTEGER)")
    assert table_columns(conn, "t") == ["a", "b"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_db_migrate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.core.db_migrate'`

- [ ] **Step 3: Implement**

`backend/auto_trader/core/db_migrate.py`:

```python
"""Minimal sqlite migration runner, shared by the user-data stores.

Versioning rides SQLite's built-in `PRAGMA user_version` (an int stored in the
DB header, 0 for every existing file), so no migrations table is needed. Each
store passes {version: step}; every step with version > current runs inside
one transaction and stamps the new version — a failed step rolls back and
leaves the version unstamped, so the next startup retries it.

This replaces the one-off inline pattern in tick_store.py for NEW migrations;
tick_store's own migration is deliberately left as-is.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable


def table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def run_migrations(
    conn: sqlite3.Connection,
    steps: dict[int, Callable[[sqlite3.Connection], None]],
) -> None:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(steps):
        if version <= current:
            continue
        try:
            steps[version](conn)
            # PRAGMA cannot be parameterized; version is an int from our code.
            conn.execute(f"PRAGMA user_version = {int(version)}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_db_migrate.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/db_migrate.py backend/tests/test_db_migrate.py
git commit -m "feat(store): user_version-gated sqlite migration runner"
```

---

### Task 2: StateStore per-user + scoped /ws/state fan-out

**Files:**
- Modify: `backend/auto_trader/core/state_store.py` (whole file is ~100 lines)
- Modify: `backend/auto_trader/api/routers/state.py` (whole file is ~100 lines)
- Test: `backend/tests/test_state_store_users.py`, `backend/tests/test_api_state_users.py`

**Interfaces:**
- Consumes: `run_migrations`, `table_columns` (Task 1); `verify_ws` returns `str | None` (existing); `tests/clerk_fake.py` `install(monkeypatch)` + `make_token(sub=...)` (existing).
- Produces: `StateStore.get_all(user_id) / set(user_id, key, value) / delete(user_id, key)`; `current_user(request) -> str` in `api/deps.py` (created HERE, reused by Tasks 3–6):

```python
def current_user(request) -> str:
    """The verified user id the auth middleware stamped on this request
    ('dev' in local mode). The only sanctioned way routes read it."""
    return request.state.user_id
```

- [ ] **Step 1: Write the failing store tests**

`backend/tests/test_state_store_users.py`:

```python
"""StateStore: per-user documents + migration of a pre-partitioning DB."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.state_store import StateStore


def test_users_have_disjoint_documents(tmp_path):
    store = StateStore(str(tmp_path / "s.db"))
    asyncio.run(store.set("alice", "k", '"a"'))
    asyncio.run(store.set("bob", "k", '"b"'))
    assert asyncio.run(store.get_all("alice")) == {"k": '"a"'}
    assert asyncio.run(store.get_all("bob")) == {"k": '"b"'}
    asyncio.run(store.delete("alice", "k"))
    assert asyncio.run(store.get_all("alice")) == {}
    assert asyncio.run(store.get_all("bob")) == {"k": '"b"'}


def test_migrates_old_single_user_db_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, "
        "updated_at INTEGER)"
    )
    conn.execute("INSERT INTO app_state VALUES ('k1', '1', 0), ('k2', '2', 0)")
    conn.commit()
    conn.close()

    store = StateStore(path)  # init runs the migration
    assert asyncio.run(store.get_all("dev")) == {"k1": "1", "k2": "2"}
    assert asyncio.run(store.get_all("alice")) == {}
    # Re-init is a no-op (idempotent).
    StateStore(path)
    assert asyncio.run(store.get_all("dev")) == {"k1": "1", "k2": "2"}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_state_store_users.py -v`
Expected: FAIL — `set()` takes 3 positional args / wrong signature.

- [ ] **Step 3: Rework `state_store.py`**

Replace the class body (docstring: update the "single-user … ONE global state document" paragraph to say the store is per-user keyed since the SaaS partitioning; keep the rest). New code:

```python
from auto_trader.core.db_migrate import run_migrations, table_columns

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS app_state ("
    "user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
    "updated_at INTEGER, PRIMARY KEY (user_id, key))"
)


def _migrate_v1(conn: sqlite3.Connection) -> None:
    """PK change (key) -> (user_id, key): sqlite needs a table rebuild.
    A fresh DB already has the new shape — just stamp it."""
    if "user_id" in table_columns(conn, "app_state"):
        return
    conn.execute(
        "CREATE TABLE app_state_new ("
        "user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
        "updated_at INTEGER, PRIMARY KEY (user_id, key))"
    )
    conn.execute(
        "INSERT INTO app_state_new SELECT 'dev', key, value, updated_at "
        "FROM app_state"
    )
    conn.execute("DROP TABLE app_state")
    conn.execute("ALTER TABLE app_state_new RENAME TO app_state")


class StateStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_v1})
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        conn.commit()
        return conn
```

then the three method pairs, each gaining `user_id: str` first and `WHERE user_id = ?` (upsert conflict target becomes `ON CONFLICT(user_id, key)`):

```python
    async def get_all(self, user_id: str) -> dict[str, str]:
        return await asyncio.to_thread(self._get_all_sync, user_id)

    def _get_all_sync(self, user_id: str) -> dict[str, str]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT key, value FROM app_state WHERE user_id = ?", (user_id,)
            ).fetchall()
            return {k: v for k, v in rows}
        finally:
            conn.close()

    async def set(self, user_id: str, key: str, value: str) -> None:
        await asyncio.to_thread(self._set_sync, user_id, key, value)

    def _set_sync(self, user_id: str, key: str, value: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO app_state (user_id, key, value, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (user_id, key, value, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    async def delete(self, user_id: str, key: str) -> None:
        await asyncio.to_thread(self._delete_sync, user_id, key)

    def _delete_sync(self, user_id: str, key: str) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "DELETE FROM app_state WHERE user_id = ? AND key = ?",
                (user_id, key),
            )
            conn.commit()
        finally:
            conn.close()
```

CRITICAL: the schema-on-connect `CREATE TABLE IF NOT EXISTS` in `_connect` now uses the NEW composite-PK shape (`_SCHEMA`), while `__init__` handles upgrading old files. Do NOT run migrations in `_connect` (it runs per operation).

- [ ] **Step 4: Add `current_user` to `api/deps.py`**

Append near the other helpers (exact code in Interfaces above; import nothing new — `request` is duck-typed, annotate as `Request` using the existing fastapi import if present, else add `from fastapi import Request`).

- [ ] **Step 5: Rework `routers/state.py`**

- Subscriber registry becomes `_state_subscribers: dict[WebSocket, str]` (socket → user id). Update the module comment.
- `_broadcast_state(user_id, message)`: only sockets with matching user id receive; snapshot with `[ws for ws, uid in list(_state_subscribers.items()) if uid == user_id]`; drops use `_state_subscribers.pop(ws, None)`.
- Routes (add `request: Request` param and `from ..deps import current_user`; note `deps.py` imports at call sites elsewhere use module attributes — a plain `from ..deps import current_user` is fine since it's a function, not a rebound global):

```python
@router.get("/api/state")
async def get_state(request: Request) -> dict[str, Any]:
    raw = await STATE_STORE.get_all(current_user(request))
    ...

@router.put("/api/state/{key}", status_code=204)
async def put_state(request: Request, key: str, body: StateValue, origin: str = Query("")) -> None:
    user = current_user(request)
    await STATE_STORE.set(user, key, json.dumps(body.value))
    await _broadcast_state(user, {"key": key, "value": body.value, "origin": origin})

@router.delete("/api/state/{key}", status_code=204)
async def delete_state(request: Request, key: str, origin: str = Query("")) -> None:
    user = current_user(request)
    await STATE_STORE.delete(user, key)
    await _broadcast_state(user, {"key": key, "deleted": True, "origin": origin})
```

- `ws_state`: capture the user id —

```python
    user_id = await verify_ws(websocket)
    if user_id is None:
        return
    await websocket.accept()
    _state_subscribers[websocket] = user_id
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _state_subscribers.pop(websocket, None)
```

- [ ] **Step 6: Write the failing router tests**

`backend/tests/test_api_state_users.py`:

```python
"""Per-user /api/state + scoped /ws/state fan-out (hosted mode, two tokens)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def test_state_documents_are_disjoint(clerk):
    client.put("/api/state/t.k", json={"value": 1}, headers=_auth("alice"))
    assert client.get("/api/state", headers=_auth("alice")).json() == {"t.k": 1}
    assert client.get("/api/state", headers=_auth("bob")).json() == {}
    client.delete("/api/state/t.k", headers=_auth("alice"))
    assert client.get("/api/state", headers=_auth("alice")).json() == {}


def test_ws_broadcast_scoped_to_writer_user(clerk):
    tok_a = clerk_fake.make_token(sub="alice")
    tok_b = clerk_fake.make_token(sub="bob")
    with client.websocket_connect(f"/ws/state?token={tok_a}") as ws_a, \
         client.websocket_connect(f"/ws/state?token={tok_b}") as ws_b:
        client.put(
            "/api/state/t.live", json={"value": 7},
            headers=_auth("alice"), params={"origin": "tab1"},
        )
        assert ws_a.receive_json() == {"key": "t.live", "value": 7, "origin": "tab1"}
        # Bob must NOT receive alice's write. Prove the socket stayed silent by
        # sending bob his own write and asserting it is the FIRST frame he sees.
        client.put(
            "/api/state/t.bob", json={"value": 8},
            headers=_auth("bob"), params={"origin": "tab2"},
        )
        assert ws_b.receive_json() == {"key": "t.bob", "value": 8, "origin": "tab2"}


def test_dev_mode_still_single_document(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    client.put("/api/state/t.dev", json={"value": 2})
    assert client.get("/api/state").json().get("t.dev") == 2
    client.delete("/api/state/t.dev")
```

Note: these tests hit the app's real STATE_STORE singleton (its DB path comes from settings). Add an autouse fixture at the top of THIS file that repoints the router at a temp store, mirroring `tests/conftest.py`'s `_isolated_run_store` pattern:

```python
from auto_trader.core.state_store import StateStore


@pytest.fixture(autouse=True)
def _isolated_state_store(tmp_path, monkeypatch):
    import auto_trader.api.routers.state as state_router
    monkeypatch.setattr(
        state_router, "STATE_STORE", StateStore(str(tmp_path / "state.db"))
    )
```

- [ ] **Step 7: Run the new tests, then the full suite**

Run: `cd backend && uv run pytest tests/test_state_store_users.py tests/test_api_state_users.py -v`
Expected: all PASS.
Run: `uv run pytest -q` — no new failures (pre-existing state tests may need their calls updated to the new signatures IF any exist: `grep -rn "STATE_STORE" tests/` and fix call sites to pass `"dev"`).

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/core/state_store.py backend/auto_trader/api/routers/state.py backend/auto_trader/api/deps.py backend/tests/test_state_store_users.py backend/tests/test_api_state_users.py
git commit -m "feat(state): per-user workspace documents and user-scoped /ws/state fan-out"
```

---

### Task 3: RunStore per-user + runs routes + owned progress registry

**Files:**
- Modify: `backend/auto_trader/core/run_store.py`
- Modify: `backend/auto_trader/core/progress.py`
- Modify: `backend/auto_trader/api/routers/backtest.py` (runs routes at ~lines 337, 648–676; progress/cancel routes at ~628–646; progress registration in `backtest()` at ~187)
- Test: `backend/tests/test_run_store_users.py`, `backend/tests/test_api_runs_users.py`

**Interfaces:**
- Consumes: `run_migrations`, `table_columns` (Task 1); `current_user` (Task 2).
- Produces: `RunStore.insert(user_id, rec) / list(user_id, limit=50, epic=None) / get(user_id, run_id) / delete(user_id, run_id)`; `progress.set_progress(progress_id, *, stage, owner="dev", ...)`, `get_progress(progress_id, owner="dev", ...)`, `request_cancel(progress_id, owner="dev")` — an owner mismatch behaves exactly like a missing entry.

- [ ] **Step 1: Write the failing store tests**

`backend/tests/test_run_store_users.py`:

```python
"""RunStore: per-user rows, per-user cap, migration of an old DB."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.run_store import RunStore


def _rec(rid: str, ts: int) -> dict:
    return {
        "id": rid, "created_at": ts, "epic": "US100", "timeframe": "1h",
        "range_from": 0, "range_to": 1, "strategy_kind": "coded",
        "strategy_name": None, "request": {}, "summary": {"net": 1}, "trades": [],
    }


def test_rows_and_cap_are_per_user(tmp_path):
    store = RunStore(str(tmp_path / "r.db"), cap=2)
    asyncio.run(store.insert("alice", _rec("a1", 1)))
    asyncio.run(store.insert("alice", _rec("a2", 2)))
    asyncio.run(store.insert("bob", _rec("b1", 3)))
    asyncio.run(store.insert("alice", _rec("a3", 4)))  # evicts a1, not b1
    assert [r["id"] for r in asyncio.run(store.list("alice"))] == ["a3", "a2"]
    assert [r["id"] for r in asyncio.run(store.list("bob"))] == ["b1"]
    assert asyncio.run(store.get("bob", "a2")) is None  # cross-user get -> None
    asyncio.run(store.delete("bob", "a2"))  # cross-user delete is a no-op
    assert asyncio.run(store.get("alice", "a2")) is not None


def test_migrates_old_db_rows_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, "
        "timeframe TEXT, range_from INTEGER, range_to INTEGER, strategy_kind TEXT, "
        "strategy_name TEXT, request_json TEXT, summary_json TEXT, trades_json TEXT)"
    )
    conn.execute(
        "INSERT INTO runs VALUES ('r1', 1, 'US100', '1h', 0, 1, 'coded', NULL, "
        "'{}', '{}', '[]')"
    )
    conn.commit()
    conn.close()
    store = RunStore(path)
    assert [r["id"] for r in asyncio.run(store.list("dev"))] == ["r1"]
    assert asyncio.run(store.list("alice")) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_run_store_users.py -v` — FAIL (signatures).

- [ ] **Step 3: Rework `run_store.py`**

- `_connect`'s `CREATE TABLE IF NOT EXISTS runs (...)` gains `user_id TEXT NOT NULL DEFAULT 'dev'` after `id TEXT PRIMARY KEY` plus, after the CREATE: `conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs (user_id, created_at)")`.
- `__init__` runs migrations (import from db_migrate):

```python
def _migrate_v1(conn: sqlite3.Connection) -> None:
    if "user_id" in table_columns(conn, "runs"):
        return
    conn.execute("ALTER TABLE runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'dev'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs (user_id, created_at)")
```

```python
    def __init__(self, db_path: str, cap: int = 200) -> None:
        self._db_path = db_path
        self._cap = cap
        conn = self._connect()
        try:
            run_migrations(conn, {1: _migrate_v1})
        finally:
            conn.close()
```

- All four method pairs gain `user_id: str` first. Query changes:
  - insert: column list gains `user_id`, values tuple gains `user_id` first; the prune becomes `"DELETE FROM runs WHERE user_id = ? AND id NOT IN (SELECT id FROM runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)"` with `(user_id, user_id, self._cap)`.
  - list: base SQL gains `WHERE user_id = ?` (epic filter becomes `AND epic = ?`).
  - get: `WHERE user_id = ? AND id = ?`.
  - delete: `WHERE user_id = ? AND id = ?`.

- [ ] **Step 4: Owner-tag `core/progress.py`**

- `set_progress` gains keyword `owner: str = "dev"`; the entry dict stores `"owner": owner` (preserve it across re-registration the same way `cancelled` is preserved — copy from `prev` ONLY the cancelled flag; owner comes from the argument each time).
- `get_progress(progress_id, owner="dev", now=None)`: after the stale check, `if entry.get("owner", "dev") != owner: return None`.
- `update_progress` unchanged (engine callbacks don't know users).
- `request_cancel(progress_id, owner="dev")`: `if entry is None or entry.get("owner", "dev") != owner: return False`.
- `clear_progress` unchanged (called by the owning handler only).

- [ ] **Step 5: Wire `routers/backtest.py` (runs + progress only — sweeps/wfo are Task 4)**

- Add `Request` to the fastapi import; `from ..deps import current_user` (deps is already imported as a module there — check the existing import style with `grep -n "^from \|^import " backend/auto_trader/api/routers/backtest.py | head -20` and match it).
- `backtest()` handler (`@router.post("/api/backtest")`): add `request: Request` param; compute `user = current_user(request)` at the top; `pr.set_progress(pid, stage=..., owner=user)` at all three `set_progress` call sites in this handler (~lines 189, 227, 271, 370); the `RUN_STORE.insert({...})` call (~337) becomes `RUN_STORE.insert(user, {...})`.
- `backtest_progress` (~628) and `cancel_backtest` (~638): add `request: Request`; pass `owner=current_user(request)` to `pr.get_progress` / `pr.request_cancel`.
- Runs routes (~648–676): add `request: Request`; `RUN_STORE.list(current_user(request), limit=limit, epic=epic)`, `RUN_STORE.get(current_user(request), run_id)`, `RUN_STORE.delete(current_user(request), run_id)`.
- `tests/conftest.py`'s `_isolated_run_store` keeps working (it swaps the singleton; signatures matter only at call sites). Fix any test in the suite that calls RUN_STORE/pr directly: `grep -rn "RUN_STORE\.\|set_progress(\|get_progress(\|request_cancel(" tests/ | grep -v test_run_store_users` and update call sites to pass `"dev"` / rely on defaults.

- [ ] **Step 6: Write the failing router tests**

`backend/tests/test_api_runs_users.py`:

```python
"""Hosted-mode isolation for /api/backtest/runs and the progress registry."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import progress as pr
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def test_runs_listing_is_per_user(clerk):
    import auto_trader.api.routers.backtest as bt

    rec = {
        "id": "r-alice", "created_at": 1, "epic": "US100", "timeframe": "1h",
        "range_from": 0, "range_to": 1, "strategy_kind": "coded",
        "strategy_name": None, "request": {}, "summary": {}, "trades": [],
    }
    import asyncio
    asyncio.run(bt.RUN_STORE.insert("alice", rec))
    ids = [r["id"] for r in client.get("/api/backtest/runs", headers=_auth("alice")).json()]
    assert "r-alice" in ids
    assert client.get("/api/backtest/runs", headers=_auth("bob")).json() == []
    assert client.get("/api/backtest/runs/r-alice", headers=_auth("bob")).status_code == 404
    assert client.get("/api/backtest/runs/r-alice", headers=_auth("alice")).status_code == 200


def test_progress_and_cancel_are_owner_scoped(clerk):
    pr.set_progress("p1", stage="simulate", owner="alice")
    assert client.get("/api/backtest/progress/p1", headers=_auth("alice")).status_code == 200
    assert client.get("/api/backtest/progress/p1", headers=_auth("bob")).status_code == 404
    r = client.post("/api/backtest/cancel/p1", headers=_auth("bob"))
    assert r.json().get("cancelled") in (False, None) or r.status_code == 404
    pr.clear_progress("p1")
```

(Adjust the cancel assertion to the route's actual response shape — read the handler; the requirement is that bob's cancel does NOT flag alice's entry, so also assert `pr.get_progress("p1", owner="alice")` is still non-cancelled by checking a follow-up alice cancel returns its success shape.)

- [ ] **Step 7: Run new tests + full suite**

Run: `cd backend && uv run pytest tests/test_run_store_users.py tests/test_api_runs_users.py -v` — PASS.
Run: `uv run pytest -q` — no new failures.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/core/run_store.py backend/auto_trader/core/progress.py backend/auto_trader/api/routers/backtest.py backend/tests/test_run_store_users.py backend/tests/test_api_runs_users.py
git commit -m "feat(runs): per-user run archive and owner-scoped progress registry"
```

---

### Task 4: SweepStore + WfoStore per-user + archive routes

**Files:**
- Modify: `backend/auto_trader/core/sweep_store.py`, `backend/auto_trader/core/wfo_store.py`
- Modify: `backend/auto_trader/api/routers/backtest.py` (sweep archive routes ~695–725; wfo archive/insert routes — find with `grep -n "WFO_STORE" backend/auto_trader/api/routers/backtest.py`)
- Test: `backend/tests/test_sweep_wfo_store_users.py`

**Interfaces:**
- Consumes: `run_migrations`, `table_columns`, `current_user`.
- Produces: `SweepStore.insert(user_id, rec) / list(user_id, limit=50, epic=None) / get(user_id, sweep_id) / delete(user_id, sweep_id)`; `WfoStore.insert(user_id, rec) / insert_sync(user_id, rec) / list(user_id, ...) / get(user_id, wfo_id) / get_fold_tables(user_id, wfo_id) / delete(user_id, wfo_id)`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_sweep_wfo_store_users.py` — same shape as Task 3's store test, for both stores:

```python
"""Sweep/WFO stores: per-user rows + caps + old-DB migration to 'dev'."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.sweep_store import SweepStore
from auto_trader.core.wfo_store import WfoStore


def _sweep(sid: str, ts: int) -> dict:
    return {"id": sid, "created_at": ts, "epic": "US100", "timeframe": "1h",
            "name": None, "axes": [], "rows": [], "windows": None}


def _wfo(wid: str, ts: int) -> dict:
    return {"id": wid, "created_at": ts, "epic": "US100", "timeframe": "1h",
            "name": None, "request": {}, "result": {}, "fold_tables": {}}


def test_sweeps_per_user_and_cap(tmp_path):
    store = SweepStore(str(tmp_path / "s.db"), cap=2)
    asyncio.run(store.insert("alice", _sweep("s1", 1)))
    asyncio.run(store.insert("bob", _sweep("s2", 2)))
    asyncio.run(store.insert("alice", _sweep("s3", 3)))
    asyncio.run(store.insert("alice", _sweep("s4", 4)))  # evicts s1 only
    assert [s["id"] for s in asyncio.run(store.list("alice"))] == ["s4", "s3"]
    assert [s["id"] for s in asyncio.run(store.list("bob"))] == ["s2"]
    assert asyncio.run(store.get("bob", "s3")) is None


def test_wfo_per_user_and_cross_user_reads(tmp_path):
    store = WfoStore(str(tmp_path / "w.db"), cap=2)
    store.insert_sync("alice", _wfo("w1", 1))
    store.insert_sync("bob", _wfo("w2", 2))
    assert [w["id"] for w in asyncio.run(store.list("alice"))] == ["w1"]
    assert asyncio.run(store.get("bob", "w1")) is None
    assert asyncio.run(store.get_fold_tables("bob", "w1")) is None


def test_sweep_migration_to_dev(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sweeps (id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, "
        "timeframe TEXT, name TEXT, axes_json TEXT, rows_json TEXT, windows_json TEXT)"
    )
    conn.execute(
        "INSERT INTO sweeps VALUES ('s1', 1, 'US100', '1h', NULL, '[]', '[]', 'null')"
    )
    conn.commit()
    conn.close()
    store = SweepStore(path)
    assert [s["id"] for s in asyncio.run(store.list("dev"))] == ["s1"]
    assert asyncio.run(store.list("alice")) == []
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_sweep_wfo_store_users.py -v` FAILs on signatures.

- [ ] **Step 3: Rework both stores** — mechanical, mirroring Task 3 exactly:

Both: `_connect` CREATE gains `user_id TEXT NOT NULL DEFAULT 'dev'` column + `CREATE INDEX IF NOT EXISTS idx_sweeps_user_created ON sweeps (user_id, created_at)` (resp. `idx_wfo_user_created` on `wfo`); `__init__` runs `run_migrations(conn, {1: _migrate_v1})` where `_migrate_v1` is the ALTER+INDEX pattern from Task 3 (table name adjusted); every method gains `user_id` first; every WHERE gains `user_id = ?`; both prunes become user-scoped, preserving the existing `rowid DESC` tiebreak:

```sql
DELETE FROM sweeps WHERE user_id = ? AND id NOT IN
  (SELECT id FROM sweeps WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
```

`WfoStore.insert_sync(user_id, rec)` keeps its public-sync contract (job threads call it); `insert(user_id, rec)` forwards.

- [ ] **Step 4: Wire the archive routes in `backtest.py`** — `save_sweep`, `list_sweeps`, `get_sweep`, `delete_sweep` (~695–725) and every `WFO_STORE.` call site: add `request: Request`, pass `current_user(request)` as first arg. IMPORTANT: one `WFO_STORE.insert_sync` call happens inside a job thread's on_complete callback (~line 957 region) where there is no request — capture `user = current_user(request)` in the submitting handler and close over it in the callback.

- [ ] **Step 5: Run new tests + full suite** — new file PASS; `uv run pytest -q` no new failures (fix direct SWEEP_STORE/WFO_STORE call sites in existing tests to pass `"dev"`, found via `grep -rn "SWEEP_STORE\.\|WFO_STORE\." tests/`).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/sweep_store.py backend/auto_trader/core/wfo_store.py backend/auto_trader/api/routers/backtest.py backend/tests/test_sweep_wfo_store_users.py
git commit -m "feat(archive): per-user sweep and WFO archives"
```

---

### Task 5: CostProfileStore per-user + costs routes

**Files:**
- Modify: `backend/auto_trader/core/cost_profiles.py`
- Modify: `backend/auto_trader/api/routers/costs.py` (routes at ~50–79)
- Test: `backend/tests/test_cost_profiles_users.py`

**Interfaces:**
- Consumes: `run_migrations`, `table_columns`, `current_user`.
- Produces: `CostProfileStore.get(user_id, epic)` / `upsert(user_id, epic, profile)`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_cost_profiles_users.py`:

```python
"""Cost profiles: per-user rows + composite-PK migration to 'dev'."""
from __future__ import annotations

import asyncio
import sqlite3

from auto_trader.core.cost_profiles import CostProfileStore


def test_profiles_are_per_user(tmp_path):
    store = CostProfileStore(str(tmp_path / "c.db"))
    asyncio.run(store.upsert("alice", "US100", {"spread": 1.5}))
    asyncio.run(store.upsert("bob", "US100", {"spread": 9.0}))
    assert asyncio.run(store.get("alice", "US100"))["spread"] == 1.5
    assert asyncio.run(store.get("bob", "US100"))["spread"] == 9.0
    assert asyncio.run(store.get("carol", "US100")) is None


def test_migrates_old_pk_to_composite(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE cost_profiles (epic TEXT PRIMARY KEY, "
        "spread REAL NOT NULL DEFAULT 0, "
        "slippage_json TEXT NOT NULL DEFAULT '{}', "
        "fin_long_daily_pct REAL NOT NULL DEFAULT 0, "
        "fin_short_daily_pct REAL NOT NULL DEFAULT 0, "
        "source TEXT NOT NULL DEFAULT 'manual', updated_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO cost_profiles (epic, spread, slippage_json, updated_at) "
        "VALUES ('US100', 2.0, '{\"kind\":\"fixed\",\"value\":0.0,\"atrMult\":0.0}', 1)"
    )
    conn.commit()
    conn.close()
    store = CostProfileStore(path)
    assert asyncio.run(store.get("dev", "US100"))["spread"] == 2.0
    assert asyncio.run(store.get("alice", "US100")) is None
    CostProfileStore(path)  # idempotent re-init
    assert asyncio.run(store.get("dev", "US100"))["spread"] == 2.0
```

- [ ] **Step 2: Run to verify failure** — signatures.

- [ ] **Step 3: Rework `cost_profiles.py`** — mirror Task 2's rebuild migration (composite PK):

- `_connect` CREATE uses the new shape: first two columns `user_id TEXT NOT NULL, epic TEXT NOT NULL,` … ending `PRIMARY KEY (user_id, epic))` (drop `epic TEXT PRIMARY KEY`).
- `_migrate_v1`: if `user_id` in `table_columns(conn, "cost_profiles")` return; else create `cost_profiles_new` with the new shape, `INSERT INTO cost_profiles_new SELECT 'dev', epic, spread, slippage_json, fin_long_daily_pct, fin_short_daily_pct, source, updated_at FROM cost_profiles`, drop, rename.
- `__init__` runs migrations as in Task 2.
- `get(user_id, epic)` / `upsert(user_id, epic, profile)` and their `_sync` twins: WHERE gains `user_id = ?`; upsert column list gains `user_id` and the conflict target becomes `ON CONFLICT(user_id, epic)`.

- [ ] **Step 4: Wire `routers/costs.py`** — all three routes (`get_profile`, `put_profile`, `refetch_profile`) add `request: Request`, compute `user = current_user(request)` once, pass it to every `COST_PROFILES.get/upsert` call (there are 8 call sites in the region shown at ~51–79).

- [ ] **Step 5: Run new tests + full suite** — PASS / no new failures (fix any direct COST_PROFILES test call sites to pass `"dev"`).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/cost_profiles.py backend/auto_trader/api/routers/costs.py backend/tests/test_cost_profiles_users.py
git commit -m "feat(costs): per-user cost profiles"
```

---

### Task 6: FairGate + owned sweep/WFO jobs

**Files:**
- Create: `backend/auto_trader/api/fair_gate.py`
- Modify: `backend/auto_trader/api/sweep_jobs.py` (SweepJob dataclass ~35, manager `__init__` ~57-64, the `self._gate.acquire()` call site in the worker thread — find with `grep -n "_gate" backend/auto_trader/api/sweep_jobs.py`)
- Modify: `backend/auto_trader/api/wfo_jobs.py` (same three touchpoints)
- Modify: `backend/auto_trader/api/routers/backtest.py` (sweep job routes ~790+, wfo job routes — find with `grep -n "JOBS\.\|WFO_JOBS\." backend/auto_trader/api/routers/backtest.py`)
- Test: `backend/tests/test_fair_gate.py`, plus owner-filter additions in `backend/tests/test_api_jobs_users.py`

**Interfaces:**
- Consumes: `current_user` (Task 2).
- Produces: `FairGate` with `acquire(owner: str) -> None` (blocking) and `release() -> None`; `SweepJob.owner: str = "dev"` and `WfoJob.owner: str = "dev"` dataclass fields; both managers' `submit(..., owner: str = "dev")`.

- [ ] **Step 1: Write the failing FairGate test**

`backend/tests/test_fair_gate.py`:

```python
"""FairGate: one holder at a time, round-robin across owners."""
from __future__ import annotations

import threading

from auto_trader.api.fair_gate import FairGate


def test_round_robin_across_owners():
    gate = FairGate()
    order: list[str] = []
    done: list[threading.Thread] = []
    release_first = threading.Event()

    def hold_first():
        gate.acquire("A")
        order.append("A1")
        release_first.wait(5)
        gate.release()

    def job(owner: str, label: str):
        gate.acquire(owner)
        order.append(label)
        gate.release()

    t0 = threading.Thread(target=hold_first)
    t0.start()
    while not order:  # A1 holds the gate
        pass
    # Queue while busy: A floods, then B arrives.
    for label in ("A2", "A3"):
        t = threading.Thread(target=job, args=("A", label)); t.start(); done.append(t)
    while len(gate._queues.get("A", ())) < 2:  # both A jobs queued
        pass
    tb = threading.Thread(target=job, args=("B", "B1")); tb.start(); done.append(tb)
    while "B" not in gate._queues:
        pass
    release_first.set()
    t0.join(5)
    for t in done:
        t.join(5)
    assert order == ["A1", "B1", "A2", "A3"]


def test_single_owner_fifo():
    gate = FairGate()
    gate.acquire("A")
    gate.release()
    gate.acquire("A")  # gate reusable after full drain
    gate.release()
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `api/fair_gate.py`**

```python
"""One-at-a-time gate with per-owner round-robin queuing.

Replaces the bare Semaphore(1) in the sweep/WFO job managers: still exactly
one heavy job computing at a time (CPU protection), but waiting jobs are
served round-robin across owners, so one user queueing many jobs cannot
starve another user's first. Within an owner, FIFO. Thread-safe; owners are
opaque strings (user ids)."""

from __future__ import annotations

import threading
from collections import OrderedDict, deque


class FairGate:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # owner -> FIFO of waiter events, in owner-arrival order.
        self._queues: "OrderedDict[str, deque[threading.Event]]" = OrderedDict()
        self._busy = False
        self._last_owner: str | None = None

    def acquire(self, owner: str) -> None:
        with self._lock:
            if not self._busy:
                self._busy = True
                self._last_owner = owner
                return
            event = threading.Event()
            self._queues.setdefault(owner, deque()).append(event)
        event.wait()

    def release(self) -> None:
        with self._lock:
            if not self._queues:
                self._busy = False
                self._last_owner = None
                return
            owners = list(self._queues)
            # The owner who just ran goes to the back of the rotation: serve the
            # next owner after them in arrival order (cyclic); if they are the
            # only owner queued, they run again.
            if self._last_owner in owners and len(owners) > 1:
                nxt = owners[(owners.index(self._last_owner) + 1) % len(owners)]
            elif self._last_owner in owners:
                nxt = self._last_owner
            else:
                nxt = owners[0]
            queue = self._queues[nxt]
            event = queue.popleft()
            if not queue:
                del self._queues[nxt]
            self._last_owner = nxt
            # _busy stays True: ownership transfers directly to the waiter.
            event.set()
```

- [ ] **Step 4: Run FairGate tests** — PASS.

- [ ] **Step 5: Wire the managers and routes**

- `sweep_jobs.py`: `SweepJob` gains field `owner: str = "dev"` (with the other defaulted fields). Manager `__init__`: replace `self._gate = threading.Semaphore(1)` with `from auto_trader.api.fair_gate import FairGate` (module top) and `self._gate = FairGate()`. The worker-thread `self._gate.acquire()` call becomes `self._gate.acquire(job.owner)` (release call unchanged — FairGate.release matches). `submit(...)` gains keyword `owner: str = "dev"` and sets it on the job.
- `wfo_jobs.py`: identical three changes for `WfoJob` / `WfoJobManager`.
- `routers/backtest.py` job routes: submitting handlers (`submit_sweep_job`, and the WFO submit — find via grep) add `request: Request`, pass `owner=current_user(request)` into `.submit(...)`; every job status/rows/cancel/list route adds `request: Request` and filters: single-job routes 404 when `job.owner != current_user(request)` (same response as unknown id); list routes return only the caller's jobs. Find every route touching `JOBS.` / `WFO_JOBS.` and cover ALL of them — a missed route is a cross-tenant leak.
- Check DTOs: if `SweepJobInfoDTO`/WFO DTOs are built via dataclass `asdict`, ensure `owner` is not leaked into API payloads unintentionally — if the DTO is explicit pydantic fields (it is), nothing to do.

- [ ] **Step 6: Write the failing route tests**

`backend/tests/test_api_jobs_users.py`:

```python
"""Cross-user job access returns 404; listings are owner-filtered."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.sweep_jobs import JOBS, SweepJob
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


@pytest.fixture
def alice_job(monkeypatch):
    job = SweepJob(job_id="j-alice", epic="US100", timeframe="1h", total=1,
                   owner="alice", running=False)
    job.finished_at = 0.0
    import time
    job.finished_at = time.time()
    monkeypatch.setitem(JOBS._jobs, "j-alice", job)
    return job


def test_job_status_is_owner_scoped(clerk, alice_job):
    ok = client.get("/api/backtest/sweep/jobs/j-alice", headers=_auth("alice"))
    assert ok.status_code == 200
    assert client.get("/api/backtest/sweep/jobs/j-alice", headers=_auth("bob")).status_code == 404


def test_job_listing_filtered(clerk, alice_job):
    mine = client.get("/api/backtest/sweep/jobs", headers=_auth("alice")).json()
    assert any(j["job_id"] == "j-alice" or j.get("jobId") == "j-alice" for j in mine)
    others = client.get("/api/backtest/sweep/jobs", headers=_auth("bob")).json()
    assert all(j.get("job_id") != "j-alice" and j.get("jobId") != "j-alice" for j in others)
```

(Adapt the exact status-route path and DTO field names to the real routes — read them; the requirement is the behavior, and the test must assert on the actual field names.)

- [ ] **Step 7: Run new tests + full suite** — PASS / no new failures (existing sweep_jobs tests construct managers directly; the FairGate swap keeps `.acquire`/`.release` shape except the owner arg — fix internal callers only, the manager's public API besides `submit(owner=...)` is unchanged).

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/api/fair_gate.py backend/auto_trader/api/sweep_jobs.py backend/auto_trader/api/wfo_jobs.py backend/auto_trader/api/routers/backtest.py backend/tests/test_fair_gate.py backend/tests/test_api_jobs_users.py
git commit -m "feat(jobs): owner-scoped sweep/WFO jobs with per-user round-robin gate"
```

---

### Task 7: Frontend — hosted-mode fresh-account hydrate

**Files:**
- Modify: `frontend/src/lib/persist/core.ts` (the `keys.length === 0` branch of `hydrateFromBackend`, ~line 438)
- Test: `frontend/src/lib/persist/core.hosted.test.ts`

**Interfaces:**
- Consumes: `CLERK_ENABLED` from `frontend/src/lib/authToken.ts` (existing). Note `CLERK_ENABLED` is a const evaluated at module load from `import.meta.env` — tests must mock the `../authToken` module rather than set env.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/persist/core.hosted.test.ts`:

```typescript
// @vitest-environment jsdom
//
// Hosted mode, empty backend snapshot = a FRESH ACCOUNT: the hydrate must NOT
// seed the backend from this browser's localStorage (that would leak another
// account's workspace on a shared machine) — it clears the mirrored keys
// instead, keeping device-local ones.
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../authToken", () => ({
  CLERK_ENABLED: true,
  getAuthToken: async () => null,
  setTokenGetter: () => {},
}));

import { hydrateFromBackend } from "./core";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("clears mirrored keys instead of seeding when backend is empty in hosted mode", async () => {
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.activeLayoutId", '"x"'); // device-local: kept
  localStorage.setItem("unrelated.key", "1");
  const puts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") puts.push(String(url));
    return new Response("{}", { status: 200 });
  }));
  await hydrateFromBackend();
  expect(puts).toEqual([]); // no seeding
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.activeLayoutId")).toBe('"x"');
  expect(localStorage.getItem("unrelated.key")).toBe("1");
});
```

(If `activeLayoutId`'s real device-local key differs — check `DEVICE_LOCAL_SUFFIXES`/`DEVICE_LOCAL_FLAT_KEYS` at core.ts:125-155 — use an actual device-local key from that list.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/persist/core.hosted.test.ts`
Expected: FAIL — seeding PUTs happen and/or keys not cleared.

- [ ] **Step 3: Implement**

In `core.ts`, add `import { CLERK_ENABLED } from "../authToken";` (check the relative path — core.ts sits in `lib/persist/`, authToken in `lib/`, so `../authToken`). Replace the empty-snapshot branch:

```typescript
  const keys = Object.keys(snapshot);
  if (keys.length === 0) {
    if (!CLERK_ENABLED) {
      // Dev mode: empty backend means a fresh mirror DB — seed it from this
      // browser so we don't start by wiping the user.
      seedBackendFromLocal();
      return false;
    }
    // Hosted mode: an empty snapshot is a FRESH ACCOUNT. The backend is the
    // source of truth; seeding from localStorage would leak whatever account
    // used this browser last. Clear the mirrored keys (keep device-local).
    let changed = false;
    const own = `${PREFIX}.`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(own) || isDeviceLocalKey(k)) continue;
      localStorage.removeItem(k);
      changed = true;
    }
    return changed;
  }
```

- [ ] **Step 4: Run test + type-check + full suite**

Run: `cd frontend && npx vitest run src/lib/persist/core.hosted.test.ts && npx tsc -b && npm run test:unit`
Expected: new test PASS; no new type errors vs the ~20 pre-existing baseline; full suite green (dev-mode tests unaffected because `CLERK_ENABLED` is false there).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/core.ts frontend/src/lib/persist/core.hosted.test.ts
git commit -m "feat(persist): fresh-account hydrate in hosted mode (no cross-account seeding)"
```
