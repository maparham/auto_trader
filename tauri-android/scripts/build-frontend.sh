#!/usr/bin/env bash
# Builds frontend/ into frontend/dist-android for the APK. Same values the
# hosted build uses (scripts/deploy-demo.sh), so the app talks to prod.
set -euo pipefail
cd "$(dirname "$0")/../../frontend"
VITE_API_BASE="https://api.chartkar.app" \
VITE_CLERK_PUBLISHABLE_KEY="pk_live_Y2xlcmsuY2hhcnRrYXIuYXBwJA" \
  npx vite build --outDir dist-android --emptyOutDir
