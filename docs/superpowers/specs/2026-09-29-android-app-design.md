# Chartkar Android app (sub-project A)

## Goal

Ship Chartkar as a real, self-contained Android app that can go on the Play
Store. The UI is bundled inside the APK; only data comes from the hosted
backend. Sign-in happens in the user's default browser so saved credentials
and password managers work.

Out of scope here (sub-project B, its own spec later): push alerts through
Firebase Cloud Messaging and a matching FCM channel in the backend alert
fan-out.

## What the user said vs what is assumed

Said:
- Wants all of: store presence, reliable phone alerts, a better full-screen
  chart than the mobile browser. The main driver is distributing a real
  self-contained app.
- UI bundled in the APK (option 1), not a shell around chartkar.app.
- Sign-in must happen in the default browser.

Assumed (correct me):
- Distribution target is the Google Play Store. A sideloadable APK comes for
  free from the same build.
- The app talks to the same hosted backend as chartkar.app; no offline data.
- The existing mobile web layout is the app's UI; no Android-only screens.

## Architecture

A new Tauri 2 project at `tauri-android/`, separate from `tauri-shell/`.
The desktop shell is a macOS menu-bar container that loads a URL (tray,
global hotkey, autostart, App Nap, Dock icon); almost none of that applies,
and its frontend source is the opposite of this one (remote URL vs bundled
build). Sharing one project would mean `cfg` gates on most of `main.rs`.

- `frontendDist` points at a production build of `frontend/` made with:
  - `VITE_API_BASE`: the hosted API origin.
  - `VITE_CLERK_PUBLISHABLE_KEY`: the production Clerk key.
  - `VITE_AGENT_BRIDGE`: left unset (bridge off).
- Identifier `app.chartkar.android` (the desktop's
  `com.mahan.autotrader.shell` is tied to the old name).
- Plugins: `tauri-plugin-opener` (open the browser), `tauri-plugin-deep-link`
  (receive the App Link), `tauri-plugin-store` (persist pending sign-in
  state). No hand-written Kotlin unless the spike requires it.
- The bundled page is served from `http://tauri.localhost` by default. That
  is provisional: spike step 1 may switch it to `https://tauri.localhost`
  (`useHttpsScheme`), and both allowlists below match the exact string, so
  the wrong scheme 401s every call. Whichever origin the spike picks must
  be added to BOTH backend allowlists:
  - `CORS_ORIGINS` (`api/guard.py`), so the browser lets responses through.
  - `CLERK_AUTHORIZED_PARTIES` (`api/auth.py:152`), because session tokens
    minted in the webview carry that origin as `azp`; without it every API
    call 401s.
  Plus whatever Clerk-side origin allowlist the spike shows is needed.

The frontend already has the seam: `lib/shellBridge.ts` (`inShell`,
`shellInvoke`) is true inside any Tauri webview, and `ShellTicketSignIn`
already consumes `?__clerk_ticket=`. The Android app implements the same
`browser_sign_in` command name, but the frontend still needs two small
branches (see "Frontend changes for the handoff" below): the button's
success check, and the handoff page's return path.

`inShell()` is also true in the desktop shell, so Android-only behavior
(hidden `<SignIn />` card, hidden push toggle, `return=app` handoff) keys on
a new `inAndroidApp()` in `shellBridge.ts`, true when `inShell()` and the
user agent says Android.

## Sign-in flow

1. The signed-out screen shows "Sign in with your browser" (existing button).
   It calls `browser_sign_in`. On Android the embedded Clerk `<SignIn />`
   card (`ShellTicketSignIn.tsx:58`) is hidden, so browser sign-in is the
   only path. The desktop shell keeps both.
2. The app makes a random 32-byte `state` and persists it with a 5 minute
   deadline in app-private storage (`tauri-plugin-store`), not memory:
   Android may kill the backgrounded app while the user is in the browser,
   and the callback then cold-starts it. It opens the default browser at
   `https://chartkar.app/?shell_auth=1&return=app&state=<state>`.
