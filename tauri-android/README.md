# Chartkar Android app

Tauri 2 Android app. The WebView loads the hosted site itself
(`https://chartkar.app`), so every web deploy reaches the app at once and
Clerk runs first party: a bundled UI on `http://tauri.localhost` could sign
in but lost the session on restart, because Clerk's `SameSite=Lax` client
cookie is never stored cross-site. Sign-in happens in the user's default
browser and returns to the app through an Android App Link.

Design: `docs/superpowers/specs/2026-09-29-android-app-design.md`.

## Setup

Rust Android targets and env vars (in `~/.zshrc`):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
```

## Build

```bash
cd tauri-android/src-tauri
cargo tauri android dev          # debug build on an emulator or USB device
cargo tauri android build --aab  # release bundle for Play
```

No frontend build step: the app shows whatever is deployed to chartkar.app.
To point a debug build at a local dev server instead (adb reverse the ports
first), override the URL:

```bash
adb reverse tcp:5173 tcp:5173 && adb reverse tcp:8000 tcp:8000
cargo tauri android build --debug --apk --target aarch64 \
  --config '{"build":{"frontendDist":"http://localhost:5173"}}'
```

## Release

Upload key: `~/keys/chartkar-upload.jks` (alias `upload`), password in
`~/keys/chartkar-upload.properties`. Both live outside the repo; back them up
in a password manager. Gradle reads them through
`src-tauri/gen/android/keystore.properties` (gitignored, same content); with
no such file a release build is left unsigned.

```bash
cd tauri-android/src-tauri
cargo tauri android build --aab   # all four ABIs, signed with the upload key
# -> gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

Bump `version` in `tauri.conf.json` for every upload (Tauri derives
`versionCode` from it).

`frontend/public/.well-known/assetlinks.json` lists the debug and upload key
fingerprints. After enrolling in Play App Signing, add the app-signing key's
SHA-256 from Play Console > Setup > App signing, or the App Link will not
verify for Play installs.

### Play gates

| Gate | Status |
| --- | --- |
| Developer account | not started |
| Internal testing upload | not started |
| Closed test, 12 testers for 14 days (new personal accounts) | not started |
| Account deletion reachable in the app | to check: Clerk "Allow users to delete their accounts" |
| Data safety form (email, alert and trading settings, broker connections) | not started |
| Privacy policy URL `https://chartkar.app/privacy/` | exists |

