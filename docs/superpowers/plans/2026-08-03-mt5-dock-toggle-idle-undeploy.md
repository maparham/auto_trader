# MT5 Broker-Scoped Toggle + Idle Auto-Undeploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the MT5 deploy toggle to the dock (visible only when MT5 is the active broker) and auto-undeploy the MetaApi account after a configurable idle period to stop hosting billing.

**Architecture:** Backend tracks a monotonic `_last_use` on `MT5Broker`, touched only on genuine RPC operations. A lifespan-driven watchdog polls deploy state; when deployed and idle past the timeout, it calls `pause()` (undeploy). `GET /api/mt5/deploy-state` also returns the remaining idle seconds. The frontend `Mt5DeployButton` moves into `PositionsPanel`'s `pp-bar`, gated on the active broker being `mt5`, and shows a live countdown while deployed. The toggle updates after auto-undeploy via its existing poll (≤12s), so no `/ws` broadcast is added.

**Tech Stack:** Python 3 / FastAPI / asyncio (backend), React + TypeScript + a `Signal` primitive (frontend), pytest, vitest.

## Global Constraints

- Env var name: `MT5_IDLE_UNDEPLOY_SECS`, default `1800` (30 min).
- Watchdog poll interval: `30.0` seconds.
- The broker NEVER auto-deploys; the watchdog only ever undeploys (`pause()`), never deploys.
- `_last_use` is touched ONLY on genuine RPC success in `_bounded()` — NOT in `deploy_state()` (that is the frontend's status poll) and NOT on reconnect attempts.
- No open-position guard on auto-undeploy (matches the manual `/api/mt5/undeploy`).
- Tooltips: use the shared `Tooltip` component, never native `title=`.

---

### Task 1: Idle tracking on `MT5Broker`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` (add `import os`; module constant; `__init__` ~line 320-348; `resume()` ~line 429-444; `_bounded()` success path ~line 520-522; new method after `resume()`)
- Test: `backend/tests/test_mt5_idle_undeploy.py` (create)

**Interfaces:**
- Produces:
  - `MT5Broker._last_use: float` — monotonic timestamp of last genuine RPC success.
  - `MT5Broker._idle_timeout: int` — seconds of idle before eligible for auto-undeploy.
  - `MT5Broker.seconds_until_idle_undeploy() -> int` — `int(max(0, _idle_timeout - (monotonic - _last_use)))`. Pure/local, no I/O, no await.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_mt5_idle_undeploy.py`:

```python
"""MT5 idle tracking: seconds_until_idle_undeploy decrements with elapsed idle
time, clamps at 0, and resets when a genuine RPC touches _last_use."""
import time

from auto_trader.brokers.mt5 import MT5Broker


def _broker(idle_timeout: int = 1800) -> MT5Broker:
    b = MT5Broker(token="t", account_id="a")
    b._idle_timeout = idle_timeout
    return b


def test_full_window_right_after_touch():
    b = _broker(1800)
    b._last_use = time.monotonic()
    assert 1795 <= b.seconds_until_idle_undeploy() <= 1800


def test_decrements_with_elapsed_idle():
    b = _broker(1800)
    b._last_use = time.monotonic() - 600  # 10 min ago
    assert 1195 <= b.seconds_until_idle_undeploy() <= 1200


def test_clamps_to_zero_past_deadline():
    b = _broker(1800)
    b._last_use = time.monotonic() - 3600  # well past
    assert b.seconds_until_idle_undeploy() == 0


def test_touch_via_bounded_resets_window(monkeypatch):
    import asyncio

    b = _broker(1800)
    b._last_use = time.monotonic() - 600
    # Simulate a synchronized connection so _bounded runs the call + touches.
    b._state = "OK"
    b._synced = True
    b._conn = object()

    async def fake_call(_conn):
        return "ok"

    asyncio.run(b._bounded(fake_call))
    assert 1795 <= b.seconds_until_idle_undeploy() <= 1800
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_mt5_idle_undeploy.py -v`
Expected: FAIL — `AttributeError: 'MT5Broker' object has no attribute 'seconds_until_idle_undeploy'` (and `_idle_timeout`/`_last_use`).

- [ ] **Step 3: Write minimal implementation**

In `mt5.py`, add `import os` alongside the other stdlib imports (near line 26-30). Add a module constant near the other module-level config:

```python
# Auto-undeploy the MetaApi account after this many seconds with no genuine RPC
# activity, to stop hosting billing when MT5 is left deployed but unused. Reset
# on every successful RPC (see _bounded) and on resume(). Env-overridable.
_IDLE_UNDEPLOY_SECS = int(os.getenv("MT5_IDLE_UNDEPLOY_SECS", "1800"))
```

In `__init__` (after `self._last_rebuild_at = float("-inf")`, ~line 348):

```python
        # Idle auto-undeploy: monotonic time of the last genuine RPC; a watchdog
        # undeploys once (monotonic - _last_use) exceeds _idle_timeout. Seeded to
        # "now" so a just-constructed broker gets a full grace window.
        self._idle_timeout = _IDLE_UNDEPLOY_SECS
        self._last_use = time.monotonic()
```

In `resume()`, after `self._last_rebuild_at = float("-inf")` (~line 443), before `return`:

```python
        self._last_use = time.monotonic()  # fresh deploy → full idle window
```

In `_bounded()`, on the success path (currently lines 520-521, after the RPC returns):

```python
        self._fail_streak = 0
        self._rebuild_fails = 0  # a working RPC proves the broker healed — reset backoff
        self._last_use = time.monotonic()  # genuine activity → defer auto-undeploy
        return result
```

Add the method immediately after `resume()` (after line 444):

```python
    def seconds_until_idle_undeploy(self) -> int:
        """Seconds of idle remaining before this account is eligible for
        auto-undeploy. Local/pure (no I/O): the watchdog and the deploy-state
        endpoint read it. Clamps at 0; only meaningful while deployed — callers
        gate on deploy state."""
        remaining = self._idle_timeout - (time.monotonic() - self._last_use)
        return int(max(0, remaining))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_mt5_idle_undeploy.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/mt5.py backend/tests/test_mt5_idle_undeploy.py
git commit -m "feat(mt5): track idle time, seconds_until_idle_undeploy()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

### Task 2: `GET /api/mt5/deploy-state` returns `idle_seconds_remaining`

**Files:**
- Modify: `backend/auto_trader/api/routers/mt5.py:33-35` (the GET handler)
- Test: `backend/tests/test_api_mt5_deploy.py` (add cases)

**Interfaces:**
- Consumes: `MT5Broker.deploy_state() -> str`, `MT5Broker.seconds_until_idle_undeploy() -> int` (Task 1).
- Produces: `GET /api/mt5/deploy-state` JSON now includes `idle_seconds_remaining: int | None` — the int when `state == "on"`, else `None`. `/deploy` and `/undeploy` bodies are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_api_mt5_deploy.py`:

```python
def test_deploy_state_includes_idle_remaining_when_on():
    broker = _broker(deploy_state="on")
    broker.seconds_until_idle_undeploy = lambda: 1234  # sync method
    with patch(_GET_DATA, return_value=broker):
        body = client.get("/api/mt5/deploy-state").json()
    assert body == {"state": "on", "detail": None, "idle_seconds_remaining": 1234}


def test_deploy_state_idle_remaining_null_when_off():
    broker = _broker(deploy_state="off")
    broker.seconds_until_idle_undeploy = lambda: 1234
    with patch(_GET_DATA, return_value=broker):
        body = client.get("/api/mt5/deploy-state").json()
    assert body["idle_seconds_remaining"] is None
```

Also update the existing `test_deploy_state_passthrough` expectation to include the new key:

```python
def test_deploy_state_passthrough():
    broker = _broker(deploy_state="on")
    broker.seconds_until_idle_undeploy = lambda: 5
    with patch(_GET_DATA, return_value=broker):
        assert client.get("/api/mt5/deploy-state").json() == {
            "state": "on", "detail": None, "idle_seconds_remaining": 5,
        }
```

And update `test_unconfigured_when_registry_has_no_mt5` to expect the key:

```python
    assert body == {"state": "unconfigured", "detail": None, "idle_seconds_remaining": None}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_mt5_deploy.py -v`
Expected: FAIL — response lacks `idle_seconds_remaining` (KeyError / dict mismatch).

- [ ] **Step 3: Write minimal implementation**

Replace the GET handler in `routers/mt5.py` (lines 33-35). Leave `_lifecycle`, `/deploy`, `/undeploy` untouched:

```python
@router.get("/api/mt5/deploy-state")
async def mt5_deploy_state() -> dict:
    try:
        broker = deps.get_data("mt5")
    except HTTPException:
        return {"state": "unconfigured", "detail": None, "idle_seconds_remaining": None}
    try:
        state = await broker.deploy_state()
    except Exception as exc:  # SDK error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"MetaApi error: {exc}") from None
    # Countdown only means anything while deployed; hide it otherwise.
    remaining = broker.seconds_until_idle_undeploy() if state == "on" else None
    return {"state": state, "detail": None, "idle_seconds_remaining": remaining}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_mt5_deploy.py -v`
Expected: PASS (all cases, including the pre-existing deploy/undeploy/502 ones).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/mt5.py backend/tests/test_api_mt5_deploy.py
git commit -m "feat(api): deploy-state returns idle_seconds_remaining

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

### Task 3: Idle-undeploy watchdog (loop + lifespan wiring)

**Files:**
- Modify: `backend/auto_trader/api/deps.py` (add interval constant near line 136 and two functions near `_run_paper_triggers` at line 144)
- Modify: `backend/auto_trader/api/app.py:69-85` (spawn + cancel the watchdog in lifespan)
- Test: `backend/tests/test_mt5_idle_watchdog.py` (create)

**Interfaces:**
- Consumes: `MT5Broker.deploy_state() -> str`, `MT5Broker.seconds_until_idle_undeploy() -> int`, `MT5Broker.pause() -> str` (Task 1 + existing).
- Produces:
  - `deps._MT5_WATCHDOG_INTERVAL: float = 30.0`
  - `deps._mt5_idle_tick(broker) -> bool` — one tick; awaits `deploy_state()`, and if `"on"` and `seconds_until_idle_undeploy() == 0` awaits `pause()` and returns `True`; else `False`. Swallows+logs exceptions, returns `False`.
  - `deps._run_mt5_idle_watchdog(broker) -> None` — `while True: sleep(interval); _mt5_idle_tick(broker)`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_mt5_idle_watchdog.py`:

```python
"""The idle watchdog tick undeploys a deployed+idle account, and no-ops when
the account is off or still within its idle window."""
import asyncio
from unittest.mock import AsyncMock

from auto_trader.api import deps


def _broker(state: str, remaining: int):
    b = AsyncMock()
    b.deploy_state.return_value = state
    b.seconds_until_idle_undeploy = lambda: remaining  # sync
    return b


def test_tick_undeploys_when_on_and_idle_expired():
    b = _broker("on", 0)
    assert asyncio.run(deps._mt5_idle_tick(b)) is True
    b.pause.assert_awaited_once()


def test_tick_noop_when_still_within_window():
    b = _broker("on", 120)
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
    b.pause.assert_not_awaited()


def test_tick_noop_when_off():
    b = _broker("off", 0)
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
    b.pause.assert_not_awaited()


def test_tick_swallows_errors():
    b = AsyncMock()
    b.deploy_state.side_effect = RuntimeError("boom")
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_mt5_idle_watchdog.py -v`
Expected: FAIL — `AttributeError: module 'auto_trader.api.deps' has no attribute '_mt5_idle_tick'`.

- [ ] **Step 3: Write minimal implementation**

In `deps.py`, add near `_TRIGGER_INTERVAL` (line 136):

```python
# How often the MT5 idle watchdog checks for a deployed-but-unused account to
# auto-undeploy (stops MetaApi hosting billing). Coarse: undeploy is a cost
# guard, not latency-sensitive.
_MT5_WATCHDOG_INTERVAL = 30.0
```

Add after `_run_paper_triggers` (line 161):

```python
async def _mt5_idle_tick(broker) -> bool:
    """One watchdog check: undeploy the MT5 account if it is deployed and has
    been idle past its window. Returns True iff it undeployed. Never raises —
    a bad MetaApi call must not kill the watchdog."""
    try:
        if await broker.deploy_state() == "on" and broker.seconds_until_idle_undeploy() == 0:
            await broker.pause()
            log.info("mt5: auto-undeployed after idle timeout")
            return True
    except Exception:
        log.exception("mt5 idle watchdog tick failed")
    return False


async def _run_mt5_idle_watchdog(broker) -> None:
    """Periodically auto-undeploy an idle MT5 account so a forgotten deployment
    stops billing. The account is redeployed only by an explicit user action."""
    while True:
        await asyncio.sleep(_MT5_WATCHDOG_INTERVAL)
        await _mt5_idle_tick(broker)
```

Confirm `deps.py` already has a module `log` (it uses `log.exception` in `_run_paper_triggers`, so it does).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_mt5_idle_watchdog.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into the lifespan**

In `app.py`, inside `lifespan`, after the `triggers = [...]` list (line 73) add:

```python
    # MT5 idle watchdog: auto-undeploy a deployed-but-unused MetaApi account so a
    # forgotten deployment stops billing. Spawned only when MT5 is configured.
    try:
        mt5_watchdog = asyncio.create_task(
            deps._run_mt5_idle_watchdog(deps.get_data("mt5"))
        )
    except HTTPException:
        mt5_watchdog = None
```

Ensure `HTTPException` is imported in `app.py` (add `from fastapi import FastAPI, HTTPException` or extend the existing FastAPI import). Then update teardown (lines 77-83) so the watchdog is cancelled and awaited alongside the triggers:

```python
    finally:
        watchdogs = [t for t in (mt5_watchdog,) if t is not None]
        for task in (flusher, *triggers, *watchdogs):
            task.cancel()
        with suppress(asyncio.CancelledError):
            await flusher  # lets run_flusher do its final flush
        for task in (*triggers, *watchdogs):
            with suppress(asyncio.CancelledError):
                await task
        await deps._registry.aclose()
        deps._registry = None
```

- [ ] **Step 6: Verify the app still boots + full backend suite**

Run: `cd backend && python -c "from auto_trader.api.app import app" && python -m pytest tests/test_mt5_idle_watchdog.py tests/test_api_mt5_deploy.py tests/test_mt5_idle_undeploy.py -v`
Expected: import succeeds (no NameError for `HTTPException`); all listed tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/deps.py backend/auto_trader/api/app.py backend/tests/test_mt5_idle_watchdog.py
git commit -m "feat(mt5): idle watchdog auto-undeploys unused MetaApi account

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

### Task 4: Frontend API — surface `idle_seconds_remaining`

**Files:**
- Modify: `frontend/src/api.ts:657-661` (`mt5DeployState` return type)

**Interfaces:**
- Produces: `mt5DeployState(): Promise<{ state: Mt5DeployState; detail: string | null; idle_seconds_remaining: number | null }>`.

- [ ] **Step 1: Update the return type + shape**

Replace `mt5DeployState` (lines 657-661) in `api.ts`:

```typescript
export async function mt5DeployState(): Promise<{
  state: Mt5DeployState;
  detail: string | null;
  idle_seconds_remaining: number | null;
}> {
  const res = await fetch(`${BASE}/api/mt5/deploy-state`);
  if (!res.ok) throw new Error(`mt5 deploy state: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no new errors from this file). Note: `Mt5DeployButton.tsx` currently destructures only `{ state }` from this call — still valid; Task 5 extends it.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(ui): mt5DeployState surfaces idle_seconds_remaining

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

