#!/usr/bin/env bash
# Deploy the authenticated hosted app (https://chartkar.app) in one go:
#   backend  -> Lightsail box (systemd auto-trader-demo, uvicorn on 127.0.0.1:8010,
#               reached via the aws-vps Cloudflare Tunnel as api.chartkar.app)
#   frontend -> Cloudflare Pages project auto-trader-demo (chartkar.app,
#               www.chartkar.app + auto-trader-demo.pages.dev; the old
#               trader.rahkar.pro 301s to chartkar.app via a Cloudflare
#               redirect rule)
#
# Builds from committed HEAD via a temporary worktree, NEVER from the working
# tree — concurrent sessions share this checkout, so the working tree may hold
# someone else's uncommitted WIP. Commit what you want deployed first.
#
# Sign-in required (Clerk) — the box env must carry CLERK_JWKS_URL and
# CLERK_AUTHORIZED_PARTIES. VITE_CLERK_PUBLISHABLE_KEY is baked into the
# frontend build. The preflight check fails the deploy if Clerk vars are missing.
#
# Broker credentials and TELEGRAM_BOT_TOKEN are SYNCED to the box from
# backend/.env on every backend deploy (see "backend: sync credentials" below,
# and SYNC_KEYS), so rotating a key means editing backend/.env and re-running
# this script — never hand-editing /etc/auto-trader/demo.env. Only those keys
# are touched, and only the ones actually present in the local file; the box's
# hosted-only settings (Clerk, ADMIN_*, CORS_ORIGINS, FRONTEND_URL) are never
# read from the local file and never removed. COMPUTE_* is deliberately NOT
# synced: it points at this laptop.
#
# TELEGRAM_BOT_TOKEN enables Telegram alert delivery for hosted users, and is
# currently the SAME bot as the laptop's. The backend long-polls getUpdates and
# only one process may poll a token, so a local backend run with that line
# active STEALS /start link codes from the hosted app. Comment it out in
# backend/.env while working locally: the sync skips absent keys, so the box
# keeps the value it already has. A second BotFather bot for prod would end the
# conflict for good.
#
# Optional box env: CLERK_SECRET_KEY — backend only, powers the admin console
# Users panel (/admin). Without it the panel reports "Clerk not configured".
# It must never reach the browser; the frontend build below fails closed if a
# secret key ever appears in the bundle.
#
# Prereqs: `wrangler login` (pages:write), ssh access via ~/.ssh/id_ed25519.
#
# Usage: scripts/deploy-demo.sh [--frontend-only | --backend-only]

set -euo pipefail

HOST="ec2-user@3.139.146.5"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)
PAGES_PROJECT="auto-trader-demo"
API_BASE="https://api.chartkar.app"
CLERK_PK="pk_live_Y2xlcmsuY2hhcnRrYXIuYXBwJA"

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
  sudo grep -q "^CLERK_JWKS_URL=" /etc/auto-trader/demo.env \
    && sudo grep -q "^CLERK_AUTHORIZED_PARTIES=" /etc/auto-trader/demo.env
' || rc=$?
if [ "$rc" -eq 1 ]; then
  echo "FAIL: /etc/auto-trader/demo.env is missing CLERK_JWKS_URL / CLERK_AUTHORIZED_PARTIES — add them first (see docs/superpowers/specs/2026-09-02-hosted-deployment-design.md §5)" >&2
  exit 1
elif [ "$rc" -ne 0 ]; then
  echo "FAIL: could not reach the box over SSH (exit $rc) — preflight not run" >&2
  exit 1
fi

