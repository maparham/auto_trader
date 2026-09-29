# Chartkar Android app

Tauri 2 Android app. The UI is the regular `frontend/` production build,
bundled into the APK; only data comes from the hosted backend
(`https://api.chartkar.app`). Sign-in happens in the user's default browser
and returns to the app through an Android App Link.

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

Both run `scripts/build-frontend.sh` first, which builds `frontend/` into
`frontend/dist-android` with the same API base and Clerk key the hosted
build uses (`scripts/deploy-demo.sh`).