### Task 5: Move the toggle into the dock, gate on MT5, show the countdown

**Files:**
- Modify: `frontend/src/Mt5DeployButton.tsx` (poll seeds a `remaining` state; local 1s ticker; render countdown when `on`)
- Modify: `frontend/src/PositionsPanel.tsx` (render `<Mt5DeployButton />` in `pp-bar`, gated on `activeBroker === "mt5"`; import it)
- Modify: `frontend/src/Toolbar.tsx:632` (remove `<Mt5DeployButton />` + its import)
- Modify: `frontend/src/SnapshotToolbar.tsx:91` (remove `<Mt5DeployButton />` + its import)

**Interfaces:**
- Consumes: `mt5DeployState()` now returns `idle_seconds_remaining` (Task 4); `PositionsPanel` already has `activeBroker = brokerOf(account)` in scope (line 187).
- Produces: `<Mt5DeployButton />` mounted once, only inside the dock, only when MT5 is the active broker.

- [ ] **Step 1: Add countdown state + ticker to `Mt5DeployButton`**

In `Mt5DeployButton.tsx`, add a `remaining` state and seed it from every poll. After the existing `const [state, setState] = ...` (line 16-17) add:

```tsx
  // Idle-undeploy countdown (seconds), seeded from each poll's idle_seconds_remaining
  // and ticked down locally between polls; the server resets it on MT5 activity, so a
  // poll can jump it back up. null → no countdown (not deployed / not reported).
  const [remaining, setRemaining] = useState<number | null>(null);
```

