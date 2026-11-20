# Chartkar Android app (native)

A small Kotlin app around a WebView on `https://chartkar.app`. It replaces the
Tauri app in `tauri-android/` (kept for now as a rollback). Design:
`docs/superpowers/specs/2026-11-20-native-android-shell-design.md`.

What the native side does: browser sign-in through the App Link
`https://chartkar.app/app-auth/callback`, Back asks the page first
(`window.__chartkarBack`), cookies flushed on pause, and the
`window.ChartkarAndroid.invoke(cmd, argsJson)` bridge (`browser_sign_in`,
`notify_native`, `read_clipboard`) that `frontend/src/lib/shellBridge.ts`
detects.

## Build

Needs JDK 17 and the Android SDK (`local.properties` with `sdk.dir`).

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
./gradlew :app:testDebugUnitTest        # sign-in rules (JVM tests)
./gradlew :app:assembleDebug            # Chartkar dev, beside the real app
./gradlew :app:assembleRelease          # signed with the upload key
./gradlew :app:bundleRelease            # AAB for Play
```

Release signing reads `keystore.properties` (gitignored: `password`,
`keyAlias`, `storeFile`, today `~/keys/chartkar-upload.jks`).

Debug builds install as `app.chartkar.android.dev` ("Chartkar dev") so they
never replace the real app. Their App Link does not verify, so browser
sign-in needs a release build. Point a debug build at a local dev server:

```bash
adb reverse tcp:5173 tcp:5173 && adb reverse tcp:8000 tcp:8000
./gradlew :app:installDebug -PstartUrl=http://localhost:5173
```

The release build uses versionCode 1001 (the Tauri app was 1000), so it
updates the installed Tauri app in place: same id, same keys.

Gradle repositories are settings-only on purpose:
`~/.gradle/init.d/google-maven-mirror.gradle` adds its Google mirror there.

## Push (FCM)

The backend sends every alert fire to the app as a data-only FCM message
(`backend/auto_trader/core/fcm_notify.py`); `ChartkarMessagingService` shows
it on the "Alerts" channel. A tap opens the alert's chart
(`?alertEpic=`); a position alert's Remove SL / Remove TP opens
`?removeLevel=<token>`, where the page asks first
(`frontend/src/lib/appPush.ts`). The page sends this phone's token to
`/api/alerts/fcm/register` on every boot (bridge command `fcm_token`).

Push stays off until Firebase is set up:

1. Firebase console: create a project, add Android apps
   `app.chartkar.android` and `app.chartkar.android.dev`, and download
   `google-services.json` into `android/app/` (gitignored).
2. Project settings > Service accounts > Generate new private key. Put the
   JSON on the API host and set `FCM_SERVICE_ACCOUNT_FILE=/path/to/it`.
3. Hosted API (Iran VPS): add `fcm.googleapis.com` and
   `oauth2.googleapis.com` to the claude-gateway Xray allowlist.
