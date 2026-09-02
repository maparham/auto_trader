#!/usr/bin/env bash
# Deploy the authenticated hosted app (https://trader.rahkar.pro) in one go:
#   backend  -> Lightsail box (systemd auto-trader-demo, uvicorn on 127.0.0.1:8010,
#               reached via the aws-vps Cloudflare Tunnel as trader-api.rahkar.pro)
#   frontend -> Cloudflare Pages project auto-trader-demo (trader.rahkar.pro +
#               auto-trader-demo.pages.dev)
#
# Builds from committed HEAD via a temporary worktree, NEVER from the working
# tree — concurrent sessions share this checkout, so the working tree may hold
# someone else's uncommitted WIP. Commit what you want deployed first.
#
# Sign-in required (Clerk) — the box env must carry CLERK_JWKS_URL and
# CLERK_AUTHORIZED_PARTIES. VITE_CLERK_PUBLISHABLE_KEY is baked into the
# frontend build. The preflight check fails the deploy if Clerk vars are missing.
#
# Prereqs: `wrangler login` (pages:write), ssh access via ~/.ssh/id_ed25519.
#
# Usage: scripts/deploy-demo.sh [--frontend-only | --backend-only]

set -euo pipefail

HOST="ec2-user@3.139.146.5"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)
PAGES_PROJECT="auto-trader-demo"
API_BASE="https://trader-api.rahkar.pro"
CLERK_PK="pk_live_Y2xlcmsudHJhZGVyLnJhaGthci5wcm8k"

DO_FRONTEND=1
DO_BACKEND=1
case "${1:-}" in
  --frontend-only) DO_BACKEND=0 ;;
  --backend-only) DO_FRONTEND=0 ;;
  "") ;;
  *) echo "usage: $0 [--frontend-only | --backend-only]" >&2; exit 2 ;;
esac

echo "==> preflight: box env must be hosted-mode (Clerk vars present)"
rc=0
"${SSH[@]}" "$HOST" '
  grep -q "^CLERK_JWKS_URL=" /etc/auto-trader/demo.env \
    && grep -q "^CLERK_AUTHORIZED_PARTIES=" /etc/auto-trader/demo.env
' || rc=$?
if [ "$rc" -eq 1 ]; then
  echo "FAIL: /etc/auto-trader/demo.env is missing CLERK_JWKS_URL / CLERK_AUTHORIZED_PARTIES — add them first (see docs/superpowers/specs/2026-09-02-hosted-deployment-design.md §5)" >&2
  exit 1
elif [ "$rc" -ne 0 ]; then
  echo "FAIL: could not reach the box over SSH (exit $rc) — preflight not run" >&2
  exit 1
fi

echo "==> preflight: no broker credentials on the box"
rc=0
# Match only env ASSIGNMENTS whose variable name references a credentialed
# broker (CAPITAL_*/IG_*/MT5_* and the like) — comments legitimately mention
# these brokers when documenting their exclusion.
"${SSH[@]}" "$HOST" 'grep -Eiq "^[a-z_]*(capital|mt5)[a-z0-9_]*=|^ig_" /etc/auto-trader/demo.env' || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: broker credentials found in /etc/auto-trader/demo.env" >&2
  exit 1
elif [ "$rc" -ne 1 ]; then
  echo "FAIL: could not reach the box over SSH (exit $rc) — leak check not run" >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
WT="$(mktemp -d)/demo-deploy"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> building from committed HEAD ($HEAD_SHA) in a clean worktree"
git -C "$ROOT" worktree add --detach --quiet "$WT" HEAD

if [ "$DO_BACKEND" = 1 ]; then
  echo "==> backend: rsync -> $HOST:/opt/auto-trader/backend"
  rsync -az --delete \
    --exclude '__pycache__' --exclude '*.db' --exclude '.pytest_cache' \
    -e "ssh -i $SSH_KEY -o BatchMode=yes" \
    "$WT/backend/" "$HOST:/opt/auto-trader/backend/"

  echo "==> backend: pip install + restart auto-trader-demo"
  "${SSH[@]}" "$HOST" '
    set -e
    /opt/auto-trader/venv/bin/pip install -q --no-cache-dir /opt/auto-trader/backend
    sudo systemctl restart auto-trader-demo
    for i in $(seq 1 20); do
      sleep 1
      if curl -sf -m 5 http://127.0.0.1:8010/health >/dev/null; then exit 0; fi
    done
    echo "backend failed to come up; last log lines:" >&2
    sudo journalctl -u auto-trader-demo -n 20 --no-pager >&2
    exit 1
  '
fi

if [ "$DO_FRONTEND" = 1 ]; then
  echo "==> frontend: vite build (VITE_API_BASE=$API_BASE)"
  ln -s "$ROOT/frontend/node_modules" "$WT/frontend/node_modules"
  (cd "$WT/frontend" && VITE_API_BASE="$API_BASE" VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PK" npx vite build >/dev/null)
  grep -rq "$API_BASE" "$WT/frontend/dist/assets" \
    || { echo "API base not found in bundle — build misconfigured" >&2; exit 1; }
  grep -rq "$CLERK_PK" "$WT/frontend/dist/assets" \
    || { echo "Clerk publishable key not found in bundle — build misconfigured" >&2; exit 1; }
  printf '/* /index.html 200\n' > "$WT/frontend/dist/_redirects"

  echo "==> frontend: wrangler pages deploy ($PAGES_PROJECT)"
  (cd "$WT/frontend" \
    && npx wrangler pages deploy dist --project-name "$PAGES_PROJECT" --branch main)
fi

echo "==> smoke test"
curl -sf -m 15 "$API_BASE/health" >/dev/null || { echo "FAIL: $API_BASE/health" >&2; exit 1; }
BROKERS_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$API_BASE/api/brokers")"
[ "$BROKERS_CODE" = 401 ] || { echo "FAIL: unauthenticated /api/brokers returned $BROKERS_CODE (want 401 — is the box env hosted-mode?)" >&2; exit 1; }
CORS="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H 'Origin: https://trader.rahkar.pro' -H 'Access-Control-Request-Method: GET' \
  "$API_BASE/api/brokers")"
[ "$CORS" = 200 ] || { echo "FAIL: CORS preflight returned $CORS" >&2; exit 1; }
SITE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://trader.rahkar.pro/)"
[ "$SITE" = 200 ] || { echo "FAIL: site returned $SITE" >&2; exit 1; }

echo "==> deployed $HEAD_SHA — https://trader.rahkar.pro"
