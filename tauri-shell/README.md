# Auto Trader shell

A thin macOS menu-bar app that hosts the existing auto_trader UI in a WKWebView,
so the browser-driven live engine cannot be killed by a stray Cmd-W or a closed
browser window.

It is a container and nothing else. It does **not** start the Python backend or
the Vite dev server: start those exactly as you do today. The shell only loads a
URL (default `http://localhost:5173`, user-settable in Settings).

## Run

```bash
cd tauri-shell/src-tauri
cargo tauri dev
```

## Build

```bash
cd tauri-shell/src-tauri
cargo tauri build
open target/release/bundle/macos/
```

## Rendering caveat

The UI is developed and tested in Chrome (Blink); this shell renders in macOS's
WKWebView (WebKit). Plain React is a non-issue, but the canvas-heavy chart
(klinecharts) is the thing to watch. If it ever renders wrong here, the
documented fallback is an Electron shell with the same window and tray design:
see `docs/superpowers/specs/2026-07-08-tauri-menubar-wrapper-design.md`.

## What lives where

```
tauri-shell/
  ui/settings.html     UI address + launch at login
  ui/splash.html       "waiting for <url>" with auto-retry
  src-tauri/
    src/main.rs        tray, hotkey, close-to-hide, settings commands, badge
    src/settings.rs    the persisted URL + autostart pair
    src/appnap.rs      the process-lifetime activity assertion
    src/browser_auth.rs the loopback listener + state nonce for browser sign-in
    capabilities/      default.json (bundled pages) + served-ui.json (the served UI origins)
    Info.plist         NSAppSleepDisabled, merged into the bundle
```

Settings live in `~/Library/Application Support/com.mahan.autotrader.shell/settings.json`.

Launch at login registers the binary that is running when the shell starts, and
re-registers it on every launch, so a dev-build registration cannot survive into
the shipped app. Copy `Auto Trader.app` out of `target/release/bundle/macos/`
into `/Applications` and launch it once from there: `cargo clean` deletes the
build directory, and the LaunchAgent would point into it otherwise.

Adding a command takes three edits, not one: `generate_handler!`, the
`commands(&[...])` list in `build.rs` (app commands have no ACL entry without
it), and an `allow-<command>` line in both capability files. `browser_sign_in`
(see below) is wired through all three.

## Browser sign-in

Against the hosted app (https://chartkar.app), Google sign-in inside the
WKWebView is painful: WKWebView shares no session with Chrome, so credentials
must be typed by hand, and Google often rejects OAuth in embedded webviews
outright. The signed-out screen shows a "Sign in with your browser" button
(only when running inside the shell) that hands the flow to Chrome, where the
user is likely already signed in.

The flow is an OAuth-style loopback handoff (RFC 8252 shape, the pattern
Claude CLI and gcloud use), with a Clerk single-use sign-in token standing in
for the authorization code:

1. The button invokes `browser_sign_in`, which starts a one-shot listener on
   `127.0.0.1:<random port>`, generates an `OsRng` state nonce, and opens the
   default browser at `<configured-origin>/?shell_auth=1&port=<port>&state=<nonce>`.
2. In Chrome that URL boots a handoff page. Once signed in, it POSTs to
   `/api/auth/shell-token` for a single-use, 5-minute Clerk sign-in token and
   top-level-redirects it to `http://127.0.0.1:<port>/callback?ticket=..&state=..`.
   A top-level redirect, not a fetch: navigating https to a loopback http
   address is not blocked by mixed-content rules, a fetch would be.
3. The listener checks `state`. A wrong value gets a 403 and the listener
   keeps waiting, so a stray request can't burn the slot out from under the
   real callback. A newer sign-in attempt supersedes an older one via a
   compare-and-claim on the pending slot, so only the latest attempt can act.
   The listener has a 2 minute deadline; past it, the slot is released and the
   button can be clicked again.
4. On a matching `state`, the listener replies with a small "Signed in" page,
   navigates the main window to `<configured-url>?__clerk_ticket=<token>`, and
   focuses it. The webview's `ShellTicketSignIn` consumes the ticket
   explicitly and signs in.

`served-ui.json`'s remote urls now also include `https://chartkar.app` and
`https://www.chartkar.app` (this also fixed native banners and the tray glyph
being dead against the hosted app, which previously matched only the
localhost patterns).

## Keys and gestures

- Red button, Cmd-W, Cmd-Q: hide. The tray menu's Quit is the only real exit.
- Cmd-Alt-T from anywhere: show and focus.
- Tray left-click: toggle. Tray right-click: Show, Hide, Reload, Settings, Quit.
- Reload sends the window back to the splash, so a wedged UI lands on the retry
  loop rather than a raw WebKit error page.

## Verified 2026-09-11

Checked programmatically against the running shell:

- klinecharts renders correctly in WKWebView (candles, EMA, FVG zones, both
  trendline sets, alert lines, axis pills, positions dock).
- `invoke` from the `http://localhost:5173` origin reaches shell commands.
- Close hides the window and the process keeps running.
- Tray icon present; glyph turns green on `set_status("live")`.
- Global hotkey registers (`registered=true` at launch).
- Settings load real values, reject a bad URL, persist to the store file, and
  register the LaunchAgent.
- Splash waits on an unreachable address and navigates on its own once the URL
  answers.
- `notify_native` succeeds from the served UI.
- The unread counter increments for alerts fired while hidden (2), clears on
  show, and ignores alerts fired while visible. The dock badge itself is drawn
  by macOS from that count and has not been eyeballed.
- Tray Reload sends the window back to the splash and it stays there while the
  target is down.
- The App Nap assertion is held: `pmset -g assertions` lists it by name against
  the shell process, in both the dev and release builds.
- Release bundle is 9 MB and its Info.plist carries `NSAppSleepDisabled`.

Still to check by hand, since they need a real person at the keyboard:

- Cmd-W and Cmd-Q hiding (keystroke injection is blocked without an
  Accessibility grant).
- Tray left-click toggle and the menu items.
- Cmd-Alt-T summoning from another app.
- A real macOS banner from a real alert, and clicking it.
- The dock badge rendering while alerts pile up hidden.
- Launch at login across an actual reboot.
- App Nap over a 15 minute idle stretch: hide the window with the engine armed,
  then confirm the live log timestamps stayed evenly spaced.
- Browser sign-in end-to-end against chartkar.app: click "Sign in with your
  browser", confirm Chrome opens the handoff page, and confirm the shell lands
  signed in.
- Browser sign-in with Chrome signed out: confirm the normal Clerk sign-in
  shows first, and the handoff still completes after signing in there.
- Browser sign-in listener timeout: click the button, wait past 2 minutes
  without completing the Chrome side, and confirm the button can be clicked
  again afterward.