3. The handoff page (`ShellAuthHandoff`, inside `<SignedIn>`) mints the
   single-use token via `POST /api/auth/shell-token` on page load, as today.
   With `return=app` it does not redirect to `127.0.0.1`; it shows a
   "Return to Chartkar" button whose href is an Android Intent URL:
   `intent://chartkar.app/app-auth/callback?ticket=..&state=..#Intent;scheme=https;package=app.chartkar.android;S.browser_fallback_url=<encoded https://chartkar.app/app-auth/callback>;end`
   - Why not a plain `https://chartkar.app/app-auth/callback` link: Chrome
     does not hand a same-site navigation to a verified App Link app, so
     from a chartkar.app page it would just stay in the browser.
   - Why a tap: Chrome only follows an intent navigation on a user gesture.
   - The intent pins the package, so no other app can receive the ticket.
   - The fallback URL carries no ticket.
   - Build the URL with `URLSearchParams` (ticket, state) and
     `encodeURIComponent` (the fallback URL), never by string concatenation.
   - Minting on load keeps the gesture intact but starts the token's 5
     minute TTL at page load, not at the tap. The page says so if the tap
     comes late (the ticket then fails in step 5 and the user retries).
4. `/app-auth/callback` is also registered as an Android App Link, verified
   by `frontend/public/.well-known/assetlinks.json` (package name + signing
   key SHA-256), for links opened from mail or other apps. If the link opens
   in the browser anyway (app not installed, verification failed), the
   callback route renders a short page saying to open the Chartkar app and
   try again. It never renders the ticket. `main.tsx` boots by pathname
   checks (like `shouldBootAdmin`), not a router, so this is one more such
   check.
5. The app receives the link through the deep-link plugin and reads the
   persisted state:
   - Match and not expired: clear it, navigate the webview to the bundled
     index with `?__clerk_ticket=<ticket>`; `ShellTicketSignIn` finishes the
     sign-in.
   - Expired, or nothing pending: clear it and show "Sign-in expired, try
     again" on the sign-in screen. Never a silent drop.
   - Mismatch: drop the link without navigating; the pending state stays.

## Frontend changes for the handoff

- Button success check. `ShellTicketSignIn.tsx:65-67` treats any
  non-number reply from `browser_sign_in` as failure (the desktop returns
  its loopback port; `browser_auth.rs:79-80` documents that contract).
  Android's command returns `true` once the browser is opened, `null` on
  failure (as `shellInvoke` already maps errors). The check becomes
  "`number` or `true` is success". No fake port.
