# MT5 RPC connect single-flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `MT5Broker._ensure()` from holding `self._lock` across the multi-minute MetaApi connect, so `deploy_state`/`pause`/`resume` and the `_rebuild` self-heal loop can no longer wedge until a process restart.

**Architecture:** Split `_ensure()` into a fast, lock-guarded claim of a single-flight `_connect_task` and a slow, lock-free `_connect(gen)` coroutine that does `wait_connected`/`connect`/`wait_synchronized` with no lock held and re-acquires `_lock` only for the O(1) publish of `_conn`/`_synced`. A captured `_gen` guards the newly-introduced pause-during-connect race; `pause`/`resume`/`_rebuild` invalidate any in-flight connect.

**Tech Stack:** Python 3.14, asyncio, `metaapi_cloud_sdk` 29.1.1, pytest.

## Global Constraints

- Scope is `backend/auto_trader/brokers/mt5.py`, `MT5Broker` (the `MarketDataBroker`) RPC path only. Do NOT touch `_ensure_stream()` or bound `deploy_state`/`pause`/`resume`'s own `acct.reload()` — those are deferred.
- Never hold `self._lock` across `wait_connected` / `conn.connect()` / `wait_synchronized`.
- Preserve existing behaviour: the pause gate still raises `MT5PausedError` when the account is not `DEPLOYING`/`DEPLOYED`; the read path (`_bounded`) still fast-fails while disconnected and never drives the connect itself.
- `TimeoutException` is `from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException` (already imported at mt5.py:36). `asyncio` already imported (mt5.py:26).
- Tests live in `backend/tests/test_mt5.py`. Run from `backend/` with `python -m pytest`.
- `CONNECT_BUDGET = 120.0` (new class constant).
- Commit after every task. End commit messages with the standard trailers used in this repo's history.

---

### Task 1: Add `_connect_task` state and `CONNECT_BUDGET`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` (`__init__` ~line 354; class constants ~line 316)

**Interfaces:**
- Produces: `self._connect_task: asyncio.Task | None` instance attribute; `MT5Broker.CONNECT_BUDGET: float` class constant.

- [ ] **Step 1: Add the class constant.** Next to `RECONNECT_COOLDOWN`/`RECONNECT_BACKOFF_MAX` (mt5.py ~316), add:

```python
    # Wall-clock bound on a single RPC connect attempt (wait_connected). The SDK's
    # wait_connected default is 300s and loops on reload(); we bound it so the
    # background _connect task (and the _rebuild heal loop that awaits it) fails and
    # retries in minutes rather than sitting on the full 300s. Off the lock, this
    # budget no longer affects UI liveness. 120s covers a genuine deploy->CONNECT.
    CONNECT_BUDGET = 120.0
```

- [ ] **Step 2: Add the instance attribute.** In `__init__`, next to `self._rebuild_task` (mt5.py ~354), add:

```python
        # Single-flight for the slow RPC connect. `_ensure` claims/reuses ONE
        # `_connect` task under `_lock` then awaits it WITHOUT the lock, so the
        # connect's minutes of network I/O never block lifecycle callers that share
        # `_lock` (deploy_state/pause/resume). Invalidated (nulled) by pause/resume/
        # _rebuild so the next `_ensure` starts a fresh connect.
        self._connect_task: asyncio.Task | None = None
```

- [ ] **Step 3: Verify import/collection still works.**

Run: `cd backend && python -m pytest tests/test_mt5.py -q -x`
Expected: PASS (no behaviour change yet).

- [ ] **Step 4: Commit.**

```bash
git add backend/auto_trader/brokers/mt5.py
git commit -m "$(cat <<'EOF'
feat(mt5): add _connect_task slot + CONNECT_BUDGET for single-flight connect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB
EOF
)"
```

---

### Task 2: Red test — `deploy_state` must not block behind a stuck connect

**Files:**
- Modify: `backend/tests/test_mt5.py` (add test near the other `_ensure`/wedge tests, ~after line 984)

**Interfaces:**
- Consumes: `MT5Broker`, `asyncio`, `pytest` (all already imported at the top of test_mt5.py).

This test encodes the reported bug: while a connect is stuck in `wait_connected`, a `deploy_state()` call must still return promptly. It will FAIL on current code (the stuck connect holds `_lock`, which `_account_handle` needs) and PASS after Task 3.

