# Admin Console Design

**Date:** 2026-09-11
**Status:** proposed

## 1. Goal

A single admin-only page at `/admin` on the hosted deployment that answers the
operator's four standing questions:

1. Who are my users? (Clerk user list)
2. Is the box healthy? (system health)
3. What is each user actually doing/storing? (per-user usage)
4. What just broke? (recent log lines and API errors)

Read-only. No mutations of any kind in this version: no ban, no delete, no
metadata writes, no job cancellation.

## 2. Non-goals

- Any write/destructive action against Clerk or against user data.
- Billing, plans, quotas, invitations, impersonation.
- A jobs/queue panel with cancel (deferred; the user deselected it).
- Historical/time-series metrics. Every panel shows "now" plus whatever the
  in-process buffers already hold.
- Mobile layout. The console targets a desktop browser.

## 3. Access control

Admin identity already exists and is unchanged: `ADMIN_EMAILS` (JWT `email`
claim) or `ADMIN_USER_IDS` (`sub`), stamped by the auth middleware onto
`request.state.is_admin`; dev mode (`CLERK_JWKS_URL` unset) is always admin.

A **new** router-level dependency is added rather than reusing
`deps.require_admin`: that one's 403 body is the pinned copy
`"dealing requires admin access"` with tests asserting it exactly.

```python
def require_admin_console(request: Request) -> None:
    """Router-level gate for /api/admin/*. Separate from require_admin so the
    dealing copy stays pinned."""
    if not request_is_admin(request):
        raise HTTPException(403, "admin access required")
```

Every `/api/admin/*` route carries it at the router level. Non-admin hosted
callers get 403 with that body; unauthenticated callers still get the existing
401 from the auth middleware first.

Frontend: the page is rendered for any signed-in user who reaches `/admin`, but
every panel's data comes from a gated endpoint, so a non-admin sees a single
"You do not have admin access." state rather than a broken page. The server is
the only authority; the client never decides admin-ness from a claim it reads
itself. `GET /api/admin/whoami` (gated) is what the page calls first: 200 means
render the panels, 403 means render the denial.

## 4. Backend surface

New module `backend/auto_trader/api/routers/admin.py`, mounted in `app.py`
alongside the existing routers, all routes under `/api/admin`:

| Route | Returns |
|---|---|
| `GET /api/admin/whoami` | `{userId, email, isAdmin, hostedMode}` |
| `GET /api/admin/users?limit=&offset=&query=` | Clerk user page (see §5) |
| `GET /api/admin/health` | System health (see §6) |
| `GET /api/admin/usage` | Per-user usage rows (see §7) |
| `GET /api/admin/logs?level=&limit=` | Recent log records (see §8) |

All responses are plain JSON dicts built by the router; no new pydantic schema
module. Every endpoint is independently fetchable so one failing panel (for
example Clerk unconfigured) never blanks the page.

## 5. Clerk user list

New `backend/auto_trader/core/clerk_admin.py`: a thin async httpx client for
the Clerk Backend API.

- Config: `CLERK_SECRET_KEY` (new env var), read per request like every other
  env in this codebase. Unset (the normal local-dev case) means the endpoint
  returns `{"configured": false, "users": [], "total": 0}` with status 200 , 
  **never a 500**. The panel renders "Clerk not configured" in that state.
- Upstream: `GET https://api.clerk.com/v1/users` with
  `Authorization: Bearer <secret>`, params `limit` (cap 100), `offset`,
  `order_by=-created_at`, and `query` when a search box term is present; plus
  `GET https://api.clerk.com/v1/users/count` for the total.
- Timeout 10s. An upstream non-2xx or transport error becomes
  `{"configured": true, "error": "<short reason>", "users": []}` with status
  200: the panel shows the error inline. The secret is never echoed into any
  error body or log line.
- Field mapping (verified against a live payload before the panel is wired, per
  §11): `id`, primary email from `email_addresses` matched on
  `primary_email_address_id`, `first_name`/`last_name`, `image_url`,
  `created_at`, `last_active_at`, `last_sign_in_at`, `banned`, `locked`.
  Timestamps are Clerk's epoch-milliseconds, passed through as numbers; the
  frontend formats them. Anything missing renders as a dash placeholder in
  the UI, not as the string "undefined".
- The response carries only the mapped fields, not the raw Clerk object.

`CLERK_SECRET_KEY` handling elsewhere:
- Added to `/etc/auto-trader/demo.env` on the box.
- `deploy-demo.sh`: the existing env-leak guard matches env assignments; the new
  `CLERK_SECRET_KEY=sk_live_...` line is added to the guard's allow story
  deliberately (it belongs on the box, it must never reach the frontend bundle).
- Covered by the existing log-redaction filter story: the value is never logged.

## 6. System health

Assembled from what the process already knows; no new collectors:

- `uptimeSeconds` (process start stamped at import), backend version/commit if
  cheaply available, `hostedMode`, `pid`.
- `idleSeconds` from `api/activity.py`.
- Live feeds: the alert engine's per-(broker, epic) feed table: count of
  active feeds and a row per feed with last-tick age.
- Alert engine: running flag, number of armed alerts, number triggered today.
- Brokers: registered ids, which are restricted, the default id.
- Databases: for each known db file (`app_state`, `backtest_runs`,
  `backtest_sweeps`, `backtest_wfo`, `cost_profiles`, `alerts`, `patterns`,
  `candle_history`, `tick_history`) its path, existence, and size in bytes.
- Disk: free/total bytes on the data directory (`shutil.disk_usage`).
- Snapshot subsystem: whether chart snapshots are enabled (`SNAPSHOT_DISABLED`)
  and whether `FRONTEND_URL` is set.

Any sub-probe that raises is caught and reported as `{"error": "..."}` inside
its own key; one bad probe never fails the whole endpoint.

