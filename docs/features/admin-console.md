# Admin console

`/admin` is an operator page (Clerk users, system health, per-user usage
counts, recent logs), read-only apart from impersonation and the AI assistant
key. Every panel reads a gated `/api/admin/*` endpoint;
the gate is `deps.require_admin_console` (403 `admin access required`), which
is separate from the dealing gate on purpose. Admin identity is unchanged:
`ADMIN_EMAILS` / `ADMIN_USER_IDS`, with dev mode always admin.

The Users panel needs `CLERK_SECRET_KEY` (Clerk Backend API, backend only);
without it the endpoint answers `configured: false` and the panel says so.
The AI assistant card sets the assistant's gateway key without a redeploy:
`PUT /api/admin/assistant` sends the key to the gateway as a 1-token message
and saves it only if the gateway accepts it (422 with the reason otherwise),
then swaps it in live (`ASSISTANT.set_key_override`). `DELETE` reverts to
`ASSISTANT_API_KEY`. A saved key beats the env key, `ASSISTANT_DISABLED`
beats both, and the lifespan re-applies the saved key at startup. The store
is `core/assistant_key_store.py` (one row, plaintext, file mode 0600, path
from `ASSISTANT_KEY_DB`, rollback journal and not WAL because the deploy rsync
keeps only `*.db`). Responses carry only the key's last 4 characters.

Logs come from an in-process ring buffer (`core/log_buffer.py`), so they cover
the current process only and reset on restart. Cross-user queries live in
`core/admin_usage.py` and must not be imported anywhere else.

## Impersonation

An admin can view the app read-only as any Clerk user. The admin's own token
stays the credential: the target id rides in the `X-Impersonate-User` header
(HTTP) or the `impersonate` query param (WebSocket), and
`auth.resolve_impersonation` swaps the identity at both call sites, forces
`is_admin` false and refuses every method outside GET/HEAD. Nothing is minted,
so ending a session is dropping the header.

Every identity-stamping branch in the HTTP middleware (Clerk claims, the
internal render-token path, the signed-out demo principal) stamps
`request.state.impersonator`, and every branch besides the Clerk-claims one
refuses an `X-Impersonate-User` header outright rather than acting on it, so
none of the other "act as someone else" mechanisms can stack with real
impersonation. `POST /api/admin/impersonate` validates the target against
Clerk and writes the audit start line; the target id is percent-encoded into
the Clerk API URL so it cannot be used to steer that request elsewhere.

Because `is_admin` is false for the duration, `/api/admin/*` refuses an
impersonating session: the exit control is pure client state
(`components/ImpersonationBanner.tsx`). The frontend keeps the target in
`sessionStorage` via `lib/impersonation.ts`, which every transport reads;
entering and exiting wipe the local workspace (`lib/workspaceKeys.ts`) and
hard-reload, because the workspace keys are broker-keyed rather than
user-keyed. `workspaceKeys.ts` is a separate leaf module (no imports of its
own) purely to avoid an import cycle: `persist/core` imports `impersonation`
for the mirror gate, and `impersonation` needs the wipe, so the wipe cannot
live in `persist/core` or `AccountGate` without reopening that cycle;
`persist/core` re-exports `PREFIX` so its existing importers see no change.
Persist stops mirroring writes to the backend while impersonating
(`mirrorEnabled = !isImpersonating()`).

Audit lines go to the `auto_trader.impersonation` logger: an INFO start line
per session, a throttled INFO summary while active, and an unthrottled
WARNING for every refusal, including `verify_ws` refusing a non-admin's
`impersonate=` query param. Logged header/param values are truncated to
`MAX_LOGGED_VALUE_LEN` (200 chars) because refusal logging is unthrottled and,
on the demo-principal branch, reachable with no credential at all. These
lines reach stdout, so journald keeps them across a restart; the Logs panel
shows them from the ring buffer, which does not.

In local dev (`CLERK_JWKS_URL` unset) auth is off and every request is the
fixed dev user with `is_admin` true; the impersonation header is never even
read, so impersonation only exists in hosted mode.

Cross-tab seam: the `/ws/state` push handler in `lib/persist/core.ts` applies
a remote push with a direct `localStorage.setItem`, bypassing `mirrorEnabled`
on purpose to avoid an echo loop. localStorage is shared across every tab of
the app, but the impersonation flag lives in sessionStorage, which is
per-tab. A second tab that is not impersonating (mirroring still on) sits on
the same localStorage keys the impersonated tab is writing, and will mirror
the target's data into the admin's own backend record. Entering only reloads
the current tab. The confirm dialog in `admin/UsersPanel.tsx` tells the
operator to close other tabs first; that is the whole mitigation. Namespacing
localStorage by user would close this properly but is out of scope for this
feature; do not "simplify" the push handler to always honor `mirrorEnabled`
without re-reading this note, since that reopens the echo loop it was written
to avoid.

See docs/superpowers/specs/2026-09-12-user-impersonation-design.md.
