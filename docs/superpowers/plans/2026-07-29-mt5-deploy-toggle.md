# MT5 (MetaApi) Deploy/Undeploy Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A toolbar toggle that undeploys/redeploys the MetaApi cloud account so its hosting billing can be paused from the app, with the backend never auto-deploying behind the user's back.

**Architecture:** MetaApi's own account state (`DEPLOYED`/`UNDEPLOYED`/…) is the source of truth — no local persistence. `MT5Broker._ensure()` loses its auto-`deploy()` and instead raises `MT5PausedError` when the account isn't running. Three new endpoints (`GET /api/mt5/deploy-state`, `POST /api/mt5/deploy`, `POST /api/mt5/undeploy`) mirror the compute-host trio in `compute.py`, and a `Mt5DeployButton` toolbar pill mirrors `ComputeHostButton.tsx`.

**Tech Stack:** FastAPI backend (`backend/auto_trader/`), `metaapi_cloud_sdk` Python SDK, React 19 + TypeScript frontend (`frontend/src/`), pytest, plain `fetch` + Signal-based state.

**Spec:** `docs/superpowers/specs/2026-07-29-mt5-deploy-toggle-design.md`. One deviation, decided during planning: the spec's in-memory `_paused` cache is dropped. `_ensure()` short-circuits on the SDK account object's locally-tracked `state` and only issues a MetaApi REST `reload()` when that state says "not running" (to notice a dashboard-side redeploy); while paused, the shared circuit breaker (`deps.BROKER_HEALTH`) throttles repeated calls anyway. Same behavior, less state.

## Global Constraints

- Backend tests run from `backend/`: `cd backend && python -m pytest tests/<file> -v`
- Frontend typecheck+build: `cd frontend && npm run build`
- Routers are mounted via the EXPLICIT tuple in `backend/auto_trader/api/app.py:114` — a new router module must be imported and added there.
- UI state strings (backend → frontend): `"unconfigured" | "off" | "turning-on" | "turning-off" | "on"` — exactly these, everywhere.
- MetaApi SDK account states: `DEPLOYED`, `DEPLOYING`, `UNDEPLOYED`, `UNDEPLOYING` (also `CREATED`, `DELETING` — anything not deployed/deploying maps to `"off"`).
- Never call `acct.deploy()` outside `MT5Broker.resume()` — auto-deploying re-starts billing silently, which is the exact bug this feature removes.
- Frontend reuses the existing `compute-host-btn` CSS classes (`frontend/src/App.css:3318`) — no new CSS.

---

### Task 1: `MT5PausedError` + remove auto-deploy from `_ensure()`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` (class `MT5Broker`, `_ensure()` at ~line 342)
- Test: `backend/tests/test_mt5_deploy.py` (new file)

**Interfaces:**
- Produces: `MT5PausedError` (exception, importable from `auto_trader.brokers.mt5`); `MT5Broker._account_unlocked()` (async, caller holds `_lock`, returns the SDK account handle); `MT5Broker._account_handle()` (async, locked wrapper for external callers — Task 2 uses it).
- Consumes: existing `MT5Broker.__init__(*, token, account_id, region="london")`, `_lock`, `_api`, `_acct`, `_quiet_sdk_logging()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_mt5_deploy.py`:

