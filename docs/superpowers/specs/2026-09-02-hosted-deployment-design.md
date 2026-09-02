# Hosted Deployment Hardening — Design

**Date:** 2026-09-02
**Status:** Approved (in-chat) — sub-project 4 of the SaaS transformation
**Depends on:** Clerk auth foundation (2026-09-01), per-user data partitioning (2026-09-02)

## Goal

Turn the existing public demo at https://trader.rahkar.pro into the
authenticated, multi-user hosted app. The user chose **Replace**: the open
demo goes away; the site requires sign-in.

The demo infrastructure is reused as-is:

- Backend: systemd unit `auto-trader-demo` (uvicorn on `127.0.0.1:8010`) on
  `ec2-user@3.139.146.5`, reached via the `aws-vps` Cloudflare Tunnel as
  `https://trader-api.rahkar.pro`. Env file `/etc/auto-trader/demo.env`
  (intentionally NO broker credentials — dukascopy/yfinance only).
- Frontend: Cloudflare Pages project `auto-trader-demo` → trader.rahkar.pro.
- Deploy: `scripts/deploy-demo.sh` (rsync backend, pip install, restart;
  vite build + wrangler pages deploy; smoke tests).

Clerk production instance (see memory `clerk-auth-setup`): publishable key
`pk_live_Y2xlcmsudHJhZGVyLnJhaGthci5wcm8k`, JWKS
`https://clerk.trader.rahkar.pro/.well-known/jwks.json`, authorized party
`https://trader.rahkar.pro`.

## Scope

Five changes, in two groups. Group 1 (code, tasks 1–4) merges to main and is
inert until the hosted env vars exist. Group 2 (deploy, task 5) flips
production and runs only after an explicit user OK.

### 1. Backend: no remote-compute proxying in hosted mode

`compute.forward()` relays requests verbatim to the operator's private
compute host using `COMPUTE_HOST_TOKEN`. The remote host predates
multi-tenancy: forwarded jobs carry no user identity, so any signed-in user
could reach the operator's private compute box and other users' remote jobs
(the recorded "target=remote owner-check bypass").

- In `forward()` (`backend/auto_trader/api/routers/compute.py`): when
  `auth_enabled()`, raise `HTTPException(403, "remote compute is not
  available on the hosted service")` before reading any config.
- `GET /api/compute/status`: when `auth_enabled()`, return
  `{"remoteConfigured": False}` without reading config, so the frontend
  never shows the remote toggle to hosted users.
- The EC2 host-control routes (`/api/compute/host`, `.../start`, `.../stop`)
  need no change: they act only on a locally configured
  `COMPUTE_EC2_INSTANCE_ID`, which the hosted box does not set, and they
  answer "unconfigured" then.

### 2. Backend: JWKS verification off the event loop

`verify_token()` can block on a JWKS HTTP fetch (cold cache, key rotation).
Today it runs directly in the async middleware and in `verify_ws`, stalling
the whole event loop for up to the urllib default timeout.

- HTTP middleware (`auth.py` `install_auth`): call
  `await asyncio.to_thread(verify_token, token)`.
- `verify_ws`: same, `await asyncio.to_thread(verify_token, token)`.
- `verify_token` itself stays sync (PyJWKClient is sync); no signature
  change, all existing tests still call it directly.

### 3. Backend: redact WS tokens from access logs

Hosted WebSocket dials pass the Clerk JWT as `?token=...`; uvicorn's access
log prints the full request line, so short-lived (but live) session tokens
land in journald.

- Add a `logging.Filter` on the `uvicorn.access` logger that rewrites
  `token=<value>` to `token=REDACTED` in the record's args (the request-line
  arg) before formatting. Regex: `token=[^&\s"']+` → `token=REDACTED`.
- Install it in `_configure_logging()` (`api/app.py`), which already runs in
  lifespan after uvicorn sets up its handlers. Installed unconditionally —
  in dev the param never appears, so the filter is a no-op.
- Filter must never raise (a broken filter drops log records): wrap the
  rewrite defensively and pass records through untouched on any surprise
  shape.

### 4. Frontend: account-switch gate (device-local key leak)

The hosted hydrate (sub-project 2) clears **mirrored** keys for a fresh
account but keeps device-local keys (`activeLayoutId`, `scratch`,
`autosave`, backtest panel UI keys). On a shared browser, user B logging in
after user A inherits A's device-local layout state — the recorded
"device-local key clear on account switch" condition.