In the `poll` function (lines 37-49), capture the new field and store it. Replace the destructure + apply:

```tsx
      try {
        const { state: s, idle_seconds_remaining } = await mt5DeployState();
        if (!alive) return;
        const applied = applyState(s, gen);
        if (applied) setRemaining(s === "on" ? idle_seconds_remaining : null);
        if (applied && s === "unconfigured") return; // nothing to manage; stop the loop
        const cur = mt5DeployStateSignal.value;
        timer = setTimeout(poll, cur === "turning-on" || cur === "turning-off" ? 5000 : 12000);
      } catch {
        if (alive) timer = setTimeout(poll, 12000); // transient error: keep trying
      }
```

Add a local 1s ticker effect (after the poll effect, ~line 55):

```tsx
  // Tick the countdown down locally between polls so it reads smoothly; the poll
  // re-syncs it (and resets on activity). Only runs while a countdown is showing.
  useEffect(() => {
    if (remaining == null) return;
    const id = setInterval(() => setRemaining((r) => (r == null ? r : Math.max(0, r - 1))), 1000);
    return () => clearInterval(id);
  }, [remaining == null]);
```

Add a formatter helper above the component (below the imports):

```tsx
// mm:ss for the idle countdown.
function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Render the countdown in the `on` state**

In the `state === "on"` block (lines 121-133), add the countdown between the label and the Stop button:

```tsx
  if (state === "on") {
    return (
      <span className="compute-host-btn is-on" aria-live="polite">
        <span className="compute-host-dot" aria-hidden="true" />
        <span>MT5 ON</span>
        {remaining != null && (
          <Tooltip content="Auto-undeploys when idle to stop hosting cost; using MT5 resets this.">
            <span className="compute-host-countdown" aria-label={`auto-undeploy in ${fmtCountdown(remaining)}`}>
              {fmtCountdown(remaining)}
            </span>
          </Tooltip>
        )}
        <Tooltip content="Undeploy the MetaApi account to pause its hosting cost. Open positions stay open at the broker.">
          <button type="button" className="compute-host-stop" onClick={onStop}>
            Stop
          </button>
        </Tooltip>
      </span>
    );
  }