```python
"""Deploy-lifecycle tests: the account must NEVER be auto-deployed (deploying
re-starts MetaApi billing) — a paused (undeployed) account raises MT5PausedError
from _ensure(); only the explicit resume() deploys."""

import asyncio

import pytest

from auto_trader.brokers.mt5 import MT5Broker, MT5PausedError


class _FakeAcct:
    """SDK MetatraderAccount stand-in. `state` mirrors the SDK's locally-tracked
    attribute; `reload()` refreshes it from `reload_state` (what MetaApi's REST
    API would report)."""

    def __init__(self, state="UNDEPLOYED", reload_state=None):
        self.state = state
        self._reload_state = reload_state if reload_state is not None else state
        self.deploy_calls = 0
        self.undeploy_calls = 0
        self.reload_calls = 0

    async def reload(self):
        self.reload_calls += 1
        self.state = self._reload_state

    async def deploy(self):
        self.deploy_calls += 1
        self.state = "DEPLOYING"

    async def undeploy(self):
        self.undeploy_calls += 1
        self.state = "UNDEPLOYING"


def _broker(acct) -> MT5Broker:
    b = MT5Broker(token="t", account_id="a")
    b._api = object()  # sentinel: skips MetaApi client construction in _ensure
    b._acct = acct
    return b


def test_ensure_raises_paused_instead_of_deploying():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    with pytest.raises(MT5PausedError):
        asyncio.run(broker._ensure())
    assert acct.deploy_calls == 0  # the whole point: no silent re-deploy
    assert acct.reload_calls == 1  # one reload to notice a dashboard redeploy


def test_ensure_reload_detects_external_redeploy():
    # Stale local state says UNDEPLOYED but MetaApi reports DEPLOYED (user hit
    # deploy in the dashboard): _ensure must proceed past the pause gate. It
    # then fails on the fake's missing wait_connected — that's fine; the gate
    # not raising MT5PausedError is what's under test.
    acct = _FakeAcct(state="UNDEPLOYED", reload_state="DEPLOYED")
    broker = _broker(acct)
    with pytest.raises(AttributeError):  # _FakeAcct has no wait_connected
        asyncio.run(broker._ensure())
    assert acct.deploy_calls == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_mt5_deploy.py -v`
Expected: FAIL with `ImportError: cannot import name 'MT5PausedError'`

- [ ] **Step 3: Implement**

In `backend/auto_trader/brokers/mt5.py`, add after the module-level imports/logger (near the top, after `log = logging.getLogger(...)`):

```python
class MT5PausedError(RuntimeError):
    """The MetaApi account is deliberately undeployed — paused to stop MetaApi
    hosting billing. Raised instead of auto-deploying: only the explicit deploy
    endpoint (or the MetaApi dashboard) turns the account back on."""
```

In class `MT5Broker`, add the two account-handle helpers directly above `_ensure()`:

```python
    async def _account_unlocked(self):
        """Client + account handle, no deploy, no connect. Caller holds _lock."""
        if self._api is None:
            _quiet_sdk_logging()
            # MetaApi spawns background asyncio tasks in __init__, so it must be
            # constructed inside a running loop (never at import time). The Python
            # SDK auto-discovers the account's hosting region — passing a `region`
            # option is explicitly discouraged (it triggers subscribe timeouts on
            # the wrong socket), so `_region` is retained for reference only.
            self._api = MetaApi(self._token)
        if self._acct is None:
            self._acct = await self._api.metatrader_account_api.get_account(self._account_id)
        return self._acct

    async def _account_handle(self):
        """Locked account handle for lifecycle callers (deploy_state/pause/resume)."""
        async with self._lock:
            return await self._account_unlocked()
```

Rewrite the middle of `_ensure()` (inside the `async with self._lock:` block) to use the helper and to REPLACE the auto-deploy with the pause gate. The block currently reading

```python
            if self._api is None:
                _quiet_sdk_logging()
                # MetaApi spawns background asyncio tasks in __init__, ...
                self._api = MetaApi(self._token)
            if self._acct is None:
                self._acct = await self._api.metatrader_account_api.get_account(self._account_id)
            # Account must be running in MetaApi's cloud; deploy if it isn't.
            if self._acct.state not in ("DEPLOYING", "DEPLOYED"):
                await self._acct.deploy()
            await self._acct.wait_connected()
```

becomes

```python
            acct = await self._account_unlocked()
            # NEVER auto-deploy: deploying re-starts MetaApi billing, and the
            # user may have undeployed on purpose (the cost toggle). The local
            # `state` can be stale, so reload once — the dashboard/API may have
            # redeployed since this handle was fetched.
            if acct.state not in ("DEPLOYING", "DEPLOYED"):
                await acct.reload()
                if acct.state not in ("DEPLOYING", "DEPLOYED"):
                    raise MT5PausedError(
                        "MetaApi account is paused (undeployed) — "
                        "turn MT5 on in the toolbar to resume"
                    )
            await self._acct.wait_connected()
```

