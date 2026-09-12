# User impersonation (admin console)

Date: 2026-09-12
Status: design, approved in chat, not yet implemented

## Goal

Let an admin reproduce what a specific user sees. Signing in as yourself and
guessing at a bug report does not work when the problem is in that user's own
workspace, alerts or presets. Impersonation boots the full app with that
user's data, read-only.

## Scope

In scope: read-only impersonation of one user at a time, driven from the
admin console's Users panel, covering the whole app (HTTP and WebSocket).

Out of scope, deliberately:

- Any write while impersonating. Every mutating method is refused server-side.
- Greying out mutating controls app-wide. The backend refuses the write and
  the UI surfaces an ordinary error toast. Disabling every affordance is a
  far larger change and is not justified by this feature.
- Impersonation in local dev. There is one user there.
- A durable audit table. The record is stdout, which is journald on the box.

## Approach

The admin's own Clerk token stays the credential on every request. A request
carries the target user id alongside it: the `X-Impersonate-User` header on
HTTP, the `impersonate` query param on WebSocket dials (browsers cannot set
headers on a handshake, which is why `token` is already a param there).

Nothing is minted. There is no second bearer credential to leak, refresh or
revoke, and ending a session is dropping a header. The real admin id is
present on every impersonated request, so the audit trail is truthful by
construction rather than by bookkeeping.

Two alternatives were considered and rejected. A backend-minted short-TTL
token (the `verify_render_token` pattern) needs less plumbing, because the WS
dialers already carry a token, but it creates a real credential granting
access to someone else's account, living in a browser, needing a TTL and a
revocation story. Clerk actor tokens are the only option where the frontend's
Clerk identity genuinely changes, so `AccountGate` and persist would need no
special casing; they were rejected because they replace the admin's own
session in that browser and cannot be constrained to read-only at the Clerk
level anyway.

## Backend: identity resolution

One new helper in `api/auth.py`:

```
resolve_impersonation(claims, raw_target, method) -> (user_id, is_admin, impersonator)
```

- No target: today's answer, unchanged.
- Target present, `is_admin_claims(claims)` false: 403 `impersonation requires
  admin access`. Never a silent fallback to self, so a bug cannot quietly
  serve the wrong user's data.
- Target present, caller is admin: `(target, False, real_sub)`.
- Method outside GET/HEAD: 403 `impersonation is read-only`.

It is called from both places that resolve identity: the HTTP middleware in
`install_auth` and `verify_ws`. Both stamp `impersonator` on the request or
websocket state, `None` when not impersonating.

Three exclusions are deliberate:

- The render-token path returns before this runs, and an impersonation header
  on a render-token request is rejected. The render token is already a "read
  as another user" mechanism; letting the two stack would let a 60s internal
  token pivot to any account.
- Dev mode (`auth_enabled()` false) ignores impersonation. Honouring it would
  create a state local dev can reach and production semantics cannot.
- `is_admin` is False while impersonating, so `/api/admin/*` returns 403. This
  is correct and it constrains the frontend: the exit control cannot depend on
  an admin endpoint.

Consequence worth stating: `/ws/state` keys subscribers by the id `verify_ws`
returns, so an impersonating socket registers under the target and receives
that user's pushes (their alerts firing, their trades-dirty pings). That is
the point of the feature. The cost is that the admin stops seeing their own
pushes for the duration.

Non-goal that changes what impersonation can show: paper trading is not
per-user partitioned today, and dealing routes are admin-gated, so trades are
not part of what impersonation reproduces. The genuinely per-user surfaces are
alerts, workspaces and layouts, pattern presets, backtest configs and costs.

## Backend: endpoint and audit

`POST /api/admin/impersonate` with `{user_id}`, under `require_admin_console`
(the caller is still themselves). It validates the target against Clerk and
404s an unknown id, so a typo cannot start a broken session. It returns no
token and stores nothing server-side; it is safe to call twice. Its real job
is to be the authoritative start-of-session record.

