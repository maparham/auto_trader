# Backend Alert Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move alert evaluation from the browser to a backend engine that covers ALL of a user's alerts (any broker/epic, open in a tab or not) and delivers via open tabs, Web Push, and Telegram.

**Architecture:** First-class alert storage (`alerts.db` + `/api/alerts` CRUD) replaces the localStorage blobs. One global engine task in the FastAPI process keeps every alert in memory, opens one price feed per distinct (broker, epic), evaluates ticks with a Python port of `alertEval.ts`, and fires: triggered history → `/ws/state` broadcast to open tabs → Web Push → Telegram. The frontend keeps its synchronous alert-read API backed by an in-memory cache hydrated from the backend.

**Tech Stack:** FastAPI, stdlib sqlite3, httpx (Telegram), pywebpush (Web Push), React/TS frontend, pytest + vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-backend-alert-engine-design.md`

## Global Constraints

- Python: stdlib sqlite3 stores (fresh connection per op, `asyncio.to_thread` for I/O), `run_migrations` from `auto_trader.core.db_migrate` — mirror `core/state_store.py` exactly.
- Alert ids are **client-generated** `al-<uuid>` (plan refinement vs the spec's "server assigns id": client ids preserve the frontend's optimistic-write call sites; the server validates the format `^al-[A-Za-z0-9-]{1,64}$` and rejects duplicates).
- Alert `params` for kind `price_level`: `{level: float, condition: crossing|crossing_up|crossing_down|greater|less, trigger: once|every}`.
- `notify` JSON: `{toast, browser, sound, push, telegram}`, all default `true`.
- Alert rows carry `precision INTEGER DEFAULT 2` (price decimals for message formatting; the frontend knows it at creation).
- Alert events ride the existing `/ws/state` socket using the `__trades__:` precedent: messages `{key: "__alerts__:changed", value: {...}, origin}` and `{key: "__alerts__:fired", value: {...}}`.
- Never `git push`. Commit to the current branch (`main`).
- Backend tests: `cd backend && python3 -m pytest tests/<file> -q`. Frontend tests: `cd frontend && npx vitest run src/<file>`.
- Import direction: `core/` must not import from `api/`. The engine gets `get_broker` and `broadcast` callables injected at startup.
- RE_ARM_FRACTION = 5e-4; re-arm margin floor 1e-10 (exact values from `alertEval.ts`).

---

### Task 1: Python evaluator port (`evaluate_alert`)

**Files:**
- Create: `backend/auto_trader/core/alert_eval.py`
- Test: `backend/tests/test_alert_eval.py`

**Interfaces:**
- Produces: `evaluate_alert(prev: float | None, price: float, level: float, condition: str, trigger: str, armed: bool) -> EvalResult` where `EvalResult` is a frozen dataclass with `fired: bool, next_armed: bool, remove: bool`. Also `RE_ARM_FRACTION = 5e-4`.

This is a direct port of `frontend/src/lib/alertEval.ts` (read it first — the comments explain every branch). Semantics that MUST survive: crossings need two samples (prev None → nothing fires); `greater`/`less` are level checks that may fire with prev None; `once` fires → `remove=True`; `every` disarms on fire and re-arms only past the hysteresis margin (`max(abs(level)*RE_ARM_FRACTION, 1e-10)`), and for `greater`/`less` only when the condition is false again beyond the margin; non-finite price/level → unchanged.

- [ ] **Step 1: Write the failing tests**

```python
"""Port of frontend/src/lib/alertEval.test.ts — pins the Python evaluator to the TS semantics."""
import math

from auto_trader.core.alert_eval import EvalResult, evaluate_alert


def ev(prev, price, level, condition="crossing", trigger="every", armed=True):
    return evaluate_alert(prev, price, level, condition, trigger, armed)


def test_first_tick_never_fires_crossing():
    assert ev(None, 101, 100).fired is False

def test_crossing_up_fires():
    r = ev(99, 101, 100, "crossing")
    assert r.fired and r.next_armed is False and r.remove is False

def test_crossing_down_fires():
    assert ev(101, 99, 100, "crossing").fired

def test_crossing_up_only():
    assert ev(99, 101, 100, "crossing_up").fired
    assert not ev(101, 99, 100, "crossing_up").fired

def test_crossing_down_only():
    assert ev(101, 99, 100, "crossing_down").fired
    assert not ev(99, 101, 100, "crossing_down").fired

def test_touch_without_cross_does_not_fire():
    # prev <= level and price == level is not "price > level"
    assert not ev(99, 100, 100, "crossing").fired

def test_greater_fires_immediately_even_with_none_prev():
    r = ev(None, 101, 100, "greater")
    assert r.fired

def test_less_fires_immediately_even_with_none_prev():
    assert ev(None, 99, 100, "less").fired

def test_greater_not_satisfied():
    assert not ev(None, 99, 100, "greater").fired

def test_once_fire_requests_removal():
    r = ev(99, 101, 100, "crossing", "once")
    assert r.fired and r.remove and r.next_armed is False

def test_disarmed_does_not_fire():
    assert not ev(99, 101, 100, "crossing", "every", armed=False).fired

def test_every_rearm_after_clearing_level():
    # level 100, margin = 100*5e-4 = 0.05; price must clear by > margin
    r = ev(100.0, 100.02, 100, "crossing", "every", armed=False)
    assert r.next_armed is False  # within margin: stays disarmed
    r = ev(100.02, 100.06, 100, "crossing", "every", armed=False)
    assert r.next_armed is True   # cleared the margin

def test_greater_rearm_only_when_condition_false_again():
    # satisfied "greater" must NOT re-arm while price is above the level
    r = ev(101, 102, 100, "greater", "every", armed=False)
    assert r.next_armed is False
    r = ev(102, 99.9, 100, "greater", "every", armed=False)
    assert r.next_armed is True   # below level - margin (99.95)

def test_less_rearm_above_level_plus_margin():
    r = ev(99, 100.06, 100, "less", "every", armed=False)
    assert r.next_armed is True