## 7. Per-user usage

New `backend/auto_trader/core/admin_usage.py`. This module holds the only
deliberately **unscoped** queries in the codebase over tables that sub-project 2
partitioned by `user_id`. It is imported by `routers/admin.py` and by nothing
else: in particular no non-admin router may ever import it, and no unscoped
helper is added to `state_store.py`, `run_store.py`, `sweep_store.py`,
`wfo_store.py`, `cost_profiles.py` or `alert_store.py`.

Per `user_id`, one row aggregating:

- `stateRows` and `stateBytes` from `app_state`
- `runs` from `backtest_runs.runs`
- `sweeps` from `backtest_sweeps.sweeps`
- `wfo` from `backtest_wfo.wfo`
- `alerts` (armed) and `triggered` from `alerts.db`
- `costProfiles`, `patternPresets`
- `lastSeen`: max timestamp visible across those tables

Counts only. **No user content**: no state blobs, no alert epics, no run
configs, no strategy names: crosses this boundary. Rows are keyed by
`user_id`; the page joins them to Clerk emails client-side by id, so the
backend never has to correlate the two.

Missing db file or missing table is an empty contribution, not an error.

## 8. Logs

journald is where the hosted process actually logs (systemd unit
`auto-trader-demo`), and `deploy-demo.sh` needs `sudo` to read it, so shelling
out to `journalctl` from the API process is not dependable and is rejected.

Instead: an **in-process ring buffer**. A `logging.Handler` installed at app
startup keeps the last N (default 500) formatted records in a `collections.deque`
with level, logger name, timestamp, message, and the exception text when
present. `GET /api/admin/logs` returns them newest-first, filterable by minimum
level.

Consequences stated plainly: the buffer covers the current process only and is
lost on restart; it does not include uvicorn's pre-startup output. That is the
accepted trade for a panel that works identically in dev and on the box with no
permissions story. Records are emitted through the existing redaction filter, so
tokens are already scrubbed before they reach the buffer.

## 9. Frontend

Route: Cloudflare Pages already serves the built `index.html` with status 200
for unmatched paths (verified 2026-09-11 against `https://chartkar.app/…`), and
the vite dev server does SPA fallback too, so `/admin` needs **no** `_redirects`
file and no router library.

Dispatch in `main.tsx`, matching the existing `?snapshot=1` idiom but placed
differently: the admin page renders **inside** `<ClerkProvider><SignedIn>
<AccountGate>`, replacing `<App/>`, because it needs `ClerkTokenBridge` to have
run so `lib/http.ts` attaches a session token. It is not a sibling branch of the
snapshot boot. The path check wins over `shouldBootMobile()`. The no-Clerk dev
branch renders `<AdminApp/>` directly for the same path.

```
const isAdminPath = window.location.pathname.replace(/\/+$/, "") === "/admin"
```

`frontend/src/admin/AdminApp.tsx` plus one component per panel
(`UsersPanel`, `HealthPanel`, `UsagePanel`, `LogsPanel`) in the same folder, and
`frontend/src/admin/api.ts` for the five typed fetches (through the existing
`lib/http.ts` so auth headers and error handling are shared).

Layout: a full-page console: a slim header (title, signed-in admin email, a
Refresh control, a link back to `/`), then the four panels stacked in a single
scrolling column, each a card with its own heading, its own loading/error state,
and its own last-refreshed stamp. Users is first (it is the reason the page
exists), then Health, Usage, Logs. Usage renders as a sortable table joined to
the Clerk emails when the Users fetch succeeded, falling back to bare user ids
when it did not. Styling reuses existing app tokens/classes; the shared
`Tooltip`/`InfoTip` components are used for any explanatory copy, never
`title=`. No em dashes in UI copy.

Refresh: manual button plus a 30s poll for Health and Logs only; Users and
Usage refetch on demand (Clerk's API is rate-limited and the usage scan touches
every db).

## 10. Testing

Backend (`backend/tests/test_api_admin_console.py`, mirroring
`test_api_admin_gate.py`):
- each of the five endpoints: 403 for a hosted non-admin token
  (`clerk_fake.make_token(extra={"email": ...})`), 200 for an admin token, 401
  unauthenticated.
- `/api/admin/users` with `CLERK_SECRET_KEY` unset returns 200 and
  `configured: false` (this is the dev-mode path, exercised on every local run).
- `/api/admin/users` with a stubbed httpx transport: field mapping, and an
  upstream 401/timeout degrading to an inline error rather than a 500.
- `/api/admin/health` with a sub-probe forced to raise: 200 with the error
  confined to its key.
- `/api/admin/usage`: seeded rows for two user ids come back as two rows with
  correct counts and no content fields.
- `/api/admin/logs`: a record emitted after startup appears; the buffer caps at N.

Frontend (`frontend/src/admin/*.test.tsx`, jsdom, run file-scoped only):
- `AdminApp` renders the denial state on a 403 whoami.
- each panel renders its loading, error, and populated states.
- the usage/Clerk join falls back to raw ids when the users fetch failed.

## 11. Build order

1. `require_admin_console` + `/api/admin/whoami` + tests.
2. Log ring buffer + `/api/admin/logs` + tests.
3. `/api/admin/health` + tests.
4. `admin_usage.py` + `/api/admin/usage` + tests.
5. `clerk_admin.py`: **first** curl `https://api.clerk.com/v1/users?limit=1`
   once with the real secret and mapped against that payload, then
   `/api/admin/users` + tests.
6. Frontend `AdminApp` + panels + tests.
7. Deploy wiring: `CLERK_SECRET_KEY` into `demo.env` and `deploy-demo.sh`.

Steps 1-4 and 6 need no secret and no network; step 5 is the only one gated on
the Clerk secret being available.