- [ ] **Step 1: Write the failing test.**

```python
def test_deploy_state_not_blocked_by_stuck_connect():
    # The reported wedge: a connect stuck in wait_connected must NOT freeze the
    # lifecycle path. deploy_state() shares self._lock with the connect, so if the
    # connect holds the lock across its multi-minute wait, deploy_state hangs
    # (curl 000). The connect must run OFF the lock.
    import time as _time

    broker = MT5Broker(token="t", account_id="a")

    class _StuckAcct:
        state = "DEPLOYED"
        async def reload(self):
            return None
        async def wait_connected(self, timeout_in_seconds=None):
            await asyncio.sleep(3600)  # never connects — simulates a wedged socket
        def get_rpc_connection(self):
            raise AssertionError("should never reach connect while wait_connected hangs")

    broker._api = object()          # skip MetaApi client construction
    broker._acct = _StuckAcct()     # _account_unlocked returns this cached handle

    async def scenario():
        connect = asyncio.create_task(broker._ensure())  # will block in wait_connected
        await asyncio.sleep(0.05)                          # let it enter the connect
        t0 = _time.monotonic()
        state = await asyncio.wait_for(broker.deploy_state(), 1.0)  # must NOT hang
        assert _time.monotonic() - t0 < 1.0
        assert state == "on"  # DEPLOYED maps to the UI "on" state
        connect.cancel()
        try:
            await connect
        except (asyncio.CancelledError, Exception):
            pass

    asyncio.run(scenario())
```

- [ ] **Step 2: Run it — confirm it FAILS on current code.**

Run: `cd backend && python -m pytest tests/test_mt5.py::test_deploy_state_not_blocked_by_stuck_connect -v`
Expected: FAIL — `deploy_state()` times out (raises `TimeoutError` from `wait_for`) because current `_ensure` holds `_lock` across `wait_connected`. (If `_ui_deploy_state("DEPLOYED")` is not `"on"`, adjust the asserted string to match `_ui_deploy_state` in mt5.py — check it before assuming.)

- [ ] **Step 3: Commit the red test.**

```bash
git add backend/tests/test_mt5.py
git commit -m "$(cat <<'EOF'
test(mt5): red — deploy_state must not block behind a stuck RPC connect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB
EOF
)"
```

---

### Task 3: Split `_ensure` into claim + single-flight `_connect`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` — replace the body of `_ensure` (currently ~467-493) and add `_connect`.

**Interfaces:**
- Consumes: `self._lock`, `self._synced`, `self._conn`, `self._gen`, `self._connect_task` (Task 1), `self._account_unlocked()`, `MT5PausedError`, `_PAUSED_MSG`, `self.CONNECT_BUDGET` (Task 1), `self.CLOSE_BUDGET`, `TimeoutException`.
- Produces: `_ensure()` returns the live RPC connection (unchanged contract); new `async def _connect(self, gen: int)` coroutine.

- [ ] **Step 1: Replace `_ensure`'s body.** Replace the whole method (from `async def _ensure(self):` through `return conn`, mt5.py ~467-493) with:

