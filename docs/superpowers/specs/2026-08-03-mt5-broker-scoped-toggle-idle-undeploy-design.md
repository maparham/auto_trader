# MT5 Broker-Scoped Toggle + Idle Auto-Undeploy

**Date:** 2026-08-03
**Status:** Approved

## Problem

Two issues with the current MT5 deploy/undeploy toggle:

1. **Placement.** The `Mt5DeployButton` renders in the global chart toolbar
   regardless of which broker is selected. It should only appear when MT5 is the
   active broker, and it belongs in the bottom dock's account strip — the place
   that already shows broker identity and env tabs.
2. **Cost.** A deployed MetaApi account incurs cloud-hosting billing even when
   idle. There is no mechanism to stop hosting automatically, so a forgotten
   deployment keeps costing money.

## Decisions (locked)

- **Idle-based countdown**, default 30 min, **resets on genuine MT5 activity**
  (data reads / trading ops) — not on status polls.
- **Undeploy anyway** when the timer expires — no open-position guard.
  Positions live at the broker; undeploy only stops MetaApi hosting/billing.
- **Dock strip placement**, visible **only when MT5 is the active broker**.
- **UI countdown shown** in the dock beside the pill when deployed.
- Poll interval ~30s; timeout env-configurable, default 1800s.

## Current state (as-is)

- `frontend/src/Mt5DeployButton.tsx` — self-contained, broker-agnostic, driven by
  the global `mt5DeployStateSignal`. Owns its own poll loop. Self-hides on
  `unconfigured`.
- Rendered at `frontend/src/Toolbar.tsx:632` and
  `frontend/src/SnapshotToolbar.tsx:91` (always shown).
- `frontend/src/PositionsPanel.tsx` — the bottom dock; its `pp-bar` account strip
  (~line 673) already has `activeBroker`/`account` in scope and renders the
  broker label + env tabs.
- Selected broker derives from `activeAccount` in `App.tsx` via
  `brokerOf(activeAccount)`; threaded as props (no broker signal).
- `backend/auto_trader/brokers/mt5.py` — `MT5Broker` with `deploy_state()`,
  `pause()` (undeploy), `resume()` (deploy). `_bounded()` runs genuine ops and
  fast-fails when paused; `_ensure()` handles lazy reconnect and raises
  `MT5PausedError`.
- `backend/auto_trader/api/routers/mt5.py` — `GET /api/mt5/deploy-state`
  (`b.deploy_state()`), `POST /api/mt5/deploy` (`b.resume()`), `POST
  /api/mt5/undeploy` (`b.pause()`).
- No scheduler. Background work = asyncio tasks spawned in the FastAPI lifespan
  (`app.py`), cancelled on shutdown. Canonical loop: `deps._run_paper_triggers`.

## Design

### 1. Frontend — relocate & gate the toggle

- Remove `<Mt5DeployButton />` from `Toolbar.tsx:632` and `SnapshotToolbar.tsx:91`.
- Render it inside `PositionsPanel.tsx`'s `pp-bar` account strip, near the broker
  label.
- Gate on `brokerOf(account) === "mt5"`. Composes with the existing
  `unconfigured` self-hide (MT5 selected **and** MetaApi configured).
- Result: toggle absent for Capital/IG; present in the dock only under MT5.

### 2. Frontend — live countdown display

- The deploy-state response gains `idle_seconds_remaining` (int | null).
- When state is `on`, render a compact countdown beside the pill
  (e.g. `MT5 ON · 29:12`). `Mt5DeployButton` seeds remaining seconds from each
  poll and ticks down locally between polls; re-syncs (jumps back up) when
  activity resets the server-side timer. No countdown when `off`/`turning-*`.
- Extend `mt5DeployStateSignal` (or an adjacent field) to carry remaining seconds.

### 3. Backend — MT5-specific idle tracking

- Add `_last_use: float` (`time.monotonic()`) to `MT5Broker`.
- Touch `_last_use` **only on genuine data/trading operations** in `_bounded()`.
  Do **not** touch it in `deploy_state()` (frontend status polling must not keep
  the account alive) or on internal reconnect attempts.
- `resume()` seeds `_last_use = now` so a fresh deploy gets a full grace window.
- New method `seconds_until_idle_undeploy() -> int | None`: remaining seconds
  when deployed, else `None`.

### 4. Backend — the watchdog loop

- New lifespan task `_run_mt5_idle_watchdog(broker)` in `app.py`, spawned only
  when an `mt5` data broker exists, mirroring `_run_paper_triggers`:
  `while True: await asyncio.sleep(interval)` wrapped in try/except that logs.
- Each tick: if deployed **and**
  `now - _last_use > MT5_IDLE_UNDEPLOY_SECS` → `await broker.pause()`, then
  broadcast the state change so the dock updates.
- `MT5_IDLE_UNDEPLOY_SECS` env var, default `1800`. Poll interval ~30s.
- Alternative considered: broker-owned task started/stopped in resume/pause.
  Rejected — the lifespan task matches the existing idiom and keeps scheduler
  concerns out of the broker.

### 5. API change

- `GET /api/mt5/deploy-state` response gains `idle_seconds_remaining` (int | null).
- `/deploy` and `/undeploy` unchanged. No open-position guard.

## Testing

- Backend unit tests:
  - `seconds_until_idle_undeploy()`: touch resets; elapsed time decrements;
    reaches zero; returns `None` when not deployed.
  - Watchdog tick calls `pause()` once past the deadline, no-ops before it and
    when not deployed.
  - `test_api_mt5_deploy.py` extended for the `idle_seconds_remaining` field.
- Frontend:
  - Toggle mounts only when active broker is `mt5`.
  - Countdown renders when `on`, absent otherwise.

## Out of scope

- No manual "extend" button (activity auto-extends).
- No open-position guard.
- No change to `/deploy` or `/undeploy` semantics beyond the new read field.
