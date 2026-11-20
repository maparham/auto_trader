# Native Kotlin Android shell

Step 2 of 3 for the Android app (1: alerts parity, done; 3: FCM push).
The user chose this over keeping Tauri, after being told a full native
rewrite is not worth it; they asked me to make the calls without asking.

## Why

The Tauri shell only opens chartkar.app in a WebView and runs browser
sign-in, about 300 lines of Rust. Push (FCM), notification channels and
buttons, and later widgets are ordinary Android code, and fighting Tauri's
generated Gradle project for each one costs more than owning a small Kotlin
app.

## Goals

- A plain Android Studio / Gradle project at `android/` that does everything
  the Tauri shell does:
  - WebView on `https://chartkar.app` (a debug build can point elsewhere with
    `-PstartUrl=http://localhost:5173`, after `adb reverse`).
  - Browser sign-in: `browser_sign_in` opens
    `https://chartkar.app/?shell_auth=1&return=app&state=<random>`, keeps the
    pending state (5 minute TTL) in SharedPreferences because Android may
    kill the app meanwhile, and the App Link
    `https://chartkar.app/app-auth/callback?ticket=..&state=..` loads
    `<origin>/?__clerk_ticket=<ticket>` (or `?auth_error=expired`). Same rules
    as `auth.rs`: wrong scheme, host or path, or an empty value is ignored; a
    different state is dropped; a missing or expired pending state gives
    `auth_error=expired`.
  - Back asks the page first (`window.__chartkarBack`), then WebView history,
    then leaves the app.
  - Cookies flushed on pause (Clerk's session cookie).
  - Edge-to-edge.
- Same app id `app.chartkar.android`, versionCode above the installed 1000,
  so it updates the Tauri app in place. Debug builds use the debug key and
  release builds the upload key (`~/keys/chartkar-upload.jks`); both
  fingerprints are already in `assetlinks.json`, so the App Link keeps
  verifying.
- A JavaScript bridge `window.ChartkarAndroid.invoke(cmd, argsJson)` that
  returns a JSON string. The frontend's `lib/shellBridge.ts` treats it as a
  shell: `inShell()` and `inAndroidApp()` are true, `shellInvoke` routes
  through it. Commands: `browser_sign_in` (true), `notify_native`
  (`{title, body}`, a local notification; the Tauri app dropped these
  silently), `read_clipboard` (text or null). Unknown commands give null.
- Notification permission is asked once on Android 13+.

## Non-goals

- No change to the web UI beyond the bridge detection.
- FCM is step 3 (its own design).
- The Tauri project stays in the repo until the native app has been used for
  a while; deleting it is a later, separate change.

## Approaches

1. Keep Tauri, add Kotlin for FCM. Rejected by the user.
2. **Chosen:** small native Kotlin shell around the same WebView.
3. Full native rewrite. Rejected: about 144k lines of web UI to redo.

## Calls I made

- Gradle: AGP 8.11.0, Kotlin 1.9.25, compile/target SDK 36, min SDK 24 (the
  versions already cached for the Tauri build).
- Pure sign-in logic in `SignIn.kt` with JUnit tests ported from `auth.rs`.
- Links to other hosts open in the browser; chartkar.app, accounts.chartkar.app
  (Clerk) and the debug start origin stay in the WebView.
- File chooser supported (CSV/JSON imports use `<input type=file>`).