```python
    async def _ensure(self):
        """Return the live RPC connection, connecting once and reusing it. The slow
        connect runs in a single-flighted background `_connect` task that this method
        awaits WITHOUT holding `_lock`, so lifecycle callers that share `_lock`
        (deploy_state/pause/resume) are never blocked by it. Re-entrant: concurrent
        callers share one `_connect`; a healthy connection short-circuits before any
        lock or task."""
        if self._synced and self._conn is not None:
            return self._conn
        async with self._lock:
            if self._synced and self._conn is not None:
                return self._conn
            if self._connect_task is None or self._connect_task.done():
                self._connect_task = asyncio.create_task(self._connect(self._gen))
            task = self._connect_task
        # `_lock` RELEASED before awaiting the slow connect.
        return await task

    async def _connect(self, gen: int):
        """The slow RPC connect, run OFF `_lock` and single-flighted via
        `_connect_task`. Publishes `_conn`/`_synced` under `_lock` only for the O(1)
        handoff, and only if this connect's captured `gen` still matches — a `pause`
        or a newer `_rebuild` bumps `_gen` to supersede an in-flight connect so it
        can't resurrect a connection to an account that was just torn down."""
        conn = None
        published = False
        try:
            async with self._lock:
                acct = await self._account_unlocked()
            # NEVER auto-deploy: deploying re-starts MetaApi billing and the user may
            # have undeployed on purpose. Reload once — the local state can be stale.
            if acct.state not in ("DEPLOYING", "DEPLOYED"):
                await acct.reload()
                if acct.state not in ("DEPLOYING", "DEPLOYED"):
                    raise MT5PausedError(_PAUSED_MSG)
            await acct.wait_connected(self.CONNECT_BUDGET)
            conn = acct.get_rpc_connection()
            await conn.connect()
            await conn.wait_synchronized(120)
            async with self._lock:
                if gen != self._gen:
                    raise TimeoutException("mt5: connect superseded")
                self._conn = conn
                self._synced = True
                self._paused_hint = False  # a real connection self-heals a stale hint
                published = True
            log.info("mt5: connected + synchronized (account %s)", self._account_id)
            return conn
        finally:
            if conn is not None and not published:
                try:
                    await asyncio.wait_for(conn.close(), self.CLOSE_BUDGET)
                except Exception:  # best-effort teardown of a conn we won't publish
                    log.debug("mt5: error closing unpublished conn", exc_info=True)
```

Note the `_account_unlocked()` call is wrapped in `async with self._lock` because `_account_unlocked`'s docstring requires the caller to hold `_lock` (it lazily builds `_api`/`_acct`). This is a brief, bounded hold (a single `get_account`), NOT the multi-minute connect.

- [ ] **Step 2: Run the red test — it must now PASS.**

Run: `cd backend && python -m pytest tests/test_mt5.py::test_deploy_state_not_blocked_by_stuck_connect -v`
Expected: PASS — `deploy_state()` returns promptly while the connect is stuck off the lock.

- [ ] **Step 3: Run the existing `_ensure` tests — no regressions.**

Run: `cd backend && python -m pytest tests/test_mt5_deploy.py tests/test_mt5.py -q`
Expected: PASS. `test_ensure_raises_paused_instead_of_deploying` and `test_ensure_reload_detects_external_redeploy` still pass — the pause gate and reload now live in `_connect`, and `await task` re-raises `MT5PausedError`/`AttributeError` to the `_ensure` caller unchanged.

- [ ] **Step 4: Commit.**

```bash
git add backend/auto_trader/brokers/mt5.py
git commit -m "$(cat <<'EOF'
fix(mt5): connect off the lock via single-flight _connect task

_ensure now claims/reuses one _connect task under _lock then awaits it WITHOUT
the lock; _connect does wait_connected/connect/wait_synchronized off the lock and
publishes under it only for the O(1) handoff, guarded by a captured _gen. Fixes
deploy_state hanging (000) behind a stuck connect.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB
EOF
)"
```

---

### Task 4: Invalidate the in-flight connect on `_rebuild` / `pause` / `resume`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` — `_rebuild` locked block (~646-659), `pause` (~431-439), `resume` (~441-457).

**Interfaces:**
- Consumes: `self._connect_task`, `self._gen`, `self._lock`.
- Produces: after any of these calls, a stale `_connect` is superseded (`_gen` bumped) and `_connect_task` is nulled so the next `_ensure` starts fresh.

- [ ] **Step 1: `_rebuild` — null the connect task in its locked block.** In `_rebuild`, inside `async with self._lock:` where `_gen` is bumped and fields nulled (after `self._synced = False`, ~656), add:

```python
            self._connect_task = None
```

(`_rebuild` already bumps `self._gen` at ~651, which supersedes any in-flight `_connect`; nulling the task makes the `_ensure` it calls at ~664 start a fresh connect instead of awaiting the superseded one.)

- [ ] **Step 2: `pause` — supersede + null under the lock.** Change `pause` (mt5.py ~431-439) so that after acquiring the handle it invalidates any in-flight connect. Replace:

```python
    async def pause(self) -> str:
        """Undeploy the account (stops MetaApi billing) and drop our
        connections so nothing holds a socket to a dying terminal. Idempotent."""
        acct = await self._account_handle()
        await self._close_connections()
        await acct.reload()
        if acct.state in ("DEPLOYED", "DEPLOYING"):
            await acct.undeploy()
        return _ui_deploy_state(acct.state)
```