- Params type. `ShellAuthParams` (`shellAuthBoot.ts:5-8`) becomes a union:
  `{ kind: "loopback", port, state }` (today's shape, unchanged parsing) and
  `{ kind: "app", state }` (`return=app`, no port). `parseShellAuthParams`
  returns the app shape when `return=app` and a state are present, and
  ignores any port in that case.
- Handoff page. `ShellAuthHandoff.tsx:37-40` builds the `127.0.0.1` URL
  unconditionally today. After the mint it branches on `kind`: loopback
  keeps the `window.location.replace`; app stores the token and renders
  the "Return to Chartkar" intent-URL button instead of navigating.

## Hosting

- `/.well-known/assetlinks.json` must be served as `application/json` with
  no redirect. Cloudflare Pages serves `public/` files as-is; verify the
  content type in the spike.
- `/app-auth/callback` has no file behind it. It relies on Pages' SPA
  fallback to `index.html` (there is no `_redirects` file today). Verify it
  answers 200 with the app, and add a `_redirects` rule if not.

## Web push inside the app

`MobileApp.tsx:80` registers `/alert-sw.js` and `pushClient.ts` drives the
push subscription. Neither works in an Android WebView. `pushSupported()`
(`pushClient.ts:13-19`) already hides the toggle when `PushManager` is
missing, but whether the WebView exposes it is unverified (spike step 1).
Until sub-project B, hide the push toggle and skip the service worker
registration when `inAndroidApp()` is true anyway, so the app never offers
push that cannot deliver. Telegram and in-app alert delivery are
unaffected.

## Spike first

Before building the flow, confirm in a throwaway build. Nothing from the
spike is kept; the outcome is a go / adjust note appended to this spec.

1. Clerk in the webview at `http://tauri.localhost`. The known blocker:
   Android WebView blocks third-party cookies by default, and the production
   Frontend API at `clerk.chartkar.app` relies on its `__client` cookie,
   which is cross-site from the app origin. Check whether a session survives
   a reload and an app restart.
   Second risk: `http://tauri.localhost` may not count as a secure context in
   Android WebView (only https, exact `http://localhost` and `file://` are
   guaranteed; see tauri-apps/wry#1710). That can disable WebCrypto,
   service workers and other APIs clerk-js uses. Check
   `window.isSecureContext`, `crypto.subtle`, `'PushManager' in window`, and
   that Clerk initializes and completes a ticket sign-in at all, not just
   that a session persists. If not secure, try Tauri's https scheme option
   (`useHttpsScheme`, origin `https://tauri.localhost`) before plan B; the
   chosen origin is what goes into the two backend allowlists.
   Plan B, named up front: the headless clerk-js build with
   `standardBrowser: false` and a token cache in app storage (what
   clerk-expo does), passed to `ClerkProvider` through its `Clerk` prop.
2. The backend answers CORS, accepts the `azp`, and the `/ws/*` sockets
   connect from that origin.
3. The Intent URL button on a chartkar.app page in Chrome opens the app
   (the same-site case), and a plain App Link tapped from another app does
   too.
4. Killed-process callback: start sign-in, force-stop the app from
   developer options while in Chrome, tap return. The app cold-starts, finds
   the persisted state, and completes.
5. Whether Tauri 2's Android activity already maps the back button to
   webview history.

## Mobile fit

- Android back button, in order: close the topmost open sheet (bottom
  sheet, tab overview, side panel); else go back in webview history; else
  leave the app. Each sheet pushes one history entry on open and pops it on
  close, so back and the sheet's own close button stay in sync.
- Status and navigation bar insets: already handled (`viewport-fit=cover` in
  `index.html`, `env(safe-area-inset-*)` in `mobile/mobile.css`). Only check
  them on a device.
- Portrait and landscape both allowed.

## Version skew

A released app keeps running an old UI against a newer backend. Backend
changes to routes the app uses stay backward compatible for at least one
release cycle. No forced-update mechanism in this sub-project.

## Release

- Signed Android App Bundle (`.aab`) via `cargo tauri android build`, upload
  keystore kept outside the repo. Its SHA-256 goes into `assetlinks.json`,
  plus Play App Signing's key once enrolled.
- `versionCode` derived from the app version.
- Play gates:
  - Testing track: personal developer accounts must run a closed test with
    at least 12 testers for 14 consecutive days before production access
    (accounts created after 2023-11-13). The internal track is optional but
    useful for the first smoke builds; the closed test is the actual gate.
  - Account deletion: apps with sign-up must offer an in-app or web path to
    delete the account, linked in the console. Check whether Clerk's
    `<UserProfile />` delete option covers it; if not, add a web page.
  - Data safety form: declare account data, alert and trading settings,
    and the broker connections.
  - Privacy policy: the existing `frontend/public/privacy` page.
- The developer account itself is a one-time user action.

## Error handling

- Browser handoff errors keep the existing handoff page messages.
- An expired or missing pending state shows "Sign-in expired, try again";
  a mismatched callback is dropped. No partial state survives either way.
- A ticket that fails in `ShellTicketSignIn` shows its existing failure path.
- Backend unreachable: the bundled UI still loads and shows its normal
  connection errors.

## Testing

- Rust unit tests: callback URL parsing; state match, mismatch, expiry, and
  nothing pending; state read back after a simulated restart.
- Frontend unit tests: `parseShellAuthParams` for both union shapes (app
  shape ignores a stray port); the sign-in button treating `true` as
  success and `null` as failure;
  the handoff page rendering an intent-URL button instead of redirecting;
  the fallback URL carrying no ticket; the push toggle and `<SignIn />`
  card hidden when `inAndroidApp()`; the back handler closing the
  topmost sheet first.
- Backend: CORS and authorized-party allowlists include the app origin when
  configured.
- Manual on an emulator and one real device: fresh install, browser sign-in
  with a saved password, killed-process sign-in, sign-out and back in, back
  button with a sheet open, rotation.
  Android builds are CPU-heavy on the laptop; ask before running them.
