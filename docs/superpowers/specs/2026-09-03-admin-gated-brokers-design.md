# Admin-Gated Broker Activation on the Hosted Instance — Design

Date: 2026-09-03
Status: approved for implementation (standing "go nonstop" mandate)
Prereqs: Clerk auth foundation (2026-09-01), per-user data partitioning
(2026-09-02), hosted deployment hardening (2026-09-02) — all merged and live.

## 1. Goal

Activate the credentialed brokers — Capital.com first, plus IG / MT5 (MetaApi)
/ oanor as their credentials are added — on the public instance
(trader.rahkar.pro), visible and usable ONLY by the admin account
(`mahmoud.shahrood@gmail.com`). Every other signed-in user keeps exactly
today's experience: the credential-free data-only sources (dukascopy,
yfinance, nobitex) and no dealing.

Note: the request wrote "mamhoud.shahrood@gmail.com"; ruled a typo — the
Clerk account and userEmail are `mahmoud.shahrood@gmail.com`.

## 2. Non-goals

- Per-user broker credentials (multi-tenant dealing) — still skipped
  (sub-project 3). One global credential set, one admin.
- Per-user paper books. The paper book stays shared; making exec admin-only
  is what keeps that acceptable.
- Re-enabling remote compute or the MCP bridge on hosted. Unchanged.
- Frontend changes. The broker selector is driven by `/api/brokers`; a
  filtered payload is all non-admins need.

## 3. Admin identity

New env vars, read per request (same pattern as the Clerk vars):

- `ADMIN_EMAILS` — comma-separated, matched case-insensitively against the
  verified JWT's `email` claim (present only if the Clerk session token is
  customized to include `{"email": "{{user.primary_email_address}}"}`).
- `ADMIN_USER_IDS` — comma-separated Clerk user ids, matched against `sub`.

A request is admin iff EITHER matches. Dev mode (`CLERK_JWKS_URL` unset) is
always admin — local behavior is unchanged. Missing claim or empty env → not
admin (fail closed). Matching happens on claims from the verified token
only; nothing trusts request headers or bodies.

Implementation in `backend/auto_trader/api/auth.py`:

- `verify_token(token) -> str` becomes a thin wrapper over a new
  `_verify_claims(token) -> dict` (same validation, returns all claims).
- `is_admin_claims(claims: dict) -> bool` implements the env matching.
- The HTTP middleware stamps `request.state.is_admin` next to
  `request.state.user_id` (True in dev mode).
- `verify_ws` stamps `websocket.state.is_admin` the same way (True in dev
  mode) before returning the user id; return type unchanged.

## 4. Restricted broker set

`BrokerRegistry` gains `restricted: set[str]` (data-broker ids). Every
registration in `build_registry()` that sits behind a credential check adds
its data id to the set: `capital`, `capital-live`, the IG ids
(`ig-demo`/`ig-live` per `ig.register`), `mt5`, `oanor`. The unconditional
trio (dukascopy, yfinance, nobitex) is never restricted. Marking happens in
`build_registry()` (e.g. `registry.restrict(broker_id)` after each
credentialed `register(...)` call), so broker modules stay policy-free.

Access rules (enforced only when `auth_enabled()`; dev mode sees everything):

- Non-admin + restricted data broker → HTTP 403 / WS close.
- Non-admin + ANY execution broker → 403. The exec namespace is admin-only
  wholesale on hosted because the paper book and dealing accounts are global.
- Admin → full registry, exactly like local dev.

`describe()` gains an `include_restricted: bool` parameter. When False it
drops restricted entries from `data` and `labels`, drops ALL `exec` entries,
and (as today) synthesizes `:data` pseudo-accounts for the surviving
data-only brokers. `default_data_id()` gets a companion used by
`broker_query` so a non-admin's bare request never lands on a restricted
default: if the caller lacks access to the default id, fall back to the
first unrestricted broker.

## 5. Enforcement points

Central helpers in `backend/auto_trader/api/deps.py`:

- `is_admin(request_or_ws) -> bool` — reads the stamped state; True when
  auth is disabled.
- `ensure_broker_access(request, broker_id) -> None` — raises
  `HTTPException(403, "broker '<id>' requires admin access")` when hosted,
  non-admin, and the id is restricted. Unknown ids still 404 downstream.