Auditing every impersonated request would drown the log, because the app
polls. A small in-process auditor on the `auto_trader.impersonation` logger
emits:

- `impersonation start: admin=<id> target=<id>` at INFO, from the endpoint
- a throttled summary, at most one line per 60s per (admin, target), with the
  request count and a sample path
- every rejected attempt at WARNING, unthrottled. A non-admin sending the
  header is the line that actually matters.

These reach stdout, so journald on the box keeps them across a restart. The
`log_buffer` ring makes them visible in the admin Logs panel but resets with
the process, as documented in CLAUDE.md. Journald is the record of truth; the
panel is the convenient view.

## Frontend

The target id lives in `sessionStorage` under `auto-trader.impersonateUserId`.
Per-tab, dies with the tab. Not localStorage: an impersonation that outlives
the tab, or leaks into another window, is the failure mode worth engineering
against.

### Entering

From a Users panel row, behind a confirm dialog: `POST
/api/admin/impersonate`, then wipe every `auto-trader.*` localStorage key, set
the session flag, hard-reload to `/`.

The reload is deliberate. Re-plumbing a live app's dialers, caches and
hydrated stores mid-flight half-works; a reload guarantees every module boots
in one mode.

The wipe is necessary because the app's local workspace keys are broker-keyed,
not user-keyed. The Clerk client identity does not change under this approach,
so `AccountGate` never fires, and without the wipe the target's hydrated
workspace would land on top of the admin's own keys and then mirror back to
the admin's account on exit. The wipe reuses the helper extracted from
`AccountGate`.

The wipe is safe because the admin's workspace lives on the backend and
`hydrateFromBackend` is backend-wins-on-load, so it returns on exit. The
device-local set (`activeLayoutId`, scratch, autosave) genuinely does not
survive, exactly as when signing in on a new browser. The confirm dialog says
so plainly.

### While impersonating

- `apiFetch` attaches `X-Impersonate-User`; the three WS dialers append
  `impersonate=`. Both read one shared helper, so a dialer added later cannot
  silently miss it and produce a split-brain session that reads as the target
  but writes live state as the admin.
- Persist suppresses backend mirroring entirely, as a single check at the
  mirror boundary. Without it every autosave would 403 against the read-only
  gate and spam errors.
- A banner is pinned across the top: who is being viewed, that it is
  read-only, and Exit. Pure client state, because `/api/admin/*` 403s.
- The Admin item in the Clerk account menu hides itself, since `useIsAdmin` is
  false. The banner is the only way back, which is the right number of ways.

### Exiting

Clear the flag, wipe `auto-trader.*` again (the target's workspace is sitting
in it), reload to `/admin`.

## Testing

Backend, against the real middleware rather than the helper alone, because the
bugs here are integration bugs:

- non-admin sending the header: 403, never a silent fallback to self
- admin plus target: a scoped GET returns the target's rows, and
  `/api/admin/*` 403s on the same session
- POST/PATCH/DELETE with the header: 403 read-only
- a render token plus the header: rejected
- dev mode ignores the header
- `verify_ws`: admin plus `impersonate=` resolves to the target with
  `is_admin` false; a non-admin closes 4401 rather than dialing as itself
- audit: start at INFO, rejection at WARNING, throttle emits once per window

Frontend, affected files only (never the full suite):

- `apiFetch` attaches the header when the flag is set, omits it otherwise
  (extends `http.apiFetch.test.ts`)
- the shared WS URL builder carries `impersonate=`
- persist mirroring is suppressed while impersonating
- enter and exit each wipe `auto-trader.*` and set or clear the flag, using
  `installMemStorage`
- the banner renders the target and its Exit clears the flag

## Build order

1. `resolve_impersonation` plus both call sites (middleware, `verify_ws`)
2. The audit logger and its throttle
3. `POST /api/admin/impersonate`
4. Frontend transport: the shared flag helper, `apiFetch`, the WS dialers
5. Persist mirror suppression
6. Enter and exit flows plus the banner
7. The Users panel button and confirm dialog
8. A CLAUDE.md section
