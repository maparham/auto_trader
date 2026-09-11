# Browser-auth handoff for the Tauri shell

**Date:** 2026-09-11
**Status:** Shipped 2026-09-11 (plan: docs/superpowers/plans/2026-09-11-shell-browser-auth.md)

## Problem

The Tauri shell pointed at the hosted deployment (https://chartkar.app) lands
on the Clerk sign-in page. Google sign-in there is painful: WKWebView shares no
session with Chrome, so credentials must be typed by hand, and Google often
rejects OAuth in embedded webviews outright (`disallowed_useragent`).

The user is already signed in on Chrome. We want to start authentication in the
default browser and finish it in the shell.

## Approach

An OAuth-style loopback handoff (RFC 8252, the pattern Claude CLI and gcloud
use), with a Clerk **sign-in token** playing the role of the authorization
code:

1. Signed out inside the shell, the frontend shows a **"Sign in with your
   browser"** button under the Clerk card (only when `inShell()`). Clicking it
   invokes a new shell command `browser_sign_in`.
2. The shell generates a random `state` nonce, starts a one-shot HTTP listener
   on `127.0.0.1:<random port>`, and opens the default browser at
   `<configured-origin>/?shell_auth=1&port=<port>&state=<nonce>`.
3. In Chrome that URL boots a small handoff component inside the Clerk tree
   (same query-param boot pattern as `?snapshot=1`). If Chrome is signed out,
   the normal Clerk sign-in shows first; the query params survive. Once signed
   in, the component POSTs to the new backend endpoint, receives a sign-in
   token, and performs a **top-level redirect** to
   `http://127.0.0.1:<port>/callback?ticket=<token>&state=<nonce>`.
   A redirect, not fetch: top-level navigation from https to a loopback http
   address is not blocked by mixed-content rules, a fetch would be.
4. The listener validates `state`, replies with a tiny "Signed in, return to
   Auto Trader" page, shuts down, and navigates the main window to
   `<configured-url>?__clerk_ticket=<token>`.
5. In the webview, the signed-out branch sees `__clerk_ticket` and consumes it
   explicitly (`signIn.create({ strategy: "ticket", ticket })` then
   `setActive`), rendering "Signing you in..." instead of the Clerk card so
   the single-use ticket cannot be double-consumed. On failure it clears the
   param and falls back to the normal sign-in page.

## Components

### Backend: `POST /api/auth/shell-token`

- New router `backend/auto_trader/api/routers/shell_auth.py`, registered in
  `app.py`'s router loop.
- Authenticated by the existing Clerk JWT middleware; reads the caller's id via
  `deps.current_user`. It can only mint a token for the user who is already
  signed in, so it grants nothing new.
- Calls Clerk's Backend API `POST /v1/sign_in_tokens` with
  `{"user_id": <caller>, "expires_in_seconds": 300}` using `CLERK_SECRET_KEY`,
  in the `core/clerk_admin.py` style: secret read per request from the env,
  never logged or echoed; unconfigured returns 503; upstream failure returns
  502 with a generic message.
- In local dev (auth disabled, user id "dev") the endpoint returns 503: the
  handoff is a hosted-mode feature.
- Response: `{"token": "<sign-in token>"}`.

### Frontend (three seams)

- `frontend/src/lib/shellAuthBoot.ts`: pure parsing, mirroring
  `snapshotBoot.ts`: `parseShellAuthParams(search)` returns
  `{ port, state } | null` (requires `shell_auth=1`, an integer port
  1–65535, non-empty state), and `parseClerkTicket(search)` returns the
  `__clerk_ticket` value or null.
- `frontend/src/components/ShellAuthHandoff.tsx`: the Chrome side. Rendered
  inside `<SignedIn>` when `parseShellAuthParams` matches. Calls the backend
  endpoint via the normal authed `apiFetch`, then
  `location.replace("http://127.0.0.1:<port>/callback?ticket=...&state=...")`.
  Shows a one-line status; errors (503/502/network) render as text with no
  retry loop; closing the tab and clicking the shell button again is the
  retry.
- `frontend/src/components/ShellTicketSignIn.tsx`: the webview side. Rendered
  in the `<SignedOut>` branch when `__clerk_ticket` is present: consumes the
  ticket via Clerk's `useSignIn`, calls `setActive` with the created session,
  and on any failure strips the param from the URL and falls back to the
  normal sign-in card. The "Sign in with your browser" button (shown under the
  Clerk card when `inShell()`) also lives here and calls
  `shellInvoke("browser_sign_in")`.
- `frontend/src/main.tsx`: wires the two branches into the existing Clerk
  tree. Plain-browser and local-dev behavior unchanged: no shell, no params,
  no new UI.

### Shell (Rust)

- New `tauri-shell/src-tauri/src/browser_auth.rs`:
  - `browser_sign_in` command: generate a 32-byte hex `state` nonce, bind a
    TCP listener on `127.0.0.1:0` (OS-assigned port), spawn a thread that
    accepts **one** connection with a 2-minute deadline, then open the default
    browser via `tauri_plugin_opener` at the handoff URL built
    from the configured settings URL's origin.
  - Callback parsing: pull `ticket` and `state` from the request line of the
    single accepted HTTP request; wrong or missing state gets a 403 body and
    the listener keeps waiting until the deadline (the attacker must not be
    able to burn the slot). Correct state gets a 200 "return to Auto Trader"
    page, then the main window navigates to
    `<configured-url>?__clerk_ticket=<ticket>`.
  - A second `browser_sign_in` while one is pending cancels the old listener
    and starts fresh.
- Three-edit rule for the new command: `generate_handler!`, `build.rs`
  manifest, both capability files.
- `capabilities/served-ui.json` gains `https://chartkar.app` (and
  `https://www.chartkar.app`) in `remote.urls`. This also fixes the previously
  flagged prod gap: native banners and the tray status glyph were silently
  dead when the shell pointed at the hosted app.

## Security

- The sign-in token is minted server-side, only for the already-authenticated
  caller, single-use, 5-minute expiry.
- The `state` nonce ties the callback to the pending request: it travels only
  from the shell to the browser and back. A local attacker racing the port needs the nonce.
- The listener binds 127.0.0.1 only, serves one successful request, and dies
  after 2 minutes.
- The ticket appears briefly in the webview URL (`__clerk_ticket`); it is
  stripped immediately after consumption and is worthless once used or
  expired.

## Error handling

- Listener timeout: the shell just drops the pending state; the sign-in page
  is still showing, the user clicks the button again.
- Backend unconfigured (local dev) or Clerk API down: the Chrome handoff page
  shows the error text; nothing reaches the shell.
- Bad/expired ticket in the webview: fall back to the normal Clerk sign-in
  card with the param stripped.
- The shell command failing (port bind, browser launch) surfaces as the
  invoke's error string next to the button.

## Testing

- Backend: pytest for the endpoint using the existing `tests/clerk_fake.py`
  pattern: happy path (token returned for the request user), then unconfigured
  gives 503, Clerk failure gives 502, and unauthenticated gives 401 via the
  existing middleware tests' approach.
- Frontend (vitest, affected files only): `shellAuthBoot` parsing;
  `ShellTicketSignIn` consumes a ticket / falls back on failure / renders the
  browser button only when `inShell()`; `ShellAuthHandoff` posts and
  redirects.
- Rust: unit tests for callback request parsing and state validation.
- Manual end-to-end against chartkar.app: click the button, Chrome opens
  signed in, the shell lands signed in; repeat with Chrome signed out; let the listener
  time out.

## Out of scope

- Sign-out handoff, multi-account, token refresh (Clerk sessions already
  persist in WKWebView).
- Making the handoff work for local dev (auth is disabled there).