- `require_admin(request) -> None` — 403 unless admin; used as a
  router-level dependency for dealing.

Wired at every place a broker id enters the API:

1. `broker_query` (deps.py) — gains a `Request` parameter; resolves the
   default with the non-admin fallback and calls `ensure_broker_access`.
   Covers markets.py, charts.py and every other `Depends(broker_query)`
   route.
2. `/api/brokers` (markets.py) — returns
   `describe(include_restricted=is_admin(request))` plus an `"isAdmin"`
   boolean in the payload (harmless extra key for the frontend).
3. Backtest/sweep/WFO submission (backtest.py) — every route whose request
   body names a broker (`req.broker`) calls `ensure_broker_access` before
   admitting the job. Background workers need no check: admission is the
   gate.
4. costs.py — same check wherever it resolves a broker id.
5. `/ws/stream` (stream.py) — after `verify_ws`, if the resolved
   `broker_id` is restricted and `websocket.state.is_admin` is False, close
   with the existing 4401-family app code (use 4403) and bail.
6. Dealing: `trading.py` and `mt5.py` routers get
   `dependencies=[Depends(require_admin)]` at `include_router` time (or on
   the APIRouter), covering orders, positions, working orders, quotes,
   account summary — the whole exec surface.
7. Audit sweep: a task greps for `get_data(`, `get_exec(`, `_registry.` in
   `api/` and confirms each call site is behind one of the gates above or
   serves only unrestricted brokers.

## 6. Deploy script + ops

`scripts/deploy-demo.sh`: replace the "no broker credentials on the box"
preflight with a consistency preflight — if any broker-cred assignment
(same regex as today) exists in `/etc/auto-trader/demo.env`, then
`ADMIN_EMAILS=` or `ADMIN_USER_IDS=` must also be present; otherwise FAIL
(creds without a gate would expose dealing to every signed-in user).
Missing-creds is no longer an error. SSH-failure handling keeps the
fail-closed rc-branching pattern.

Activation runbook (user-run `!` commands; secrets never pass through the
assistant):

1. Append broker creds from the local env file straight to the box, e.g.
   `grep -E '^(CAPITAL_|IG_|METAAPI_|OANOR_)' backend/.env | ssh -i ~/.ssh/id_ed25519 ec2-user@3.139.146.5 'sudo tee -a /etc/auto-trader/demo.env'`
2. Append `ADMIN_EMAILS=mahmoud.shahrood@gmail.com` and
   `ADMIN_USER_IDS=<clerk user id>`.
3. Optional (for the email path): Clerk dashboard → Sessions → Customize
   session token → add `{"email": "{{user.primary_email_address}}"}`.
4. `sudo systemctl restart auto-trader-demo`, then redeploy backend via
   `scripts/deploy-demo.sh --backend-only` (or full deploy).

## 7. Error handling

- 403 body: `{"detail": "broker '<id>' requires admin access"}` (data) /
  `{"detail": "dealing requires admin access"}` (exec). No credential or
  email material in any error.
- WS restricted-broker close code 4403 (sibling of the 4401 auth code).
- Admin-env parsing tolerates whitespace and empty entries, like
  `CLERK_AUTHORIZED_PARTIES`.

## 8. Testing

- auth.py unit tests: `is_admin_claims` (email case-insensitivity, user-id
  match, both-empty → False, missing claim → False); middleware stamps
  `is_admin`; dev mode admin.
- Registry tests: `restricted` marking in `build_registry` with fake creds;
  `describe(include_restricted=False)` hides restricted data/labels and all
  exec, keeps pseudo-accounts for the free trio.
- Route tests (hosted-mode fixture, monkeypatched env + token verifier):
  non-admin gets filtered `/api/brokers`, 403 on restricted `?broker=`,
  403 on every trading.py/mt5.py route, backtest submission with a
  restricted `req.broker` 403s; admin passes all of the above; dev mode
  unchanged (full suite must stay green).
- deploy-demo.sh guard: verify the new preflight logic against sample env
  files (creds+gate OK, creds w/o gate FAIL, no creds OK, SSH failure FAIL).