def test_zero_level_has_margin_floor():
    # abs(0)*frac == 0 → floor 1e-10 keeps hysteresis
    r = ev(0.0, 0.0, 0.0, "crossing", "every", armed=False)
    assert r.next_armed is False

def test_nonfinite_inputs_unchanged():
    r = evaluate_alert(99, math.nan, 100, "crossing", "every", True)
    assert r == EvalResult(False, True, False)
    r = evaluate_alert(99, 101, math.inf, "crossing", "every", True)
    assert r == EvalResult(False, True, False)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alert_eval.py -q`
Expected: FAIL — `ModuleNotFoundError: auto_trader.core.alert_eval`

- [ ] **Step 3: Implement the evaluator**

```python
"""Pure price-alert evaluation — Python port of frontend/src/lib/alertEval.ts.

The crossing / once / every / re-arm logic with no storage or feed dependency.
The TS file remains the reference; its test suite is ported to
tests/test_alert_eval.py so the two implementations cannot drift while both
exist (the TS one is deleted at the end of this project).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# 5 bps: how far price must clear the level before an "every" alert re-arms.
RE_ARM_FRACTION = 5e-4


@dataclass(frozen=True)
class EvalResult:
    fired: bool
    next_armed: bool
    remove: bool


def evaluate_alert(
    prev: float | None,
    price: float,
    level: float,
    condition: str,
    trigger: str,
    armed: bool,
) -> EvalResult:
    """Evaluate one alert against a price tick. `prev` is the previous sample
    (None on the very first tick — crossings need two samples)."""
    unchanged = EvalResult(False, armed, False)
    if not (math.isfinite(price) and math.isfinite(level)):
        return unchanged

    # Level checks (greater/less) are satisfied by the current price alone, so
    # they may fire immediately — including when prev is None. Crossings wait.
    is_level_check = condition in ("greater", "less")
    if prev is None and not is_level_check:
        return unchanged

    cross_up = prev is not None and prev <= level < price
    cross_down = prev is not None and prev >= level > price
    if condition == "crossing":
        hit = cross_up or cross_down
    elif condition == "crossing_up":
        hit = cross_up
    elif condition == "crossing_down":
        hit = cross_down
    elif condition == "greater":
        hit = price > level
    elif condition == "less":
        hit = price < level
    else:
        return unchanged

    if hit and armed:
        if trigger == "once":
            return EvalResult(True, False, True)
        return EvalResult(True, False, False)  # disarm until cleared

    # Re-arm an "every" alert once price has cleared the level by the margin
    # (level checks re-arm only when the condition is FALSE again past it).
    if not armed and trigger == "every":
        margin = max(abs(level) * RE_ARM_FRACTION, 1e-10)
        if condition == "greater":
            can_re_arm = price < level - margin
        elif condition == "less":
            can_re_arm = price > level + margin
        else:
            can_re_arm = abs(price - level) > margin
        if can_re_arm:
            return EvalResult(False, True, False)
    return unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_alert_eval.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_eval.py backend/tests/test_alert_eval.py
git commit -m "feat(alerts): python port of the pure alert evaluator"
```

---

### Task 2: AlertStore (`alerts.db`)

**Files:**
- Create: `backend/auto_trader/core/alert_store.py`
- Test: `backend/tests/test_alert_store.py`

**Interfaces:**
- Produces: module singleton `ALERT_STORE: AlertStore`. All methods are `async` (sqlite work via `asyncio.to_thread`), except noted. Alert rows travel as plain dicts:
  `{"id", "broker", "epic", "kind", "params" (dict), "message", "expires_at" (int|None), "notify" (dict), "precision" (int), "active" (int), "created_at", "updated_at"}`.
  - `async list_user(user_id) -> list[dict]`
  - `async list_all() -> list[tuple[str, dict]]` — `(user_id, row)` for every user (engine startup)
  - `async create(user_id, row: dict) -> dict` — raises `ValueError` on duplicate id
  - `async update(user_id, alert_id, patch: dict) -> dict | None` — shallow merge of `params`/`message`/`expires_at`/`notify`/`precision`/`active`; bumps `updated_at`
  - `async delete(user_id, alert_id) -> bool`
  - `async add_triggered(user_id, entry: dict) -> None` — entry `{"time","alert_id","broker","epic","kind","price","level","condition","message","precision"}`; prunes to newest 500 per user
  - `async list_triggered(user_id) -> list[dict]` (newest first)
  - `async clear_triggered(user_id) -> None`
  - `async get_meta(user_id, key) -> str | None` / `async set_meta(user_id, key, value: str) -> None` (triggered-seen watermark, VAPID keys under user_id `""`)
  - `async add_push_sub(user_id, endpoint, keys: dict) -> None` / `async delete_push_sub(user_id, endpoint) -> None` / `async list_push_subs(user_id) -> list[dict]`
  - `async set_telegram(user_id, chat_id: str) -> None` / `async get_telegram(user_id) -> str | None` / `async delete_telegram(user_id) -> None`

Mirror `core/state_store.py`'s structure: module docstring, `_SCHEMA` executescript, `run_migrations(conn, "alert_store", [])`, `_connect()` with `check_same_thread=False` NOT needed (fresh connection per op), sync `_*_sync` methods wrapped by `asyncio.to_thread`, and at module bottom construct the singleton the same way `STATE_STORE` is constructed there (same settings/path pattern, db file `alerts.db`). Read `state_store.py` lines 54–130 before writing.

Schema (one executescript):

```sql
CREATE TABLE IF NOT EXISTS alerts (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  broker TEXT NOT NULL, epic TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'price_level',
  params TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  notify TEXT NOT NULL DEFAULT '{}',
  precision INTEGER NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
CREATE INDEX IF NOT EXISTS idx_alerts_feed ON alerts (broker, epic);
CREATE TABLE IF NOT EXISTS triggered (
  user_id TEXT NOT NULL, time INTEGER NOT NULL, alert_id TEXT NOT NULL,
  broker TEXT NOT NULL, epic TEXT NOT NULL, kind TEXT NOT NULL,
  price REAL NOT NULL, level REAL NOT NULL, condition TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '', precision INTEGER NOT NULL DEFAULT 2);
CREATE INDEX IF NOT EXISTS idx_triggered_user ON triggered (user_id, time);
CREATE TABLE IF NOT EXISTS alert_meta (
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT NOT NULL, endpoint TEXT NOT NULL PRIMARY KEY,
  keys TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id TEXT NOT NULL PRIMARY KEY, chat_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL);
```

`params` and `notify` are stored as JSON strings, parsed at the read boundary so callers only see dicts. `notify` read applies defaults: `{ch: stored.get(ch, True) for ch in ("toast","browser","sound","push","telegram")}`.

- [ ] **Step 1: Write the failing tests** — construct `AlertStore(str(tmp_path / "alerts.db"))` directly (not the singleton). Cover: create → list_user round-trips params/notify as dicts with channel defaults applied; duplicate create raises ValueError; update merges patch + bumps updated_at and returns the merged row; update/delete of unknown id → None/False; list_all returns (user_id, row) across two users; add_triggered + list_triggered newest-first + prune (insert 502, expect 500); clear_triggered; meta set/get and overwrite; push sub add/list/delete (add same endpoint twice → one row, keys updated); telegram set/get/delete. Use `asyncio.run` or pytest-asyncio-free pattern matching existing store tests — read `backend/tests/` for the prevailing async-test idiom first and copy it.

- [ ] **Step 2: Run tests to verify they fail** — `cd backend && python3 -m pytest tests/test_alert_store.py -q` → import error.

- [ ] **Step 3: Implement `alert_store.py`** per the interface above.

- [ ] **Step 4: Run tests** — expected: all PASS. Also run `python3 -m pytest tests -q -x` to catch collateral damage.

- [ ] **Step 5: Commit** — `git add backend/auto_trader/core/alert_store.py backend/tests/test_alert_store.py && git commit -m "feat(alerts): alert store — first-class sqlite home for alerts, history, push subs, telegram links"`

---

### Task 3: Alert engine core (registry + tick evaluation + firing pipeline)

**Files:**
- Create: `backend/auto_trader/core/alert_engine.py`
- Test: `backend/tests/test_alert_engine.py`

**Interfaces:**
- Consumes: `evaluate_alert`/`EvalResult` (Task 1), `AlertStore` (Task 2).
- Produces: singleton `ALERT_ENGINE: AlertEngine` with:
  - `configure(store: AlertStore, get_broker: Callable[[str], Any], broadcast: Callable[[str, dict], Awaitable[None]], notifiers: list[Callable[[str, dict], Awaitable[None]]] = [])` — injected seams; `broadcast(user_id, message)` sends one `/ws/state` message; each notifier gets `(user_id, fired_payload)` (Web Push and Telegram register here in later tasks).
  - `async start()` / `async stop()` — start loads the registry via `store.list_all()` and opens feeds; stop cancels everything.
  - `on_alert_changed(user_id, row: dict | None, alert_id: str)` — router calls after every write (`row=None` means deleted). Synchronous; schedules feed reconciliation.
  - `async on_tick(broker: str, epic: str, mid: float, bid: float | None, ask: float | None)` — the evaluation entry point (feed drivers from Task 4 call this; tests call it directly).
  - `feeds_needed() -> set[tuple[str, str]]` — distinct (broker, epic) with ≥1 active alert (Task 4 uses it).
  - `price_side_for(user_id) -> str` — reads the user's mirrored `priceSide` setting from `STATE_STORE` with a 30 s TTL cache; default `"mid"`. (Find the exact state key by grepping the frontend for where `priceSide` is persisted — it lives in the mirrored settings JSON; parse defensively, fall back to `"mid"`.)

Behavioral requirements (all pinned by tests):

1. **Registry:** in-memory `dict[(broker, epic) -> list[(user_id, row)]]`, built from `list_all()` at start, mutated by `on_alert_changed`.
2. **Per-alert state** keyed `(user_id, alert_id)`: `armed` (default True), `baseline` (prev price, default None), `sig` (last `f"{level}|{condition}|{trigger}"`). A changed sig on a known key resets baseline to None and re-arms — port of `alertEngine.ts`'s move detection. First sighting is NOT a move.
3. **on_tick:** for each alert on that (broker, epic): skip `active == 0`; if `expires_at` passed → delete row via store, `forget` state, broadcast `changed`, no fire. Pick the eval price by `price_side_for(user_id)` (`bid`/`ask` if present else mid). Advance baseline every tick (read prev before overwriting). Call `evaluate_alert`; on `fired` run the firing pipeline; on `remove` delete via store + broadcast `changed` + forget.
4. **Firing pipeline** (`async _fire(user_id, row, price)`): (a) `store.add_triggered(...)` always; (b) `broadcast(user_id, {"key": "__alerts__:fired", "value": {"id", "broker", "epic", "kind", "price", "level", "condition", "message", "precision", "notify"}})`; (c) for each registered notifier: `await notifier(user_id, payload)` inside `try/except Exception: log.warning(...)` — a notifier failure never breaks evaluation.
5. **Expiry sweep:** `async _expiry_loop()` every 30 s prunes expired alerts (store delete + `changed` broadcast + forget) — started by `start()`.
6. `changed` broadcasts carry `{"key": "__alerts__:changed", "value": {"broker": ..., "epic": ..., "origin": "engine"}}`.

- [ ] **Step 1: Write the failing tests.** Use a real `AlertStore(tmp_path)` and record broadcasts/notifications into lists:

```python
import asyncio

from auto_trader.core.alert_engine import AlertEngine
from auto_trader.core.alert_store import AlertStore


def make_engine(tmp_path):
    store = AlertStore(str(tmp_path / "alerts.db"))
    sent: list[tuple[str, dict]] = []
    notified: list[tuple[str, dict]] = []

    async def broadcast(uid, msg):
        sent.append((uid, msg))

    async def notify(uid, payload):
        notified.append((uid, payload))

    eng = AlertEngine()
    eng.configure(store=store, get_broker=lambda b: None, broadcast=broadcast, notifiers=[notify])
    return eng, store, sent, notified


def row(id="al-1", level=100.0, condition="crossing", trigger="every", **kw):
    return {
        "id": id, "broker": "capital", "epic": "US100", "kind": "price_level",
        "params": {"level": level, "condition": condition, "trigger": trigger},
        "message": "", "expires_at": None,
        "notify": {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True},
        "precision": 2, "active": 1, **kw,
    }


def test_crossing_fires_and_records(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row())
        eng.on_alert_changed("u1", created, "al-1")
        await eng.on_tick("capital", "US100", 99.0, None, None)   # seeds baseline
        await eng.on_tick("capital", "US100", 101.0, None, None)  # crosses
        fired = [m for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1 and fired[0]["value"]["price"] == 101.0
        assert len(notified) == 1
        assert len(await store.list_triggered("u1")) == 1
    asyncio.run(main())
```

Further tests (same harness): first tick alone never fires a crossing; `once` fire deletes the row from the store and broadcasts `changed`; editing the level via `on_alert_changed` (same id, new params) resets the baseline so the next single tick can't fire a crossing; disarm/re-arm across a fire → margin-clear → refire for `every`; two users with alerts on the same (broker, epic) both fire from one tick; a user's `priceSide` setting is honored when bid/ask are present (monkeypatch `price_side_for` to return "bid"); expired alert is pruned without firing on tick; `feeds_needed()` reflects adds and deletes; a raising notifier doesn't prevent the triggered row / broadcast; `on_alert_changed` with `row=None` removes the alert from the registry.

- [ ] **Step 2: Run to verify failure** — `cd backend && python3 -m pytest tests/test_alert_engine.py -q` → import error.

- [ ] **Step 3: Implement `AlertEngine`** per the requirements. Keep it a plain class + `ALERT_ENGINE = AlertEngine()` singleton at the bottom. `on_alert_changed` mutates the registry dict synchronously (all callers are on the event loop) and pokes an `asyncio.Event` that Task 4's feed reconciler waits on. `start()` = load registry + spawn `_expiry_loop`; feed spawning arrives in Task 4 — keep `start()`'s feed hook a no-op method `_reconcile_feeds()` for now so Task 4 fills it in.

- [ ] **Step 4: Run tests** — all PASS; run the full suite `python3 -m pytest tests -q -x`.

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): backend alert engine — registry, tick evaluation, firing pipeline, expiry sweep"` (add both files).

---

### Task 4: Price feeds (streaming + polling) and lifespan wiring

**Files:**
- Modify: `backend/auto_trader/core/alert_engine.py`
- Modify: `backend/auto_trader/api/app.py` (lifespan)
- Modify: `backend/auto_trader/api/routers/state.py` (export a public broadcast alias)
- Test: `backend/tests/test_alert_engine_feeds.py`

**Interfaces:**
- Consumes: `ALERT_ENGINE.configure/start/stop`, `feeds_needed()`, `on_tick` (Task 3); `deps.get_data(broker_id)`; `stream_candles` generators (`capital_stream`, `ig_stream`, `mt5_stream`), `broker.supports_streaming`, `broker.get_quote(epic)`.
- Produces: running engine in the app; `state.broadcast_to_user = _broadcast_state` public alias.

Implementation notes:

1. In `state.py` add at module level (after `_broadcast_state`): `broadcast_to_user = _broadcast_state  # public seam for the alert engine (injected in lifespan)`.
2. In `alert_engine.py`, implement `_reconcile_feeds()`: diff `feeds_needed()` against running feed tasks (`dict[(broker, epic) -> asyncio.Task]`); spawn missing, cancel unneeded. A `_feed_loop(broker_id, epic)` task:
   - resolves the broker via the injected `get_broker(broker_id)`; on failure, sleep 60 s and retry (broker may not be configured yet);
   - if `broker.supports_streaming`: pick the generator like `api/routers/stream.py` does for native resolutions (read its dispatch around lines 155–190): Capital → `capital_stream.stream_candles(broker, epic, Resolution.MINUTE, "mid")`, IG → `ig_stream.stream_candles(...)` (only if `ig_stream.streamable(60)`), MT5 → `mt5_stream.stream_candles(...)`. Import the modules lazily inside the function (they pull heavy deps). Iterate LiveBars: `await self.on_tick(broker_id, epic, bar.candle.close, bar.bid, bar.ask)`.
   - else (or if the stream keeps failing): poll `bid, ask = await broker.get_quote(epic)` every 5 s; mid = `(bid + ask) / 2` when both present, else whichever is present; skip the tick when both are None.
   - wrap the whole body in `while True: try: ... except asyncio.CancelledError: raise; except Exception: log.warning(...); await asyncio.sleep(backoff)` with backoff 5 → 60 s doubling, reset on success. A feed error never escapes the task.
3. A `_reconciler_loop()` awaits the change `asyncio.Event` (set by `on_alert_changed`/`start`), clears it, calls `_reconcile_feeds()`.
4. Lifespan wiring in `app.py` (after `deps._registry = build_registry()`):

```python
from auto_trader.core.alert_engine import ALERT_ENGINE
from auto_trader.core.alert_store import ALERT_STORE
from .routers import state as state_router

ALERT_ENGINE.configure(
    store=ALERT_STORE,
    get_broker=deps.get_data,
    broadcast=state_router.broadcast_to_user,
    notifiers=[],  # push/telegram register in later tasks
)
await ALERT_ENGINE.start()
```

and in the `finally` block: `await ALERT_ENGINE.stop()` (before the registry close). `stop()` cancels + awaits the expiry loop, reconciler, and all feed tasks.

- [ ] **Step 1: Write failing tests** for the pure parts (no real brokers): a fake broker object with `supports_streaming=False` and a scripted `get_quote` → assert the polling loop calls `on_tick` with the mid and stops when the feed task is cancelled (run the loop with a short poll interval — make the 5 s a module constant `POLL_INTERVAL` and monkeypatch it to 0.01); `_reconcile_feeds` spawns a task per needed pair and cancels one whose alerts were deleted; a `get_quote` that raises keeps the task alive (backoff path — monkeypatch backoff constants small).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** feeds + reconciler + lifespan + the `state.py` alias.

- [ ] **Step 4: Run tests + full backend suite.** Also boot check: `cd backend && python3 -c "from auto_trader.api.app import app"` — imports must not cycle (core never imports api; the engine only sees injected callables).

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): engine price feeds — streaming with polling fallback, lifespan wiring"`.

---

### Task 5: `/api/alerts` CRUD + triggered-history endpoints

**Files:**
- Create: `backend/auto_trader/api/routers/alerts.py`
- Modify: `backend/auto_trader/api/app.py` (add `alerts` to the `include_router` tuple)
- Test: `backend/tests/test_alerts_api.py`

**Interfaces:**
- Consumes: `ALERT_STORE`, `ALERT_ENGINE.on_alert_changed`, `state._broadcast_state`, `current_user` (`api/deps.py`), pydantic models.
- Produces (all per-user, JSON):
  - `GET /api/alerts` → `{"alerts": [row, ...]}` (row includes `id`)
  - `POST /api/alerts` body `{id, broker, epic, kind, params, message?, expires_at?, notify?, precision?}` → 200 row; 409 on duplicate id; 422 on bad id format / unknown kind / bad params (validate `price_level` params: finite `level`, condition in the 5-value set, trigger in `{once, every}`)
  - `PATCH /api/alerts/{id}` body `{params?, message?, expires_at?, notify?, precision?}` → row or 404
  - `DELETE /api/alerts/{id}` → 204 or 404
  - `GET /api/alerts/triggered` → `{"entries": [...], "seen": int}` (seen from meta key `triggered_seen`, default 0)
  - `POST /api/alerts/triggered/seen` body `{time: int}` → 204
  - `DELETE /api/alerts/triggered` → 204

Every successful mutation must: call `ALERT_ENGINE.on_alert_changed(user, row_or_None, alert_id)` and `await _broadcast_state(user, {"key": "__alerts__:changed", "value": {"broker": ..., "epic": ..., "origin": origin}})` where `origin` comes from a `?origin=` query param (the writing tab ignores its own echo, same convention as `/api/state`).

- [ ] **Step 1: Write failing tests** with FastAPI's `TestClient` — read an existing router test in `backend/tests/` first and copy its app/client/auth fixture pattern exactly (auth stubbing especially). Cover: create → get round-trip with notify defaults; duplicate id → 409; bad condition → 422; patch level → row reflects it and `on_alert_changed` was called (monkeypatch `ALERT_ENGINE.on_alert_changed` with a recorder); delete → 204 then 404; triggered seen watermark round-trip; user isolation (user A's alerts invisible to user B — drive `current_user` via the fixture's mechanism).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the router** + register it in `app.py`'s tuple.

- [ ] **Step 4: Run tests + full suite.**

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): /api/alerts CRUD + triggered history endpoints"`.

---

### Task 6: Legacy migration (localStorage blobs → alerts.db)

**Files:**
- Create: `backend/auto_trader/core/alert_migrate.py`
- Modify: `backend/auto_trader/api/app.py` (call before `ALERT_ENGINE.start()`)
- Test: `backend/tests/test_alert_migrate.py`

**Interfaces:**
- Consumes: `STATE_STORE.get_all(user_id)` — but there is no "list users" API on StateStore, so add one: `async list_users() -> list[str]` (`SELECT DISTINCT user_id FROM app_state`) in `core/state_store.py`.
- Produces: `async migrate_legacy_alerts(state_store, alert_store) -> int` (count imported).

Rules: for every user, scan keys matching `^auto-trader\.b\.([^.]+)\.alerts\.(.+)$` (broker, epic). Parse the JSON list; for each entry apply the defaults from `frontend/src/lib/persist/alerts.ts::normalizeAlert` (condition default `crossing`, trigger `every`, message `""`, expiresAt None, notify all-True; a row without an `id` gets a fresh `al-<uuid4>`), and `create()` it with `params={"level","condition","trigger"}`, `precision=2`, notify gaining `push: True, telegram: True`. Skip (don't raise) on unparseable blobs or duplicate ids. After a user's keys import cleanly, `await state_store.delete(user, key)` for each migrated key. Also migrate the old triggered log if present under a key containing `alerts.triggered` (grep `frontend/src/lib/persist/alerts.ts` for the exact triggered/seen key names via `loadTriggered`/`saveTriggeredSeen` before writing this — use the real key strings, then delete them too).

- [ ] **Step 1: Write failing tests** — seed a `StateStore(tmp)` with two alert keys (one with legacy rows missing ids, one corrupt JSON string) + a triggered-log key; run migration; assert imported rows (with defaults + minted ids), corrupt key skipped but left deleted? No: corrupt keys are LEFT IN PLACE (never delete what we didn't import). Assert migrated keys deleted, corrupt key still present, second run is a no-op (returns 0).

- [ ] **Step 2–4: fail → implement → pass** (full suite too).

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): one-shot migration of legacy localStorage alert blobs"`.

---

### Task 7: Telegram — linking, bot poller, notifier

**Files:**
- Create: `backend/auto_trader/core/telegram_notify.py`
- Modify: `backend/auto_trader/api/routers/alerts.py` (link/status/test endpoints)
- Modify: `backend/auto_trader/config.py` (settings block), `backend/auto_trader/api/app.py` (start poller, register notifier)
- Test: `backend/tests/test_telegram_notify.py`

**Interfaces:**
- Consumes: `ALERT_STORE` telegram methods; `httpx` (already a dependency); fired payload shape from Task 3.
- Produces in `telegram_notify.py`:
  - `TELEGRAM: TelegramNotify` singleton with `configure(token: str | None, store)`, `enabled` property (token set), `new_link_code(user_id) -> str` (random 12-char urlsafe code, in-memory dict code→(user_id, expiry 10 min)), `bot_username()` (cached `getMe` call), `async send(chat_id, text) -> None`, `async notifier(user_id, payload) -> None` (skips unless `payload["notify"].get("telegram", True)` and a chat is linked; message text: `f"🔔 {epic} {payload['message'] or ''} @ {level:.{precision}f} · now {price:.{precision}f}".strip()`), and `async run_poller()` — long-polls `getUpdates` (`timeout=50`, `offset` tracking), and on a message `"/start <code>"` with a valid pending code: `store.set_telegram(user_id, chat_id)`, reply "✅ Alerts connected." Invalid/expired code → reply "Link code expired — generate a new one in the app." Network errors: log + sleep 5 s, keep polling. If `not enabled`, `run_poller` returns immediately.
- New settings in `config.py`: follow the file's existing pattern — a small `TelegramSettings(BaseSettings)` with `env_prefix="TELEGRAM_"`, field `bot_token: str = ""`, instantiated alongside the others (read the bottom of `config.py` to see how instances are exposed and mirror it).
- Router endpoints (Task 5's router):
  - `POST /api/alerts/telegram/link` → `{"url": f"https://t.me/{username}?start={code}"}`, 503 if `not TELEGRAM.enabled`
  - `GET /api/alerts/telegram` → `{"linked": bool, "enabled": bool}`
  - `DELETE /api/alerts/telegram` → 204
  - `POST /api/alerts/telegram/test` → sends "🔔 Test alert from Auto Trader" to the linked chat; 404 if unlinked
- Lifespan: `TELEGRAM.configure(telegram_settings.bot_token or None, ALERT_STORE)`; add `TELEGRAM.notifier` to the engine's notifiers (extend the `configure` call from Task 4); `poller = asyncio.create_task(TELEGRAM.run_poller())`, cancelled in `finally`.

- [ ] **Step 1: Write failing tests** using `respx` (already a dev dep) to mock `api.telegram.org`: `send` posts sendMessage with chat_id/text; `notifier` skips when channel muted / not linked, sends when linked; link-code claim flow — feed `run_poller` one mocked getUpdates batch containing `/start <code>` then cancel it; assert `get_telegram` returns the chat id and a confirmation sendMessage went out; expired code → error reply, no link. Router tests: link returns a t.me URL (mock getMe), 503 without token.

- [ ] **Step 2–4: fail → implement → pass** (full suite).

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): telegram delivery — deep-link account linking, bot poller, DM notifier"`.

---

### Task 8: Web Push — VAPID, subscriptions, notifier

**Files:**
- Modify: `backend/pyproject.toml` (add `pywebpush>=2.0` to dependencies)
- Create: `backend/auto_trader/core/push_notify.py`
- Modify: `backend/auto_trader/api/routers/alerts.py` (vapid/subscribe endpoints), `backend/auto_trader/api/app.py` (register notifier)
- Test: `backend/tests/test_push_notify.py`

**Interfaces:**
- Consumes: `ALERT_STORE` push-sub + meta methods (VAPID keypair under `set_meta("", "vapid_private"/"vapid_public", ...)`).
- Produces `PUSH: PushNotify` singleton: `configure(store)`, `async vapid_public() -> str` (generate the keypair on first call via `py_vapid`/`cryptography` — `pywebpush` bundles `py_vapid`; store both PEM/base64 parts in meta), `async notifier(user_id, payload) -> None` — skip unless `payload["notify"].get("push", True)`; for each subscription call `webpush(subscription_info, json.dumps({...payload fields for the SW...}), vapid_private_key=..., vapid_claims={"sub": "mailto:alerts@auto-trader.local"})` via `asyncio.to_thread`; on `WebPushException` with a 404/410 response, `delete_push_sub` (prune dead endpoint), other errors logged.
- Router endpoints: `GET /api/alerts/push/vapid` → `{"key": ...}`; `POST /api/alerts/push/subscribe` body `{endpoint, keys}` → 204; `DELETE /api/alerts/push/subscribe` body `{endpoint}` → 204.
- Lifespan: `PUSH.configure(ALERT_STORE)`; add `PUSH.notifier` to the engine notifiers list.

- [ ] **Step 1: Write failing tests** — monkeypatch `push_notify.webpush` with a recorder: notifier sends one webpush per stored subscription with the payload JSON; a recorder that raises `WebPushException` carrying a fake 410 response prunes that subscription; muted `push` channel sends nothing; vapid_public is stable across two calls (generated once, persisted). Router: subscribe → row exists; vapid returns a non-empty key.

- [ ] **Step 2–4: fail → implement → pass.** Install first: `cd backend && uv sync` (pyproject edit) — verify `python3 -c "import pywebpush"`.

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): web push delivery — vapid keys, subscription endpoints, pruning notifier"`.

---

### Task 9: Frontend alerts client (`alertsApi.ts`) — cache + CRUD + events

**Files:**
- Create: `frontend/src/lib/alertsApi.ts`
- Test: `frontend/src/lib/alertsApi.test.ts`

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /api/alerts*` (Task 5 shapes); `API_BASE` and auth-token helper from `lib/persist/core.ts` (grep for how `/api/state` fetches attach auth and copy that).
- Produces (module `alertsApi.ts`):
  - Types re-homed here: `SavedAlert` (unchanged fields: `id, level, condition, trigger, message, expiresAt, notify, createdAt` — the client keeps the FLAT shape; this module maps to/from the server's `{kind, params}` on the wire), `AlertCondition`, `AlertTrigger`, `AlertNotifyChannels` gaining `push: boolean; telegram: boolean`, `CONDITION_LABELS`, `newAlertId()`, `normalizeAlert()` (moved verbatim from `persist/alerts.ts`; normalize defaults the two new channels to true).
  - `hydrateAlerts(): Promise<void>` — `GET /api/alerts` + `GET /api/alerts/triggered` into module caches: `Map<string /*broker*/, Map<string /*epic*/, SavedAlert[]>>` and a triggered array + seen number.
  - Synchronous reads mirroring today's API: `loadAlerts(epic, broker)`, `loadAllAlerts(broker)`, `loadStoredAlert(epic, id, broker)`, `loadTriggered()`, `loadTriggeredSeen()`.
  - Optimistic writes: `addStoredAlert(epic, alert, broker, precision?)` (cache insert + `POST`, rollback on failure + `toast("Alert save failed")` from `lib/notify`), `updateStoredAlert(epic, id, level, cfg, broker)` (cache patch + debounced `PATCH` — 300 ms trailing debounce per alert id so drags coalesce), `deleteStoredAlert(epic, id, broker)` (cache remove + `DELETE`), `pushTriggeredSeen(time)`, `clearTriggered()`. All fire `bumpAlerts()` after the cache change (import from `lib/signals`).
  - `applyAlertEvent(key: string, value: unknown): boolean` — returns true if `key` starts with `__alerts__:`; `changed` (from another tab or the engine) triggers a re-hydrate of that broker/epic (single-flight `GET /api/alerts` refresh) + `bumpAlerts()`; `fired` appends to the triggered cache and invokes a registered `onFired` callback: `setOnAlertFired(cb: (p: FiredPayload) => void)` with `FiredPayload = {id, broker, epic, price, level, condition, message, precision, notify}`.

- [ ] **Step 1: Write failing tests** (vitest, mock `fetch` with `vi.stubGlobal`): hydrate populates sync reads; addStoredAlert is readable synchronously before the POST resolves; failed POST rolls the cache back; update debounces (two rapid updates → one PATCH after timers advance, `vi.useFakeTimers`); delete removes + DELETEs; `applyAlertEvent` with a `fired` value invokes the callback and grows `loadTriggered()`; non-alert keys return false and change nothing.

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/lib/alertsApi.test.ts`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the test file, then the full frontend suite** (`npx vitest run`) — existing suites must stay green (nothing imports this module yet).

- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): frontend alerts client — hydrated cache, optimistic CRUD, event application"`.

---

### Task 10: Swap the frontend onto the client; delete the browser engine

**Files:**
- Modify: `frontend/src/lib/persist/alerts.ts` (gut to a re-export shim), `frontend/src/lib/persist.ts`, `frontend/src/lib/persist/core.ts` (route `__alerts__:` ws messages), `frontend/src/App.tsx`, `frontend/src/lib/overlays.ts`, `frontend/src/AlertsSidebar.tsx`, `frontend/src/AlertModal.tsx`
- Delete: `frontend/src/lib/alertEngine.ts`, `frontend/src/lib/alertEngine.test.ts`, `frontend/src/lib/alertEval.ts`, `frontend/src/lib/alertEval.test.ts`
- Test: existing suites (`persist.test.ts`, `overlays.test.ts`, `alertUi.test.ts`, `notify.test.ts`) must pass unchanged or with mechanical import fixes.

This is the integration task; work in this order:

1. **`persist/alerts.ts` → shim:** delete the localStorage implementation; `export * from "../alertsApi"` for every name that module now owns (types, labels, `normalizeAlert`, `newAlertId`, all load/save/add/update/delete/triggered functions). Keep `parseAlertsStateKey` deleted — its ws-reconcile job is replaced by `applyAlertEvent`. Grep for remaining imports of removed names (`saveAlerts`, `loadAlertsRaw`, `parseAlertsStateKey`) and update those call sites: `overlays.ts` uses `parseAlertsStateKey`/`saveAlerts` in its persist/reconcile paths — replace list-overwrite saves with per-alert `add/update/deleteStoredAlert` intents (the by-id functions already exist; `overlays.ts:2945`'s comment documents this as the intended model).
2. **`persist/core.ts`:** in the ws `onmessage` handler (near the `TRADES_DIRTY_PREFIX` branch, line ~530), add: `if (applyAlertEvent(msg.key, (msg as any).value)) return;` — alert events never touch localStorage.
3. **App startup:** where App hydrates persisted state / subscribes to backend updates, add `await hydrateAlerts()` (before first chart render; find the existing hydration `await` in `core.ts`/App and piggyback) and remove `alertEngine.setTabs/setBrokerId/setPriceSide` effects (`App.tsx:1637-1652`).
4. **Fired handling in App:** register once:

```tsx
useEffect(() => {
  setOnAlertFired((p) => {
    const prec = p.precision ?? 2;
    const now = p.price.toFixed(prec);
    const detail = p.message || `@ ${p.level.toFixed(prec)}`;
    const body = `${p.epic} ${p.message ? "· " : ""}${detail}`;
    const goTo = () => alertNavHandler.current?.(p.epic, p.id, prec);
    const key = `${p.epic}|${p.id}`;
    if (p.notify?.toast ?? true) toast(`🔔 ${body} (now ${now})`, { onClick: goTo, duration: null, key });
    if (p.notify?.browser ?? true) notify(p.epic, `${detail} · now ${now}`, goTo, key);
    if (p.notify?.sound ?? true) playPing();
    alertFired.set({ epic: p.epic });
  });
}, []);
```

(This is `alertEngine.ts::fire()` relocated — compare against it before deleting the file. `pushTriggered` is gone: history is server-written; the `fired` event already updated the local triggered cache.)
5. **AlertModal:** extend the notify-channels UI with Push and Telegram checkboxes (same markup as the existing three; read the file's channel block and clone it). Default both true.
6. **Delete** the four engine/eval files. Grep for `alertEngine`/`alertEval` imports — must be zero.
7. `overlays.ts` alert evaluation: `checkAlerts` (the active-tab live evaluator) is ALSO deleted — the backend is the single firing authority; the overlay keeps only rendering/dragging. Grep `overlays.ts` for `evaluateAlert`/`checkAlerts` and remove the call path (the caller is in the chart tick path — remove the invocation, keep the drawing code).

- [ ] **Step 1: Make the swap** in the order above, compiling as you go (`cd frontend && npx tsc --noEmit` after each numbered item).
- [ ] **Step 2: Fix tests** — run `npx vitest run`; update imports in existing alert-adjacent suites; `persist.test.ts` alert sections now target the shim (mock `fetch` at module setup — copy the pattern from `alertsApi.test.ts`). Delete tests that pinned localStorage-blob behavior that no longer exists (list them in the commit message).
- [ ] **Step 3: Full check** — `npx tsc --noEmit && npx vitest run` all green.
- [ ] **Step 4: Manual smoke** (requires backend running): create/drag/delete an alert on an open chart; check `alerts.db` rows change; fire one by setting a level adjacent to the live price; verify toast + triggered history + a second browser tab reconciling.
- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): frontend on the backend alert system; browser engine deleted"`.

---

### Task 11: Service worker + push subscription UI

**Files:**
- Create: `frontend/public/alert-sw.js`, `frontend/src/lib/pushClient.ts`, `frontend/src/NotificationSettings.tsx`
- Modify: `frontend/src/Settings.tsx` (mount the new section)
- Test: `frontend/src/lib/pushClient.test.ts`

**Interfaces:**
- Consumes: `GET /api/alerts/push/vapid`, `POST/DELETE /api/alerts/push/subscribe` (Task 8).
- Produces: `pushClient.ts` with `pushSupported(): boolean`, `isSubscribed(): Promise<boolean>`, `subscribePush(): Promise<void>` (register `/alert-sw.js`, `pushManager.subscribe({userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key)})`, POST the subscription), `unsubscribePush(): Promise<void>`.

`alert-sw.js` (complete file):

```js
// Web Push service worker for price alerts. Shows the OS notification unless a
// client tab is focused (the focused tab already showed a toast + played the ping).
self.addEventListener("push", (event) => {
  const p = event.data ? event.data.json() : {};
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.some((c) => c.focused)) return;
    const prec = p.precision ?? 2;
    const detail = p.message || `@ ${Number(p.level).toFixed(prec)}`;
    await self.registration.showNotification(`🔔 ${p.epic}`, {
      body: `${detail} · now ${Number(p.price).toFixed(prec)}`,
      tag: `${p.epic}|${p.id}`,
      data: { epic: p.epic, id: p.id },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    if (clients.length) return clients[0].focus();
    return self.clients.openWindow("/");
  })());
});
```

`NotificationSettings.tsx`: a section component with (a) a Push row — "Enable on this device" button ↔ enabled state with a disable button (drive via `pushClient`; hide entirely when `!pushSupported()`), and (b) a Telegram row (wired in Task 12 — render a placeholder `null` for Telegram in THIS task). Read `Settings.tsx` first and mount `<NotificationSettings />` following exactly how existing sections are structured/styled (reuse its section header markup; use the shared `Tooltip`/`InfoTip` components per CLAUDE.md if info hints are needed). Muted/enabled toggle styling: persistent toggles use gray, not accent blue (user preference).

- [ ] **Step 1: Write failing tests for `pushClient`** — stub `navigator.serviceWorker` + `PushManager` objects with `vi.stubGlobal`; assert subscribe registers the SW, subscribes with the decoded VAPID key, POSTs the subscription JSON; unsubscribe DELETEs and calls `subscription.unsubscribe()`; `pushSupported()` false path.
- [ ] **Step 2: fail → implement → pass**, then `npx tsc --noEmit && npx vitest run`.
- [ ] **Step 3: Manual smoke** — Chrome on localhost: enable push, fire an alert with the tab hidden → OS notification appears; click focuses the app.
- [ ] **Step 4: Commit** — `git commit -m "feat(alerts): web push — service worker, subscribe client, settings toggle"`.

---

### Task 12: Telegram settings UI

**Files:**
- Modify: `frontend/src/NotificationSettings.tsx`
- Create: `frontend/src/lib/telegramClient.ts`
- Test: `frontend/src/lib/telegramClient.test.ts`

**Interfaces:**
- Consumes: Task 7's endpoints.
- Produces: `telegramClient.ts` — `getTelegramStatus(): Promise<{linked: boolean, enabled: boolean}>`, `startTelegramLink(): Promise<string /*t.me url*/>`, `unlinkTelegram(): Promise<void>`, `sendTelegramTest(): Promise<void>`.

UI in the Telegram row: status-driven — if backend reports `enabled: false`, show muted text "Set TELEGRAM_BOT_TOKEN on the backend to enable." If unlinked: "Connect Telegram" button → calls `startTelegramLink`, opens the URL in a new tab (`window.open`), then polls `getTelegramStatus` every 2 s (stop after 2 min or on link) and flips to linked state. If linked: "Connected" + "Send test" + "Disconnect" buttons.

- [ ] **Step 1: Write failing tests for `telegramClient`** (fetch stubs, four functions, error propagation).
- [ ] **Step 2: fail → implement → pass**; wire the UI row; `npx tsc --noEmit && npx vitest run`.
- [ ] **Step 3: Manual smoke** with a real bot token in `backend/.env`: link, test message arrives, fire a real alert → DM.
- [ ] **Step 4: Commit** — `git commit -m "feat(alerts): telegram settings — connect flow, test message, disconnect"`.

---

### Task 13: End-to-end probe + docs

**Files:**
- Create: `backend/scripts/alert_probe.py`
- Modify: `CLAUDE.md` (short "Alerts" note: backend-owned, endpoints, TELEGRAM_BOT_TOKEN)
- Test: manual run

**Interfaces:** consumes the public API only.

`alert_probe.py` (argparse, `--url` default `http://localhost:8000`): (1) `POST /api/alerts` a `greater` alert 0.0001 below the current quote of `--epic` (default US100, quote via `GET /api/markets/...` — grep the markets router for the quote endpoint shape) so the next tick fires it; (2) poll `GET /api/alerts/triggered` up to 30 s for the new entry; (3) print PASS/FAIL and clean up the alert. Mirrors `scripts/agent_bridge_probe.py`'s structure — read it first (auth flags especially).

- [ ] **Step 1: Write the script + CLAUDE.md note.**
- [ ] **Step 2: Run it against a live backend** with a streaming-market epic; paste output.
- [ ] **Step 3: Full suites one last time** — backend pytest + frontend vitest + `tsc --noEmit`.
- [ ] **Step 4: Commit** — `git commit -m "feat(alerts): e2e alert probe + docs"`.
