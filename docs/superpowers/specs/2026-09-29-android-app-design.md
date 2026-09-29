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
- Distribution target is the Google Play Store, starting on the internal
  testing track. A sideloadable APK comes for free from the same build.
- The app talks to the same hosted backend as chartkar.app; no offline data.
- The existing mobile web layout is the app's UI; no Android-only screens.

## Architecture

A new Tauri 2 project at `tauri-android/`, separate from `tauri-shell/`.
The desktop shell is a macOS menu-bar container that loads a URL (tray,
global hotkey, autostart, App Nap, Dock icon); almost none of that applies,
and its frontend source is the opposite of this one (remote URL vs bundled
build). Sharing one project would mean `cfg` gates on most of `main.rs`.

- `frontendDist` points at a production build of `frontend/` made with
  `VITE_API_BASE` set to the hosted API origin.
- Identifier `app.chartkar.android` (the desktop's
  `com.mahan.autotrader.shell` is tied to the old name).
- Plugins: `tauri-plugin-opener` (open the browser), `tauri-plugin-deep-link`
  (receive the App Link). No hand-written Kotlin unless the spike requires it.
- The bundled page is served from `http://tauri.localhost`; that origin goes
  into the backend's `CORS_ORIGINS` and whatever Clerk origin allowlist the
  spike shows is needed.

The frontend already has the seam: `lib/shellBridge.ts` (`inShell`,
`shellInvoke`) is true inside any Tauri webview, and `ShellTicketSignIn`
already consumes `?__clerk_ticket=`. The Android app implements the same
`browser_sign_in` command name, so the sign-in button needs no new frontend
branch beyond the return path.

## Sign-in flow

1. The signed-out screen shows "Sign in with your browser" (existing button).
   It calls `browser_sign_in`.
2. The app makes a random 32-byte `state`, keeps it in memory with a 5 minute
   deadline, and opens the default browser at
   `https://chartkar.app/?shell_auth=1&return=app&state=<state>`.
3. The handoff page (`ShellAuthHandoff`, inside `<SignedIn>`) mints the
   single-use token via `POST /api/auth/shell-token` as today. With
   `return=app` it does not redirect to `127.0.0.1`; it shows a
   "Return to Chartkar" button linking to
   `https://chartkar.app/app-auth/callback?ticket=..&state=..`.
   A tap is required on purpose: Chrome does not hand a script-driven
   redirect without a user gesture to another app, so an automatic redirect
   would silently stay in the browser.
4. `/app-auth/callback` is an Android App Link, verified by
   `frontend/public/.well-known/assetlinks.json` (package name + signing key
   SHA-256), so only the Chartkar app can receive it; a `chartkar://` scheme
   would be claimable by any app. If the link opens in the browser anyway
   (app not installed, verification failed), the callback route renders a
   short page saying to open the Chartkar app and try again. It never
   renders the ticket.
5. The app receives the link through the deep-link plugin, checks `state`
   against the pending one (mismatch, expired, or none pending: drop it),
   clears the pending state, and navigates the webview to its bundled index
   with `?__clerk_ticket=<ticket>`. `ShellTicketSignIn` finishes the sign-in.

`parseShellAuthParams` grows a second shape: `return=app` with a `state` and
no port. The desktop loopback shape is unchanged.

## Spike first: Clerk from a non-chartkar origin

Before building the flow, confirm in a throwaway build:
- Clerk's production instance loads and keeps a session in a webview at
  `http://tauri.localhost` (its session cookie is normally scoped to
  chartkar.app). If not, try Clerk's allowed-origins setting, then its
  native-app mode, before redesigning.
- The backend answers CORS and the `/ws/*` sockets from that origin.
- A tap on an App Link inside the default browser opens the app.

Outcome is a go / adjust note appended to this spec. Nothing from the spike
is kept.

## Mobile fit

- Android back button: go back in webview history; at the root, leave the
  app. Open side panels already close through their own UI.
- Respect status and navigation bar insets (`viewport-fit=cover` plus the
  existing safe-area CSS if any; add where missing).
- Portrait and landscape both allowed.

## Version skew

A released app keeps running an old UI against a newer backend. Backend
changes to routes the app uses stay backward compatible for at least one
release cycle. No forced-update mechanism in this sub-project.

## Release

- Signed Android App Bundle (`.aab`) via `cargo tauri android build`, upload
  keystore kept outside the repo; its SHA-256 goes into `assetlinks.json`
  (plus Play App Signing's key once enrolled).
- `versionCode` derived from the app version.
- Play Console listing uses the existing privacy page
  (`frontend/public/privacy`). The developer account is a one-time user
  action.

## Error handling

- Browser handoff errors keep the existing handoff page messages.
- A dropped or mismatched callback leaves the user on the sign-in screen
  with the button still available; no partial state survives.
- A ticket that fails in `ShellTicketSignIn` shows its existing failure path.
- Backend unreachable: the bundled UI still loads and shows its normal
  connection errors.

## Testing

- Rust unit tests: callback URL parsing, state match / mismatch / expiry.
- Frontend unit tests: `parseShellAuthParams` for the `return=app` shape,
  the handoff page rendering the return button instead of redirecting.
- Backend: CORS allowlist includes the app origin when configured.
- Manual on an emulator and one real device: fresh install, browser sign-in
  with a saved password, sign-out and back in, back button, rotation.
  Android builds are CPU-heavy on the laptop; ask before running them.
