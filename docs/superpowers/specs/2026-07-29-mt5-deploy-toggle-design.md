# MT5 (MetaApi) deploy/undeploy toggle

**Date:** 2026-07-29
**Goal:** Turn the MetaApi cloud account on/off from the app UI to save MetaApi
hosting cost, without visiting app.metaapi.cloud. Undeploy is MetaApi's pause:
the account record survives, billing stops while undeployed, redeploy takes
~1–2 minutes.

## Problem

Today the backend *auto-deploys* the account: `MT5Broker._ensure()`
(`backend/auto_trader/brokers/mt5.py:342`) calls `acct.deploy()` whenever the
account is not `DEPLOYING`/`DEPLOYED`. Any background poll (positions strip,
broker list, chart data) that touches MT5 would silently re-deploy an account
the user just turned off — and billing resumes. `aclose()` also deliberately
never undeploys. So a toggle needs the backend to *respect* the off state, not
just call undeploy once.

## Design

### Source of truth: MetaApi account state (no local persistence)

MetaApi's account state (`DEPLOYED` / `DEPLOYING` / `UNDEPLOYED` /
`UNDEPLOYING`) is durable on their side, so it survives our backend restarts
for free. No local flag file.

- **Off = UNDEPLOYED at MetaApi.** `_ensure()` changes from "deploy if not
  running" to "**raise `MT5PausedError` if not running**". Auto-deploy is
  removed entirely; deployment only ever happens through the explicit resume
  endpoint. If MetaApi reports the account undeployed — whether we paused it,
  the dashboard did, or their side did — the app treats it as paused and does
  not spend money to heal it.
- No extra cache is needed: the SDK account object already tracks `state`
  locally, so `_ensure()` checks that first and only issues a MetaApi REST
  `reload()` when it reads "not running" (to notice a dashboard-side
  redeploy before raising). While paused, the shared circuit breaker
  throttles repeated calls.

### Backend: `MT5Broker` methods

New public methods on `MT5Broker` (mt5.py):

- `async deploy_state() -> str` — fetch fresh account state from MetaApi, map
  to `"on" | "turning-on" | "off" | "turning-off"`
  (`DEPLOYED→on, DEPLOYING→turning-on, UNDEPLOYING→turning-off, else off`),
  update `_paused` cache.
- `async pause()` — close/drop the RPC connection (`_synced=False`,
  `_conn=None`), call `await self._acct.undeploy()`, set `_paused=True`.
  Idempotent: no-op if already undeployed/undeploying.
- `async resume()` — set `_paused=False`, call `await self._acct.deploy()` if
  needed. Returns immediately (does not wait for sync); the normal `_ensure()`
  path reconnects lazily on next use, and the UI observes progress via
  `deploy_state()` polling.

`MT5PausedError` is a small exception type; MT5-dependent endpoints surface it
via the existing `guarded(...)` error path with a clear
"MetaApi account is paused" detail (no special-casing per endpoint).

### Backend: router

New endpoints in a new `backend/auto_trader/api/routers/mt5.py` (auto-mounted
like the others), mirroring the compute-host trio in `compute.py`:

- `GET  /api/mt5/deploy-state` → `{"state": "on"|"turning-on"|"off"|"turning-off"|"unconfigured", "detail": str|null}`
- `POST /api/mt5/deploy`   → resume, return fresh state payload
- `POST /api/mt5/undeploy` → pause, return fresh state payload

`unconfigured` when `mt5_settings.has()` is false (mirrors compute's
unconfigured state). Broker instance obtained via `deps.get_data("mt5")`.

### Trading coordination (scope decision)

Minimal, deliberate coordination — no strategy disarming:

- While paused, any MT5 data/exec call fails fast with `MT5PausedError`
  ("MetaApi account is paused"). Armed live strategies stay armed; their
  execution attempts fail with that clear error through existing error
  handling, and resume working after redeploy.
- **Undeploy does NOT close open positions at the broker** — they remain open
  and unmanaged. The UI confirm dialog states this explicitly.

### Frontend

- `frontend/src/api.ts`: `mt5DeployState()`, `deployMt5()`, `undeployMt5()` —
  mirroring `computeHostState/startComputeHost/stopComputeHost`
  (api.ts:627-648).
- `frontend/src/Mt5DeployButton.tsx`: clone of `ComputeHostButton.tsx` —
  toolbar pill labelled "MT5", showing on/off/transition state, optimistic
  update + generation-guarded setTimeout poll (fast cadence ~5s during
  transitions, slow ~12s idle). Hidden when state is `unconfigured`.
- **Turning off requires confirmation** (native `confirm()` is fine): warns
  that price data and trading stop, and open positions stay open at the broker
  unmanaged.
- Mounted next to `ComputeHostButton` in `Toolbar.tsx:630` and
  `SnapshotToolbar.tsx:89`.

## Error handling

- MetaApi REST errors in deploy-state/pause/resume → HTTP 502 with the SDK
  error detail (same convention as other broker endpoints).
- `_ensure()` raising `MT5PausedError` flows through `guarded(...)`; the
  circuit breaker treats it like other broker failures (90s budget), which is
  acceptable — while paused everything MT5 fails anyway.

## Testing

- Unit tests for `_ensure()`: paused account → raises `MT5PausedError`, does
  NOT call `deploy()`; deployed account → connects as before. (Mock the SDK
  account object; existing mt5 tests show the mocking pattern.)
- Unit tests for state mapping in `deploy_state()` and idempotency of
  `pause()`/`resume()`.
- Router tests: unconfigured → `unconfigured`; deploy/undeploy call through to
  the broker methods.
- Manual verification: toggle off in UI → account shows Undeployed in the
  MetaApi dashboard, positions strip shows the paused error, no auto-redeploy
  after several poll cycles; toggle on → reconnects and data resumes.

## Out of scope (YAGNI)

- Auto-disarming/re-arming live strategies on pause/resume.
- Scheduled on/off (e.g. undeploy outside market hours) — natural follow-up.
- Local persistence of the pause flag (MetaApi state is the source of truth).