(The rest of `_ensure()` — `wait_connected`, `get_rpc_connection`, `wait_synchronized(120)` — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_mt5_deploy.py -v`
Expected: 2 PASS

- [ ] **Step 5: Run the existing mt5 suites (regression)**

Run: `cd backend && python -m pytest tests/test_mt5.py tests/test_mt5_stream.py tests/test_mt5_hours.py tests/test_mt5_expiry.py tests/test_mt5_expiry_replace.py tests/test_trading_reconnect.py tests/test_registry.py -q`
Expected: all PASS (these stub the read path past `_ensure`; if one constructed a broker relying on auto-deploy, fix the test's fake account to report `state="DEPLOYED"`).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/brokers/mt5.py backend/tests/test_mt5_deploy.py
git commit -m "feat(mt5): never auto-deploy — paused account raises MT5PausedError"
```

---

### Task 2: `deploy_state()` / `pause()` / `resume()` on `MT5Broker`

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py` (class `MT5Broker`; also `aclose()` docstring at ~line 694)
- Test: `backend/tests/test_mt5_deploy.py` (extend)

**Interfaces:**
- Consumes: `_account_handle()` from Task 1; existing `_conn`/`_synced`/`_stream_conn`/`_stream_synced`/`CLOSE_BUDGET` teardown fields used by `aclose()`.
- Produces: `async MT5Broker.deploy_state() -> str`, `async MT5Broker.pause() -> str`, `async MT5Broker.resume() -> str` — each returning one of `"on" | "turning-on" | "turning-off" | "off"`. Task 3's router calls exactly these.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_mt5_deploy.py`:

```python
def test_deploy_state_maps_sdk_states():
    for sdk_state, ui in [
        ("DEPLOYED", "on"),
        ("DEPLOYING", "turning-on"),
        ("UNDEPLOYING", "turning-off"),
        ("UNDEPLOYED", "off"),
        ("CREATED", "off"),
    ]:
        broker = _broker(_FakeAcct(state=sdk_state))
        assert asyncio.run(broker.deploy_state()) == ui, sdk_state


def test_pause_undeploys_and_drops_connection():
    acct = _FakeAcct(state="DEPLOYED")
    broker = _broker(acct)
    broker._synced = True  # pretend a live RPC connection existed
    state = asyncio.run(broker.pause())
    assert acct.undeploy_calls == 1
    assert state == "turning-off"
    assert broker._synced is False and broker._conn is None


def test_pause_is_idempotent_when_already_off():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    assert asyncio.run(broker.pause()) == "off"
    assert acct.undeploy_calls == 0


def test_resume_deploys_only_when_needed():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    assert asyncio.run(broker.resume()) == "turning-on"
    assert acct.deploy_calls == 1

    already = _FakeAcct(state="DEPLOYED")
    broker2 = _broker(already)
    assert asyncio.run(broker2.resume()) == "on"
    assert already.deploy_calls == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_mt5_deploy.py -v`
Expected: new tests FAIL with `AttributeError: 'MT5Broker' object has no attribute 'deploy_state'`

- [ ] **Step 3: Implement**

In `backend/auto_trader/brokers/mt5.py`, module level (next to `MT5PausedError`):

```python
# MetaApi account states → the UI vocabulary the frontend pill renders.
# Anything not deployed/deploying (UNDEPLOYED, CREATED, DELETING, …) is "off".
_DEPLOY_STATE_UI = {
    "DEPLOYED": "on",
    "DEPLOYING": "turning-on",
    "UNDEPLOYING": "turning-off",
}


def _ui_deploy_state(sdk_state: str) -> str:
    return _DEPLOY_STATE_UI.get(sdk_state, "off")
```

In class `MT5Broker`, extract the connection-teardown lines that `aclose()` already contains into a helper, and add the three lifecycle methods (place them right after `_account_handle()`):

```python
    async def _close_connections(self) -> None:
        """Drop + close the RPC and stream connections, BOUNDED (shared by
        aclose and pause)."""
        conn, self._conn, self._synced = self._conn, None, False
        stream, self._stream_conn, self._stream_synced = self._stream_conn, None, False
        for c in (conn, stream):
            if c is not None:
                try:
                    await asyncio.wait_for(c.close(), self.CLOSE_BUDGET)
                except Exception:  # best-effort teardown
                    log.debug("mt5: error closing connection", exc_info=True)

    # --- deploy lifecycle (the cost toggle) ------------------------------------
    # Undeployed MetaApi accounts don't bill; the account record survives and a
    # redeploy takes ~1-2 min. MetaApi's own account state is the source of
    # truth (it survives our restarts), so there is no local paused flag.

    async def deploy_state(self) -> str:
        """Fresh deploy state from MetaApi, mapped to the UI vocabulary."""
        acct = await self._account_handle()
        await acct.reload()
        return _ui_deploy_state(acct.state)

    async def pause(self) -> str:
        """Undeploy the account (stops MetaApi billing) and drop our
        connections so nothing holds a socket to a dying terminal. Idempotent."""
        acct = await self._account_handle()
        await self._close_connections()
        await acct.reload()
        if acct.state in ("DEPLOYED", "DEPLOYING"):
            await acct.undeploy()
        return _ui_deploy_state(acct.state)

    async def resume(self) -> str:
        """Deploy the account if it isn't running. Returns without waiting for
        sync — _ensure() reconnects lazily on next use and the UI watches
        progress via deploy_state() polling. Idempotent."""
        acct = await self._account_handle()
        await acct.reload()
        if acct.state not in ("DEPLOYED", "DEPLOYING"):
            await acct.deploy()
        return _ui_deploy_state(acct.state)
```

In `aclose()` (~line 694), replace the four teardown lines

```python
        conn, self._conn, self._synced = self._conn, None, False
        stream, self._stream_conn, self._stream_synced = self._stream_conn, None, False
        for c in (conn, stream):
            if c is not None:
                try:
                    await asyncio.wait_for(c.close(), self.CLOSE_BUDGET)
                except Exception:  # best-effort on shutdown
                    log.debug("mt5: error closing connection", exc_info=True)
```

with

```python
        await self._close_connections()
```

and update its docstring's last-sentence claim `deployment is managed in the MetaApi dashboard, not per process` to `deployment is managed via the MT5 toolbar toggle (/api/mt5/*) or the MetaApi dashboard, not per process`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_mt5_deploy.py tests/test_mt5.py tests/test_mt5_stream.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/mt5.py backend/tests/test_mt5_deploy.py
git commit -m "feat(mt5): deploy_state/pause/resume lifecycle methods on MT5Broker"
```

---

### Task 3: `/api/mt5/*` router

**Files:**
- Create: `backend/auto_trader/api/routers/mt5.py`
- Modify: `backend/auto_trader/api/app.py:114` (router tuple + import)
- Test: `backend/tests/test_api_mt5_deploy.py` (new file)

**Interfaces:**
- Consumes: `deps.get_data("mt5")` (raises `HTTPException(404)` when MetaApi isn't configured — that IS the unconfigured signal); Task 2's `deploy_state()/pause()/resume()`.
- Produces: `GET /api/mt5/deploy-state`, `POST /api/mt5/deploy`, `POST /api/mt5/undeploy` — all returning `{"state": "unconfigured"|"off"|"turning-on"|"turning-off"|"on", "detail": str|null}`. MetaApi/SDK failures → HTTP 502 with detail `"MetaApi error: <exc>"`. Task 4's frontend wrappers call exactly these.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_mt5_deploy.py`:

```python
"""MT5 deploy-lifecycle endpoints: unconfigured mapping, pass-through to the
broker's deploy_state/pause/resume, and 502 on MetaApi errors."""
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)

_GET_DATA = "auto_trader.api.routers.mt5.deps.get_data"


def _broker(**async_returns) -> AsyncMock:
    b = AsyncMock()
    for name, value in async_returns.items():
        getattr(b, name).return_value = value
    return b


def test_unconfigured_when_registry_has_no_mt5():
    with patch(_GET_DATA, side_effect=HTTPException(404, "unknown broker: mt5")):
        body = client.get("/api/mt5/deploy-state").json()
    assert body == {"state": "unconfigured", "detail": None}


def test_deploy_state_passthrough():
    broker = _broker(deploy_state="on")
    with patch(_GET_DATA, return_value=broker):
        assert client.get("/api/mt5/deploy-state").json() == {"state": "on", "detail": None}


def test_deploy_calls_resume():
    broker = _broker(resume="turning-on")
    with patch(_GET_DATA, return_value=broker):
        body = client.post("/api/mt5/deploy").json()
    broker.resume.assert_awaited_once()
    assert body["state"] == "turning-on"


def test_undeploy_calls_pause():
    broker = _broker(pause="turning-off")
    with patch(_GET_DATA, return_value=broker):
        body = client.post("/api/mt5/undeploy").json()
    broker.pause.assert_awaited_once()
    assert body["state"] == "turning-off"


def test_metaapi_error_is_502():
    broker = AsyncMock()
    broker.deploy_state.side_effect = RuntimeError("boom")
    with patch(_GET_DATA, return_value=broker):
        res = client.get("/api/mt5/deploy-state")
    assert res.status_code == 502
    assert "boom" in res.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_mt5_deploy.py -v`
Expected: FAIL — 404s on `/api/mt5/deploy-state` (router doesn't exist yet)

- [ ] **Step 3: Implement the router**

Create `backend/auto_trader/api/routers/mt5.py`:

```python
"""MetaApi (MT5) account deploy lifecycle: the cost toggle.

Undeploying stops MetaApi hosting billing; the account record survives and a
redeploy takes ~1-2 minutes. The broker NEVER auto-deploys (MT5Broker._ensure
raises MT5PausedError instead) — these endpoints are the only in-app path that
deploys the account. Mirrors the compute-host trio in compute.py."""

from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import APIRouter, HTTPException

from .. import deps

router = APIRouter()


async def _lifecycle(action: Callable[[object], Awaitable[str]]) -> dict:
    """Resolve the mt5 broker and run one lifecycle call. No mt5 in the
    registry means MetaApi env vars aren't set: report "unconfigured" (the
    frontend hides the pill) rather than erroring."""
    try:
        broker = deps.get_data("mt5")
    except HTTPException:
        return {"state": "unconfigured", "detail": None}
    try:
        return {"state": await action(broker), "detail": None}
    except Exception as exc:  # SDK error taxonomy is broad; surface verbatim
        raise HTTPException(502, f"MetaApi error: {exc}") from None


@router.get("/api/mt5/deploy-state")
async def mt5_deploy_state() -> dict:
    return await _lifecycle(lambda b: b.deploy_state())


@router.post("/api/mt5/deploy")
async def mt5_deploy() -> dict:
    return await _lifecycle(lambda b: b.resume())


@router.post("/api/mt5/undeploy")
async def mt5_undeploy() -> dict:
    """No open-position guard here: the frontend confirm warns that positions
    stay open at the broker; a deliberate stop wins (same stance as compute)."""
    return await _lifecycle(lambda b: b.pause())
```

In `backend/auto_trader/api/app.py`, add `mt5` to the routers import (same line/style as the existing `from .routers import markets, trading, ...` statement) and to the mount tuple at line ~114:

```python
for _module in (markets, trading, state, charts, backtest, compute, strategy, stream, strategies, costs, expr, mt5):
    app.include_router(_module.router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_mt5_deploy.py -v`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/mt5.py backend/auto_trader/api/app.py backend/tests/test_api_mt5_deploy.py
git commit -m "feat(api): /api/mt5 deploy-state/deploy/undeploy endpoints"
```

---

### Task 4: Frontend — API wrappers, signal, `Mt5DeployButton`, toolbar mounts

**Files:**
- Modify: `frontend/src/api.ts` (after the compute-host wrappers, ~line 650)
- Modify: `frontend/src/lib/signals.ts` (next to `computeHostStateSignal`, ~line 564)
- Create: `frontend/src/Mt5DeployButton.tsx`
- Modify: `frontend/src/Toolbar.tsx` (import ~line 59, mount ~line 630), `frontend/src/SnapshotToolbar.tsx` (import ~line 19, mount ~line 89)

**Interfaces:**
- Consumes: Task 3's endpoints; existing `Tooltip` (`./components/Tooltip`), `toast` (`./lib/notify`), `Signal` (`./lib/signals`), `BASE` (in `api.ts`), CSS classes `compute-host-btn is-on/is-off/is-booting`, `compute-host-dot`, `compute-host-start`, `compute-host-stop`, `chart-nodata-spinner`.
- Produces: `mt5DeployState()/deployMt5()/undeployMt5()` in `api.ts`; `mt5DeployStateSignal` + `Mt5DeployUiState` in `lib/signals.ts`; default-export `Mt5DeployButton` component.

- [ ] **Step 1: API wrappers**

In `frontend/src/api.ts`, directly after `stopComputeHost`:

```ts
// --- MetaApi (MT5) deploy toggle ------------------------------------------------
// Undeployed MetaApi accounts don't bill; the account record survives and a
// redeploy takes ~1-2 minutes. "unconfigured" (no MetaApi env vars) hides the pill.
export type Mt5DeployState = "unconfigured" | "off" | "turning-on" | "turning-off" | "on";

export async function mt5DeployState(): Promise<{ state: Mt5DeployState; detail: string | null }> {
  const res = await fetch(`${BASE}/api/mt5/deploy-state`);
  if (!res.ok) throw new Error(`mt5 deploy state: ${res.status}`);
  return res.json();
}

// Deploy (turn on). MetaApi errors surface as HTTP 502 with a `detail` body;
// unwrap that into the thrown Error so the caller can toast it verbatim.
export async function deployMt5(): Promise<{ state: Mt5DeployState }> {
  const res = await fetch(`${BASE}/api/mt5/deploy`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `deploy: ${res.status}`);
  return res.json();
}

// Undeploy (turn off / pause billing). Same 502-detail unwrap as deploy.
export async function undeployMt5(): Promise<{ state: Mt5DeployState }> {
  const res = await fetch(`${BASE}/api/mt5/undeploy`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `undeploy: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Signal**

In `frontend/src/lib/signals.ts`, after `computeHostJobsSignal`:

```ts
// MetaApi (MT5) account deploy state, polled by Mt5DeployButton. "unknown"
// until the first poll lands; "unconfigured" when MetaApi env vars aren't set
// (pill hidden). A signal (not component state) so both toolbars stay in sync
// and a remount doesn't flash the pill back to hidden.
export type Mt5DeployUiState =
  | "unknown" | "unconfigured" | "off" | "turning-on" | "turning-off" | "on";
export const mt5DeployStateSignal = new Signal<Mt5DeployUiState>("unknown");
```

(Do NOT add a subscribe-side-effect like the compute→sweep-target coupling — nothing else reacts to mt5 deploy state.)

- [ ] **Step 3: Component**

Create `frontend/src/Mt5DeployButton.tsx` (clone of `ComputeHostButton.tsx`, same generation-guard + poll structure):

```tsx
import { useEffect, useRef, useState } from "react";

import Tooltip from "./components/Tooltip";
import { toast } from "./lib/notify";
import { mt5DeployStateSignal, type Mt5DeployUiState } from "./lib/signals";
import { deployMt5, mt5DeployState, undeployMt5 } from "./api";

// Toolbar control for the MetaApi (MT5) cloud account — the cost toggle.
// Undeployed accounts don't bill, so the deployed state is impossible to miss:
// a filled amber "MT5 ON" pill with a Stop button while deployed, a subtle grey
// "MT5 off" + Start while undeployed, a spinner through the ~1-2 min
// deploy/undeploy transitions. Renders nothing when MetaApi isn't configured.
// Turning off confirms first: data + trading stop, and open positions stay
// open at the broker, unmanaged.
export default function Mt5DeployButton() {
  const [state, setState] = useState<Mt5DeployUiState>(mt5DeployStateSignal.value);
  useEffect(() => mt5DeployStateSignal.subscribe(setState), []);

  // Generation counter: a Start/Stop (and its error refresh) bumps it; any async
  // read only writes the signal if the generation it captured is still current.
  // Prevents a slow in-flight GET from repainting "ON" on an account the user
  // just undeployed (a false billing signal) until the next poll tick.
  const genRef = useRef(0);

  const applyState = (s: Mt5DeployUiState, gen: number) => {
    if (genRef.current !== gen) return false; // a newer action superseded this read
    mt5DeployStateSignal.set(s);
    return true;
  };

  // Background poll so the pill reflects reality (dashboard-side deploys, another
  // tab). setTimeout chain, not setInterval, so it stops cleanly on "unconfigured".
  // Faster cadence through transitions so "on"/"off" shows promptly.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const gen = genRef.current;
      try {
        const { state: s } = await mt5DeployState();
        if (!alive) return;
        const applied = applyState(s, gen);
        if (applied && s === "unconfigured") return; // nothing to manage; stop the loop
        const cur = mt5DeployStateSignal.value;
        timer = setTimeout(poll, cur === "turning-on" || cur === "turning-off" ? 5000 : 12000);
      } catch {
        if (alive) timer = setTimeout(poll, 12000); // transient error: keep trying
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // One-shot re-read after a failed action: for a cost signal, a false "off"
  // (or "on") must be corrected immediately, not 12s later.
  const refresh = async () => {
    const gen = (genRef.current += 1);
    try {
      const { state: s } = await mt5DeployState();
      applyState(s, gen);
    } catch {
      /* leave last-known state; the background poll will retry */
    }
  };

  const onStart = async () => {
    const gen = (genRef.current += 1);
    mt5DeployStateSignal.set("turning-on"); // optimistic; the return confirms
    try {
      const res = await deployMt5();
      applyState(res.state, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not deploy the MT5 account");
      void refresh();
    }
  };

  const doStop = async () => {
    const gen = (genRef.current += 1);
    mt5DeployStateSignal.set("turning-off"); // optimistic; the return confirms
    try {
      const res = await undeployMt5();
      applyState(res.state, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not undeploy the MT5 account");
      void refresh(); // a rejected stop must not show a false "off" (still billing)
    }
  };

  const onStop = () => {
    const ok = window.confirm(
      "Turn MT5 off?\n\nThis undeploys the MetaApi account: price data and order " +
        "execution stop until you turn it back on (~1-2 min to redeploy). Open " +
        "positions at the broker stay open — and unmanaged — while it's off.",
    );
    if (ok) void doStop();
  };

  if (state === "unknown" || state === "unconfigured") return null;

  if (state === "turning-on" || state === "turning-off") {
    return (
      <Tooltip
        content={
          state === "turning-on"
            ? "MT5 account is deploying (~1-2 min). Data and trading resume when it's up."
            : "MT5 account is undeploying. Billing stops once it's down."
        }
      >
        <span className="compute-host-btn is-booting" aria-live="polite">
          <span className="chart-nodata-spinner" aria-hidden="true" />
          <span>{state === "turning-on" ? "MT5 starting…" : "MT5 stopping…"}</span>
        </span>
      </Tooltip>
    );
  }

  if (state === "on") {
    return (
      <span className="compute-host-btn is-on" aria-live="polite">
        <span className="compute-host-dot" aria-hidden="true" />
        <span>MT5 ON</span>
        <Tooltip content="Undeploy the MetaApi account to pause its hosting cost. Open positions stay open at the broker.">
          <button type="button" className="compute-host-stop" onClick={onStop}>
            Stop
          </button>
        </Tooltip>
      </span>
    );
  }

  // off
  return (
    <span className="compute-host-btn is-off">
      <span>MT5 off</span>
      <Tooltip content="Deploy the MetaApi account (~1-2 min) to resume MT5 data and trading. Hosting billing runs while deployed.">
        <button type="button" className="compute-host-start" onClick={() => void onStart()}>
          Start
        </button>
      </Tooltip>
    </span>
  );
}
```

- [ ] **Step 4: Mounts**

In `frontend/src/Toolbar.tsx`: add `import Mt5DeployButton from "./Mt5DeployButton";` next to the `ComputeHostButton` import (~line 59), and render `<Mt5DeployButton />` directly after `<ComputeHostButton />` (~line 630). Same two edits in `frontend/src/SnapshotToolbar.tsx` (import ~line 19, mount ~line 89).

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend && npm run build`
Expected: `tsc -b` and `vite build` both succeed with no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/signals.ts frontend/src/Mt5DeployButton.tsx frontend/src/Toolbar.tsx frontend/src/SnapshotToolbar.tsx
git commit -m "feat(ui): MT5 deploy/undeploy toolbar toggle"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start backend + frontend** with real MetaApi env vars (`METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID` in `backend/.env`).

- [ ] **Step 2: Toggle off.** Click Stop on the MT5 pill, accept the confirm. Verify: pill goes "MT5 stopping…" → "MT5 off"; the account shows Undeployed at https://app.metaapi.cloud; the positions strip / MT5 charts surface a "MetaApi account is paused" error; after several poll cycles (≥1 min) the dashboard still shows Undeployed (nothing auto-redeployed — this is the money assertion).

- [ ] **Step 3: Toggle on.** Click Start. Verify: pill goes "MT5 starting…" → "MT5 ON" within ~2 min; MT5 charts and the positions strip recover without a backend restart.

- [ ] **Step 4: Restart persistence.** Toggle off, restart the backend, load the app. Verify: pill shows "MT5 off" and the dashboard still shows Undeployed (no deploy on startup or first request).