echo "==> preflight: broker credentials (if any) must be admin-gated"
# Broker creds are ALLOWED on the box since the admin gate (spec
# 2026-09-03-admin-gated-brokers-design.md): restricted brokers and all
# dealing are admin-only. But creds WITHOUT an admin gate would expose
# dealing to every signed-in user, so that combination fails the deploy.
# The cred regex matches env ASSIGNMENTS only (comments legitimately mention
# broker names); keep it in sync with config.py's env_prefix set.
ROOT="$(git rev-parse --show-toplevel)"
# Broker-credential keys this script owns on the box. Keep in sync with
# config.py's env_prefix set (and with the cred regex just below).
CRED_KEYS='^(CAPITAL_[A-Z_]*|IG_[A-Z_]*|METAAPI_[A-Z_]*|MT5MCP_[A-Z_]*|OANOR_[A-Z_]*)='
# Every key this script pushes to the box. A SUPERSET of CRED_KEYS, and
# deliberately a separate variable: CRED_KEYS also decides whether the
# admin-gate check below applies (a deploy that pushes broker creds needs the
# gate), so folding a non-broker key into it would let a Telegram-only .env
# waive that gate.
SYNC_KEYS='^(CAPITAL_[A-Z_]*|IG_[A-Z_]*|METAAPI_[A-Z_]*|MT5MCP_[A-Z_]*|OANOR_[A-Z_]*|TELEGRAM_BOT_TOKEN)='
LOCAL_ENV="$ROOT/backend/.env"
SYNC_CREDS=0
if [ "$DO_BACKEND" = 1 ] && [ -f "$LOCAL_ENV" ] \
   && grep -Eq "$CRED_KEYS.+" "$LOCAL_ENV"; then
  SYNC_CREDS=1
fi
DO_SYNC=0
if [ "$DO_BACKEND" = 1 ] && [ -f "$LOCAL_ENV" ] \
   && grep -Eq "$SYNC_KEYS.+" "$LOCAL_ENV"; then
  DO_SYNC=1
fi

rc=0
"${SSH[@]}" "$HOST" 'sudo grep -Eiq "^[a-z_]*(capital|mt5|metaapi|oanor)[a-z0-9_]*=|^ig_" /etc/auto-trader/demo.env' || rc=$?
# A deploy that is about to PUSH creds needs the same gate as a box that
# already holds them — otherwise syncing would quietly bypass this check.
if [ "$rc" -eq 1 ] && [ "$SYNC_CREDS" = 1 ]; then rc=0; fi
if [ "$rc" -eq 0 ]; then
  rc2=0
  "${SSH[@]}" "$HOST" 'sudo grep -Eq "^ADMIN_EMAILS=..*|^ADMIN_USER_IDS=..*" /etc/auto-trader/demo.env' || rc2=$?
  if [ "$rc2" -eq 1 ]; then
    echo "FAIL: broker credentials present in /etc/auto-trader/demo.env but no ADMIN_EMAILS/ADMIN_USER_IDS — add the admin gate first (see docs/superpowers/specs/2026-09-03-admin-gated-brokers-design.md §6)" >&2
    exit 1
  elif [ "$rc2" -ne 0 ]; then
    echo "FAIL: could not reach the box over SSH (exit $rc2) — admin-gate check not run" >&2
    exit 1
  fi
elif [ "$rc" -ne 1 ]; then
  echo "FAIL: could not reach the box over SSH (exit $rc) — broker-cred check not run" >&2
  exit 1