```

- [ ] **Step 3: Render inside the dock, gated on MT5**

In `PositionsPanel.tsx`, add the import near the other component imports (top of file):

```tsx
import Mt5DeployButton from "./Mt5DeployButton";
```

In the `pp-bar` block, render the toggle after the broker-identity span (line 682, `<span className="pp-acct-broker">…</span>`), gated on the active broker:

```tsx
        <span className="pp-acct-broker">{brokerLabel(activeBroker)}</span>
        {activeBroker === "mt5" && <Mt5DeployButton />}
```

- [ ] **Step 4: Remove the toggle from both toolbars**

In `Toolbar.tsx`: delete the `<Mt5DeployButton />` line (632) and remove its `import Mt5DeployButton from "./Mt5DeployButton";` line.
In `SnapshotToolbar.tsx`: delete the `<Mt5DeployButton />` line (91) and remove its import.

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: PASS — no unused-import errors (both toolbar imports removed), no type errors.

- [ ] **Step 6: Manual verification (real app)**

Follow the `verify` skill / run the app. Confirm:
- With Capital/IG selected: no MT5 toggle anywhere (toolbar or dock).
- With MT5 selected + MetaApi configured: toggle appears in the dock's account strip.
- When deployed: `MT5 ON` shows a `mm:ss` countdown that ticks down; interacting with MT5 (a data read) jumps it back up on the next poll.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/Mt5DeployButton.tsx frontend/src/PositionsPanel.tsx frontend/src/Toolbar.tsx frontend/src/SnapshotToolbar.tsx
git commit -m "feat(ui): MT5 toggle lives in the dock (MT5-only) with idle countdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

### Task 6: Countdown styling

**Files:**
- Modify: the stylesheet defining `.compute-host-btn` / `.compute-host-stop` (find with `grep -rn "compute-host-stop" frontend/src`)

**Interfaces:**
- Consumes: `.compute-host-countdown` class rendered in Task 5.

- [ ] **Step 1: Locate the compute-host styles**

Run: `cd frontend && grep -rln "compute-host-btn" src`
Open the file it reports (the shared toolbar/pill stylesheet).

- [ ] **Step 2: Add a minimal, theme-consistent rule**

Add next to the existing `.compute-host-*` rules — a compact monospace-ish numeric chip that reads as secondary to the ON pill (match the surrounding tokens/vars; do not hardcode a new palette):

```css
.compute-host-countdown {
  font-variant-numeric: tabular-nums;
  font-size: 0.72rem;
  opacity: 0.8;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src
git commit -m "style(ui): compact idle countdown chip on the MT5 ON pill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014LEVKstoHTENJVKQmU9uCB"
```

---

## Self-Review

**Spec coverage:**
- Idle-based countdown, 30 min, resets on activity → Task 1 (`_last_use` touched in `_bounded`, `_idle_timeout` from env).
- Undeploy anyway (no position guard) → Task 3 tick calls `pause()` unconditionally past deadline.
- Dock placement, MT5-only → Task 5 (`pp-bar`, `activeBroker === "mt5"` gate; removed from both toolbars).
- UI countdown → Task 5 (render + ticker) + Task 6 (style).
- API `idle_seconds_remaining` → Task 2.
- Watchdog lifespan task, spawned only when MT5 configured, ~30s → Task 3.
- Env `MT5_IDLE_UNDEPLOY_SECS` default 1800 → Task 1 constant.
- Testing (idle calc, watchdog tick, API field) → Tasks 1-3 tests.

**Deviation from spec (intentional):** the spec's step 4 mentioned broadcasting the auto-undeploy on `/ws/state`. The toggle updates via its existing poll (≤12s) and does not consume `/ws/state` for deploy status, so no consumer exists for such a broadcast — dropped to avoid dead code. Documented here and to the user.

**Placeholder scan:** none — every code step has concrete content.

**Type consistency:** `seconds_until_idle_undeploy` (int, sync), `_mt5_idle_tick` (async, bool), `_run_mt5_idle_watchdog` (async, None), `idle_seconds_remaining` (int | null) used consistently across backend/API/frontend tasks.

**Note on snapshot view:** removing the toggle from `SnapshotToolbar` means it is not shown while viewing a read-only snapshot (which has no trading dock). Acceptable: the new idle watchdog handles the "left it deployed" cost risk that the always-visible pill previously guarded against.