with:

```python
    async def pause(self) -> str:
        """Undeploy the account (stops MetaApi billing) and drop our
        connections so nothing holds a socket to a dying terminal. Idempotent."""
        acct = await self._account_handle()
        async with self._lock:
            # Supersede any in-flight connect so it can't publish a connection to the
            # account we're about to undeploy, and force the next _ensure to reconnect.
            self._gen += 1
            self._connect_task = None
        await self._close_connections()
        await acct.reload()
        if acct.state in ("DEPLOYED", "DEPLOYING"):
            await acct.undeploy()
        return _ui_deploy_state(acct.state)
```

- [ ] **Step 3: `resume` — null the connect task.** In `resume` (mt5.py ~441-457), alongside the existing `self._paused_hint = False` / `self._rebuild_fails = 0` / `self._last_rebuild_at = float("-inf")` resets, add:

```python
        self._connect_task = None
```

- [ ] **Step 4: Write the pause-during-connect test.** Add to `backend/tests/test_mt5.py`:

```python
def test_pause_during_connect_does_not_publish_connection():
    # Releasing the lock during connect reintroduces a pause-vs-connect race: a
    # connect that started before pause() must NOT publish a live connection to the
    # account pause just undeployed. The _gen guard supersedes it.
    broker = MT5Broker(token="t", account_id="a")
    gate = asyncio.Event()

    class _SlowAcct:
        state = "DEPLOYED"
        async def reload(self):
            return None
        async def undeploy(self):
            self.state = "UNDEPLOYED"
        async def wait_connected(self, timeout_in_seconds=None):
            await gate.wait()  # hold the connect open until pause has run
        def get_rpc_connection(self):
            class _C:
                async def connect(self): pass
                async def wait_synchronized(self, t): pass
                async def close(self): pass
            return _C()

    broker._api = object()
    broker._acct = _SlowAcct()

    async def scenario():
        connect = asyncio.create_task(broker._ensure())
        await asyncio.sleep(0.05)          # connect is now parked in wait_connected
        await broker.pause()               # bumps _gen, nulls _connect_task
        gate.set()                         # let the connect finish its network work
        with pytest.raises(Exception):     # superseded -> raises, does not publish
            await connect
        assert broker._synced is False
        assert broker._conn is None

    asyncio.run(scenario())
```

- [ ] **Step 5: Run the new + existing tests.**

Run: `cd backend && python -m pytest tests/test_mt5.py::test_pause_during_connect_does_not_publish_connection tests/test_mt5.py tests/test_mt5_deploy.py tests/test_mt5_idle_watchdog.py tests/test_mt5_idle_undeploy.py -q`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add backend/auto_trader/brokers/mt5.py backend/tests/test_mt5.py
git commit -m "$(cat <<'EOF'
fix(mt5): invalidate in-flight connect on rebuild/pause/resume

pause bumps _gen + nulls _connect_task (supersedes a connect that would otherwise
resurrect a torn-down connection); resume nulls it to force a fresh connect on the
new deployment; _rebuild nulls it so its _ensure starts fresh. Adds the
pause-during-connect regression test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB
EOF
)"
```

---

### Task 5: Self-heal + single-flight regression tests

**Files:**
- Modify: `backend/tests/test_mt5.py`.

**Interfaces:**
- Consumes: `MT5Broker`, `asyncio`, `pytest`.

- [ ] **Step 1: Single-flight test.** Add:

```python
def test_ensure_is_single_flight():
    # Concurrent _ensure callers must share ONE _connect, not each build a client.
    broker = MT5Broker(token="t", account_id="a")
    connects = []

    class _Acct:
        state = "DEPLOYED"
        async def reload(self): return None
        async def wait_connected(self, timeout_in_seconds=None):
            connects.append(1)
            await asyncio.sleep(0.05)
        def get_rpc_connection(self):
            class _C:
                async def connect(self): pass
                async def wait_synchronized(self, t): pass
                async def close(self): pass
            return _C()

    broker._api = object()
    broker._acct = _Acct()

    async def scenario():
        conns = await asyncio.gather(broker._ensure(), broker._ensure(), broker._ensure())
        assert len(connects) == 1          # exactly one connect ran
        assert conns[0] is conns[1] is conns[2]
        assert broker._synced is True

    asyncio.run(scenario())
