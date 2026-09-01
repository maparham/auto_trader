# Clerk Auth Foundation — Design

Date: 2026-09-01
Status: approved design, pending implementation plan

## Context and goal

auto_trader is becoming a hosted, multi-user app. The full transformation is
decomposed into four sub-projects:

1. **Auth foundation (this spec)** — every request carries a verified user
   identity.
2. Per-user data partitioning (app state, layouts, backtests, sweeps, WFO,
   cost profiles; market data stays shared).
3. Per-user broker credentials, sessions, and dealing.
4. Hosted deployment hardening (MCP bridge, guards, HTTPS, concurrency).

This spec covers only sub-project 1. It ships Clerk-backed signup/sign-in
(open signup, configured in the Clerk dashboard) and backend verification
that puts a trusted user id on `request.state.user_id`. Nothing reads that
id yet beyond tests; data stays shared until sub-project 2.

Decisions already made with the user:
- Full multi-user, hosted server target, per-user broker creds eventually.
- Open signup.
- Local dev runs with auth OFF (no Clerk keys → today's zero-setup behavior,
  fixed dev user id). Hosted mode requires keys and fails closed.
- Approach: auth middleware in the existing `guard.py` style, PyJWT + JWKS
  verification, no Clerk backend SDK.

## 1. Backend: `auto_trader/api/auth.py`

A sibling of `guard.py`, following its conventions (env read at request
time, one HTTP middleware, no-op locally).

Environment:
- `CLERK_JWKS_URL` — presence switches hosted mode ON.
- `CLERK_AUTHORIZED_PARTIES` — comma-separated allowed `azp` claim values
  (the frontend origin(s)).

`install_auth(app)` registers one HTTP middleware, added in `app.py`
immediately after `install_guards(app)`:

- Keys unset (local dev): no verification; sets
  `request.state.user_id = "dev"` and continues.
- Keys set (hosted): every request must carry
  `Authorization: Bearer <Clerk session JWT>`. Verify with PyJWT (RS256)
  against a cached JWKS: cache TTL ~1 hour, refetch once on unknown `kid`.
  Check `exp`, `nbf`, signature, and `azp` ∈ CLERK_AUTHORIZED_PARTIES.
  Failure → 401 JSON (`{"detail": ...}`), no CORS-sensitive leakage beyond
  what the guard already does. Success → `request.state.user_id = sub`.
- Exemptions: CORS preflight (OPTIONS) requests, and `GET /health`
  (`routers/markets.py`) so load balancers can probe without a token.
- `/mcp` (HTTP mount): hard 404 in hosted mode. The MCP agent bridge stays
  local-only until sub-project 4.
- Startup fail-fast: if `CLERK_JWKS_URL` is set but not a valid https URL,
  raise at startup.
- Startup fail-fast: hosted mode (`CLERK_JWKS_URL` set) also requires
  `CLERK_AUTHORIZED_PARTIES` to be non-empty, raising at startup otherwise —
  an unset/empty value would silently disable the `azp` check.

New backend dependency: `pyjwt[crypto]`.

## 2. WebSockets

HTTP middleware never sees WS upgrades, so — like the existing
`/ws/agent-ui` token check — WS routes verify explicitly. `auth.py`
exposes `verify_ws(websocket) -> str | None`:

- Local mode: returns `"dev"`.
- Hosted mode: reads `token` from query params, runs the same JWT
  verification; invalid/missing → close with code 4401 and return None.

`/ws/candles`, `/ws/state`, and `/ws/agent-ui` call it before any other work. Clerk
session tokens are short-lived (~60 s), so a token in a WS URL is an
accepted, minor exposure; the frontend fetches a fresh token immediately
before connecting.

## 3. Frontend

New dependency: `@clerk/clerk-react`.

- `main.tsx`: if `VITE_CLERK_PUBLISHABLE_KEY` is set, render
  `<ClerkProvider>` wrapping `<SignedIn><App/></SignedIn>` and
  `<SignedOut><SignIn/></SignedOut>` (Clerk prebuilt components; signup
  policy lives in the Clerk dashboard). Unset → render `<App/>` exactly as
  today.
- `src/lib/authToken.ts`: module holding a token-getter provider —
  `setTokenGetter(fn)`, `getToken(): Promise<string | null>` (null when
  Clerk is off). A small bridge component rendered inside ClerkProvider
  registers Clerk's `useAuth().getToken` into it.
- `api.ts`: new `apiFetch(input, init)` wrapper that awaits `getToken()`
  and adds the `Authorization: Bearer` header when non-null. All `fetch(`
  call sites in `api.ts` switch to it. WS URL builders in `lib/feed.ts`
  and `agent/bridge.ts` append `?token=` (freshly fetched) when Clerk is
  on.
- Toolbar: Clerk `UserButton` (avatar / sign-out), rendered only when
  Clerk is on.

## 4. Error handling

- `apiFetch` receiving 401 in hosted mode → Clerk `signOut()` and let the
  `<SignedOut>` gate show sign-in. No retry loops.
- WS close 4401 → existing feed reconnect logic fetches a fresh token
  before redialing.
- Backend: malformed `CLERK_JWKS_URL` fails at startup, not per-request.

## 5. Testing

Backend (pytest):
- Middleware unit tests using a locally generated RSA keypair and a fake
  JWKS: valid token, expired, wrong signature, wrong `azp`, missing
  header, dev-mode no-op, JWKS refetch on unknown kid.
- `verify_ws` query-param path: valid, invalid → 4401, dev-mode.

Frontend (vitest):
- Existing suite must pass unchanged with no Clerk key set — the dev path
  is the regression guarantee.
- `apiFetch`: header injection with a mocked token getter; 401 → signOut
  path.

E2E against real Clerk is manual for this sub-project; Playwright auth
fixtures (cv_lator style) arrive with sub-project 4.

## Out of scope

Per-user data keying, broker credentials, hosted MCP bridge, deployment
config, admin roles, feature gating. `request.state.user_id` is the only
deliverable surface.