- New component `AccountGate` (`frontend/src/components/AccountGate.tsx`),
  rendered inside `<SignedIn>` wrapping `<App />` in `main.tsx`.
- Uses Clerk's `useUser()`; compares `user.id` against
  `localStorage["auto-trader.lastUserId"]` (raw string, not JSON).
  - Match → render children.
  - Mismatch or absent → synchronously (before children ever mount) remove
    **every** localStorage key starting with `auto-trader.` (device-local
    included), write `auto-trader.lastUserId = user.id`, then render
    children. Backend state is untouched — server data is already per-user.
- The comparison and clear run during the first render (memo/layout-effect
  free: compute before returning JSX), so `App` — and the persist hydrate
  it triggers — never sees the stale keys.
- Local dev (`CLERK_ENABLED` false): component never mounts; zero behavior
  change. `auto-trader.lastUserId` is written only in hosted mode.

### 5. Deploy: script, env, smoke tests (the production flip)

`scripts/deploy-demo.sh` changes:

- Frontend build gains
  `VITE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudHJhZGVyLnJhaGthci5wcm8k`
  (a constant in the script, like `API_BASE`); after the build, grep the
  bundle for the key and fail if absent (misconfigured build guard, same
  pattern as the existing `API_BASE` grep).
- Pre-deploy guard: SSH `grep -q '^CLERK_JWKS_URL=' /etc/auto-trader/demo.env`
  — fail before rsync if the box env is missing the Clerk vars, so a deploy
  can never bring up an unauthenticated backend by accident.
- Smoke tests updated for auth-on:
  - `GET /health` → 200 (exempt).
  - `GET /api/brokers` unauthenticated → expect **401** (was 200).
  - Broker-leak check moves from the (now 401) response body to SSH:
    `grep -Ei 'capital|^IG_|mt5' /etc/auto-trader/demo.env` must match
    nothing.
  - CORS preflight OPTIONS `/api/brokers` → 200 (OPTIONS exempt).
  - `https://trader.rahkar.pro/` → 200.

One-time box config (runbook step, executed over SSH at deploy time, not in
the script): append to `/etc/auto-trader/demo.env`:

```
CLERK_JWKS_URL=https://clerk.trader.rahkar.pro/.well-known/jwks.json
CLERK_AUTHORIZED_PARTIES=https://trader.rahkar.pro
```

Known consequence: the `auto-trader-demo.pages.dev` alias keeps serving the
frontend, but sign-in from it fails azp (`https://trader.rahkar.pro` is the
only authorized party). Acceptable — the custom domain is the product URL.

## Out of scope

- Per-user broker credentials / live dealing (sub-project 3, skipped): the
  hosted box ships no broker creds, so dealing endpoints report no
  credentialed brokers; paper-trigger broadcast remains pinned to the dev
  user and is a hosted no-op.
- Google OAuth production credentials for Clerk (email sign-in works now).
- Rate limiting, billing, marketing pages.
- Backfill/migration of demo visitors' data: the demo had no accounts;
  existing server-side rows belong to user `dev` and are simply unreachable
  by hosted users.

## Testing

- Backend (pytest, using `tests/clerk_fake.py`):
  - hosted mode: sweep-submit route with `target=remote` → 403; compute
    status → `remoteConfigured: false` even with COMPUTE_HOST_* set.
  - dev mode: forward path unchanged (existing tests keep passing).
  - redaction filter: unit test the filter against a synthetic
    uvicorn.access record — `token=` value redacted, other args untouched,
    malformed records passed through.
  - to_thread change is covered by every existing hosted-mode auth test.
- Frontend (vitest): AccountGate — match renders children with keys intact;
  mismatch clears all `auto-trader.*` keys (device-local included), writes
  `lastUserId`, renders children; first-ever sign-in (no stored id) clears
  and stamps.
- Deploy script: shellcheck + review only (it runs against production).
- Post-deploy live verification: smoke tests in the script, then the user
  signs in at trader.rahkar.pro (Bearer on API calls, `token=` on WS,
  401 for anonymous API hits, second account sees a fresh workspace).

## Rollout

1. Merge code changes to main (inert without env).
2. **Explicit user OK required** — this flips trader.rahkar.pro from open
   demo to sign-in-required.
3. SSH: add the two Clerk vars to `/etc/auto-trader/demo.env`.
4. Run `scripts/deploy-demo.sh` (backend then frontend, smoke tests inline).
5. Live verification (above). Rollback = remove the two env vars, restart
   the unit, redeploy the frontend from the pre-flip commit.