fi

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

  if [ "$DO_SYNC" = 1 ]; then
    echo "==> backend: sync credentials -> $HOST:/etc/auto-trader/demo.env"
    # Values travel over stdin, never on the remote command line (argv is world
    # readable via ps on the box). The remote side rewrites the file in place:
    # every line for a synced KEY is dropped (which also collapses the
    # duplicate assignments a hand-edit can leave behind) and the incoming
    # values are appended; every other line is preserved byte for byte.
    #
    # Only keys PRESENT in the local file are touched, so commenting one out
    # locally leaves the box's existing value alone rather than clearing it.
    grep -E "$SYNC_KEYS.+" "$LOCAL_ENV" \
      | "${SSH[@]}" "$HOST" '
      set -e
      incoming="$(mktemp)"; merged="$(mktemp)"
      trap "rm -f $incoming $merged" EXIT
      cat > "$incoming"
      keys="$(sed -n "s/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p" "$incoming" | sort -u)"
      sudo cat /etc/auto-trader/demo.env > "$merged"
      for k in $keys; do
        grep -v "^$k=" "$merged" > "$merged.tmp" || true
        mv "$merged.tmp" "$merged"
      done
      cat "$incoming" >> "$merged"
      sudo cp /etc/auto-trader/demo.env /etc/auto-trader/demo.env.bak
      sudo chmod 600 /etc/auto-trader/demo.env.bak  # a NEW file: umask, not 600
      sudo cp "$merged" /etc/auto-trader/demo.env
      sudo chmod 600 /etc/auto-trader/demo.env
      echo "    synced: $(echo $keys | tr "\n" " ")"
    '
  fi

  # agent-ui-bridge is a git dependency declared under [tool.uv.sources], which
  # plain pip on the box cannot see. Install the commit uv.lock pins first, so
  # the package install below finds it already satisfied.
  bridge_rev=$(grep -A2 'name = "agent-ui-bridge"' backend/uv.lock | sed -n 's/.*python#\([0-9a-f]*\)".*/\1/p' | head -1)
  [ -n "$bridge_rev" ] || { echo "could not read the agent-ui-bridge commit from backend/uv.lock" >&2; exit 1; }
  echo "==> backend: pip install (agent-ui-bridge@${bridge_rev:0:7}) + restart auto-trader-demo"
  "${SSH[@]}" "$HOST" "
    set -e
    /opt/auto-trader/venv/bin/pip install -q --no-cache-dir 'agent-ui-bridge @ git+https://github.com/maparham/agent-ui-bridge@$bridge_rev#subdirectory=python'
    /opt/auto-trader/venv/bin/pip install -q --no-cache-dir /opt/auto-trader/backend
    sudo systemctl restart auto-trader-demo
    for i in \$(seq 1 20); do
      sleep 1
      if curl -sf -m 5 http://127.0.0.1:8010/health >/dev/null; then exit 0; fi
    done
    echo 'backend failed to come up; last log lines:' >&2
    sudo journalctl -u auto-trader-demo -n 20 --no-pager >&2
    exit 1
  "
fi

if [ "$DO_FRONTEND" = 1 ]; then
  echo "==> frontend: vite build (VITE_API_BASE=$API_BASE)"
  ln -s "$ROOT/frontend/node_modules" "$WT/frontend/node_modules"
  (cd "$WT/frontend" && VITE_API_BASE="$API_BASE" VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PK" npx vite build >/dev/null)
  grep -rq "$API_BASE" "$WT/frontend/dist/assets" \
    || { echo "API base not found in bundle — build misconfigured" >&2; exit 1; }
  grep -rq "$CLERK_PK" "$WT/frontend/dist/assets" \
    || { echo "Clerk publishable key not found in bundle — build misconfigured" >&2; exit 1; }
  # The Clerk BACKEND secret must never ship to the browser. Fail closed.
  if grep -rqE 'sk_(live|test)_' "$WT/frontend/dist"; then
    echo "FATAL: a Clerk secret key appears in the frontend bundle" >&2
    exit 1
  fi
  printf '/* /index.html 200\n' > "$WT/frontend/dist/_redirects"

  echo "==> frontend: wrangler pages deploy ($PAGES_PROJECT)"
  (cd "$WT/frontend" \
    && npx wrangler pages deploy dist --project-name "$PAGES_PROJECT" --branch main)
fi

echo "==> smoke test"
curl -sf -m 15 "$API_BASE/health" >/dev/null || { echo "FAIL: $API_BASE/health" >&2; exit 1; }
# /api/brokers is on the public-demo GET allowlist (api/demo_access.py), so it
# answers 200 as the shared demo principal. Prove hosted-mode auth is on with a
# route that is NOT allowlisted.
AUTH_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$API_BASE/api/state")"
[ "$AUTH_CODE" = 401 ] || { echo "FAIL: unauthenticated /api/state returned $AUTH_CODE (want 401 — is the box env hosted-mode?)" >&2; exit 1; }
BROKERS_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$API_BASE/api/brokers")"
[ "$BROKERS_CODE" = 200 ] || { echo "FAIL: demo /api/brokers returned $BROKERS_CODE (want 200)" >&2; exit 1; }
CORS="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H 'Origin: https://chartkar.app' -H 'Access-Control-Request-Method: GET' \
  "$API_BASE/api/brokers")"
[ "$CORS" = 200 ] || { echo "FAIL: CORS preflight returned $CORS" >&2; exit 1; }
SITE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://chartkar.app/)"
[ "$SITE" = 200 ] || { echo "FAIL: site returned $SITE" >&2; exit 1; }

echo "==> deployed $HEAD_SHA — https://chartkar.app"
