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