```

- [ ] **Step 2: Self-heal test — a wedged connect lets `_rebuild` reach its finally.** Add:

```python
def test_rebuild_recovers_state_after_wedged_connect():
    # A wedged connect must fail within CONNECT_BUDGET (off the lock) so _rebuild
    # reaches its finally and resets _state to OK — the self-heal that today needs a
    # process restart. We shrink CONNECT_BUDGET and make wait_connected honour it.
    broker = MT5Broker(token="t", account_id="a")
    broker.CONNECT_BUDGET = 0.05

    class _WedgedAcct:
        state = "DEPLOYED"
        async def reload(self): return None
        async def wait_connected(self, timeout_in_seconds=None):
            await asyncio.sleep(timeout_in_seconds)                 # burns the budget
            raise TimeoutException("timed out")                    # ...then fails, like the SDK
        def get_rpc_connection(self):
            raise AssertionError("never reached — wait_connected fails first")

    broker._api = object()
    broker._acct = _WedgedAcct()
    broker._tick_subs = {}

    async def scenario():
        broker._state = "RECONNECTING"          # as _start_rebuild would set it
        await broker._rebuild(broker._gen)      # awaits the wedged _ensure, then heals
        assert broker._state == "OK"            # finally ran — self-healed, no restart
        assert broker._synced is False

    asyncio.run(scenario())
```

`TimeoutException` is already imported in test_mt5.py if the other tests use it; if not, add `from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException` at the top of the test file.

- [ ] **Step 3: Run the new tests.**

Run: `cd backend && python -m pytest tests/test_mt5.py::test_ensure_is_single_flight tests/test_mt5.py::test_rebuild_recovers_state_after_wedged_connect -v`
Expected: PASS.

- [ ] **Step 4: Full broker suite — no regressions.**

Run: `cd backend && python -m pytest tests/test_mt5.py tests/test_mt5_deploy.py tests/test_mt5_stream.py tests/test_api_mt5_deploy.py tests/test_broker_health.py -q`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend/tests/test_mt5.py
git commit -m "$(cat <<'EOF'
test(mt5): single-flight connect + self-heal-after-wedge regressions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB
EOF
)"
```

---

### Task 6: Full backend test sweep + verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole backend test suite.**

Run: `cd backend && python -m pytest -q`
Expected: PASS (same baseline as before the change; no MT5-related failures).

- [ ] **Step 2: Confirm the invariant by inspection.** Grep to prove no slow call sits under `_lock` in the RPC path:

Run: `cd backend && grep -n 'wait_connected\|wait_synchronized\|\.connect()' auto_trader/brokers/mt5.py`
Expected: the RPC-path `wait_connected`/`connect`/`wait_synchronized` are inside `_connect`, and `_connect` only holds `_lock` around `_account_unlocked()` and the final publish — never around those three calls.

- [ ] **Step 3: Commit (if any incidental fixups were needed; otherwise skip).**

---

## Self-Review

**Spec coverage:**
- `_ensure` split + lock-free connect → Task 3. ✓
- Single-flight via `_connect_task` → Task 1 (state) + Task 3 (logic) + Task 5 (test). ✓
- Pause-during-connect `_gen` guard + invalidation on pause/resume/_rebuild → Task 4. ✓
- Bounded `wait_connected(CONNECT_BUDGET)` → Task 1 (constant) + Task 3 (call). ✓
- Symptom 1 (deploy-state hang) → Task 2 red test + Task 3 fix. ✓
- Symptom 2 (503 forever / self-heal) → Task 5 self-heal test. ✓
- Known residual (`get_account` under lock) → documented in spec; Task 3 note. ✓
- Out of scope (`_ensure_stream`, deploy_state reload) → untouched per Global Constraints. ✓

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `_connect_task` (Task 1) is nulled/checked identically in Tasks 3/4; `CONNECT_BUDGET` defined in Task 1, used in Tasks 3/5; `_connect(self, gen: int)` signature consistent across Tasks 3/4/5; `_gen` guard matches the spec.
