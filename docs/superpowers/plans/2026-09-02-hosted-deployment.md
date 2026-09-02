# Hosted Deployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the backend/frontend for the authenticated hosted deployment at trader.rahkar.pro and update the deploy script — everything short of the production flip itself.

**Architecture:** Four independent changes: hosted-mode lockdown of the remote-compute proxy, JWKS verification moved off the event loop, WS-token redaction in access logs, and a frontend account-switch gate that wipes device-local state. Plus deploy-script changes. All code is inert until the hosted env vars (`CLERK_JWKS_URL` etc.) are set on the box.

**Tech Stack:** FastAPI/Starlette, PyJWT, pytest; React + Clerk, vitest + testing-library; bash.

**Spec:** `docs/superpowers/specs/2026-09-02-hosted-deployment-design.md`

## Global Constraints

- Local dev behavior (no `CLERK_JWKS_URL`, no `VITE_CLERK_PUBLISHABLE_KEY`) must be byte-identical: every change is gated on `auth_enabled()` / `CLERK_ENABLED`, except the log filter (harmless no-op in dev) and `asyncio.to_thread` (only reached in hosted mode).
- Never touch `CLERK_SECRET_KEY` anywhere; the backend verifies via JWKS only.
- Client-visible error bodies must not leak internals (follow `INVALID_TOKEN_MSG` precedent).
- `scripts/deploy-demo.sh` is edited but NEVER executed during this plan (it deploys to production).
- Run commands from `backend/` with `python3 -m pytest`, from `frontend/` with `npx vitest run`.

---

### Task 1: Hosted-mode lockdown of the remote-compute proxy

**Files:**
- Modify: `backend/auto_trader/api/routers/compute.py` (imports, `compute_status`, `forward`)
- Create: `backend/tests/test_api_compute_hosted.py`

**Interfaces:**
- Consumes: `auto_trader.api.auth.auth_enabled()` (exists), `tests/clerk_fake.py` (`install(monkeypatch)`, `make_token(sub=...)`).
- Produces: hosted behavior later smoke-tested in Task 4's script edits; no code interfaces for other tasks.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_compute_hosted.py`:

```python
"""Hosted mode must not expose the operator's private remote-compute host:
forward() carries COMPUTE_HOST_TOKEN and no per-user identity, so any
signed-in user could reach the operator's box and other users' remote jobs."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from tests import clerk_fake


@pytest.fixture()
def hosted_client(monkeypatch):
    clerk_fake.install(monkeypatch)
    # A configured host must STILL be refused in hosted mode.
    monkeypatch.setenv("COMPUTE_HOST_URL", "https://compute.example")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "sekret")
    with TestClient(app) as client:
        yield client


def _auth() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_a')}"}


def test_forward_routes_403_in_hosted_mode(hosted_client):
    # The job-status GET forwards without request-body validation, so the
    # response code isolates forward()'s own behavior. In dev mode this same
    # call would be 502 (unreachable host), never 403/404.
    r = hosted_client.get(
        "/api/backtest/sweep/jobs/any-id?target=remote", headers=_auth()
    )
    assert r.status_code == 403
    assert "hosted" in r.json()["detail"]


def test_compute_status_reports_unconfigured_in_hosted_mode(hosted_client):
    r = hosted_client.get("/api/compute/status", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"remoteConfigured": False}


def test_compute_status_still_reads_config_in_dev_mode(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    monkeypatch.setenv("COMPUTE_HOST_URL", "https://compute.example")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "sekret")
    with TestClient(app) as client:
        r = client.get("/api/compute/status")
    assert r.json() == {"remoteConfigured": True}
```

Note: the 403 must fire BEFORE the config check in `forward()` — with the config check first, a configured host would 502 and an unconfigured one 422, so the ordering is what the test pins.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_api_compute_hosted.py -v`
Expected: first two tests FAIL (403 missing / status True); dev-mode test PASSES.

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/routers/compute.py`:

```python
from ..auth import auth_enabled
```

`compute_status` becomes:

```python
@router.get("/api/compute/status")
async def compute_status() -> dict:
    """Whether a remote compute host is configured (both url AND token set). The
    frontend hides the remote toggle when this is False. Hosted mode always
    answers False: the remote host is the operator's private box (see forward)."""
    if auth_enabled():
        return {"remoteConfigured": False}
    url, token = _config()
    return {"remoteConfigured": bool(url and token)}
```

At the top of `forward()`, before `_config()`:

```python
    if auth_enabled():
        # The remote host predates multi-tenancy: forwarded jobs carry no user
        # identity, so proxying would hand every signed-in user the operator's
        # COMPUTE_HOST_TOKEN powers. Refuse outright.
        raise HTTPException(403, "remote compute is not available on the hosted service")
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_api_compute_hosted.py tests/test_api_compute.py -v` (second file if it exists; skip if not)
Expected: PASS.

- [ ] **Step 5: Run the broader touched-area suite**

Run: `cd backend && python3 -m pytest tests -k "compute or sweep_job" -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/routers/compute.py backend/tests/test_api_compute_hosted.py
git commit -m "feat(hosted): refuse remote-compute proxying when auth is enabled"
```

---

### Task 2: JWKS verification off the event loop + WS-token log redaction

**Files:**
- Modify: `backend/auto_trader/api/auth.py` (middleware + `verify_ws`)
- Modify: `backend/auto_trader/api/app.py` (`_configure_logging`)
- Create: `backend/tests/test_log_redaction.py`
- Test (existing, must stay green): `backend/tests/test_api_auth.py`, `backend/tests/test_api_auth_ws.py`

**Interfaces:**
- Consumes: `verify_token` (unchanged signature `(token: str) -> str`).
- Produces: `auto_trader.api.app._TokenRedactionFilter` (class, `filter(record) -> bool`), unit-tested directly.

- [ ] **Step 1: Move verification to a thread**

In `backend/auto_trader/api/auth.py`, add `import asyncio` to the imports. In the `_auth` middleware replace:

```python
        try:
            request.state.user_id = verify_token(authz[len("Bearer ") :])
```

with:

```python
        try:
            # verify_token can block on a JWKS HTTP fetch (cold cache, key
            # rotation); keep that off the event loop.
            request.state.user_id = await asyncio.to_thread(
                verify_token, authz[len("Bearer ") :]
            )
```

In `verify_ws` replace `return verify_token(token)` with `return await asyncio.to_thread(verify_token, token)`.

- [ ] **Step 2: Run existing auth suites**

Run: `cd backend && python3 -m pytest tests/test_api_auth.py tests/test_api_auth_ws.py -q`
Expected: PASS (they exercise the middleware and verify_ws end-to-end; to_thread preserves exceptions, so AuthError → 401/4401 paths are covered).

- [ ] **Step 3: Write the failing redaction tests**

Create `backend/tests/test_log_redaction.py`:

```python
"""Hosted WS dials carry the Clerk JWT as ?token=...; uvicorn's access log
prints the request line verbatim, so live session tokens would land in
journald. The filter rewrites token values before formatting and must never
raise (a raising filter silently drops records)."""
from __future__ import annotations

import logging

from auto_trader.api.app import _TokenRedactionFilter


def _record(args) -> logging.LogRecord:
    # Shape of a uvicorn.access record: msg has %s placeholders, args carries
    # (client, method, path, http_version, status).
    return logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=1,
        msg='%s - "%s %s HTTP/%s" %d', args=args, exc_info=None,
    )


def test_redacts_token_query_value():
    rec = _record(("1.2.3.4:1", "GET", "/ws/state?token=eyJhbGci.secret&x=1", "1.1", 101))
    assert _TokenRedactionFilter().filter(rec) is True
    assert "secret" not in rec.getMessage()
    assert "/ws/state?token=REDACTED&x=1" in rec.getMessage()


def test_leaves_tokenless_records_untouched():
    rec = _record(("1.2.3.4:1", "GET", "/api/brokers", "1.1", 200))
    _TokenRedactionFilter().filter(rec)
    assert rec.getMessage() == '1.2.3.4:1 - "GET /api/brokers HTTP/1.1" 200'


def test_never_raises_on_odd_shapes():
    for args in (None, ("just-a-string",), ({"a": 1},), (b"bytes?token=x",)):
        rec = _record(args)
        assert _TokenRedactionFilter().filter(rec) is True  # record passes through
```

- [ ] **Step 4: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_log_redaction.py -v`
Expected: FAIL with ImportError (`_TokenRedactionFilter` not defined).

- [ ] **Step 5: Implement the filter**

In `backend/auto_trader/api/app.py`, above `_configure_logging`:

```python
_TOKEN_RE = re.compile(r"(token=)[^&\s\"']+")


class _TokenRedactionFilter(logging.Filter):
    """Rewrite `token=<value>` to `token=REDACTED` in log-record args (hosted
    WS dials put the Clerk JWT in the query string, and uvicorn.access prints
    the request line verbatim). Filters must never raise — a raising filter
    drops the record — so any surprise arg shape passes through untouched."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple):
                record.args = tuple(
                    _TOKEN_RE.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                    for a in record.args
                )
            if isinstance(record.msg, str) and "token=" in record.msg:
                record.msg = _TOKEN_RE.sub(r"\1REDACTED", record.msg)
        except Exception:
            pass
        return True
```

Add `import re` to app.py's imports if missing. In `_configure_logging`, inside the existing loop over `("uvicorn", "uvicorn.access", "uvicorn.error")` handlers, add after `handler.setFormatter(fmt)`:

```python
            if not any(isinstance(f, _TokenRedactionFilter) for f in handler.filters):
                handler.addFilter(_TokenRedactionFilter())
```

(Idempotent because `_configure_logging` runs on every lifespan start and tests start the app repeatedly.)

- [ ] **Step 6: Run tests**

Run: `cd backend && python3 -m pytest tests/test_log_redaction.py tests/test_api_auth.py tests/test_api_auth_ws.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/auth.py backend/auto_trader/api/app.py backend/tests/test_log_redaction.py
git commit -m "feat(hosted): JWKS verification off the event loop; redact WS tokens from access logs"
```

---

### Task 3: Frontend account-switch gate

**Files:**
- Create: `frontend/src/components/AccountGate.tsx`
- Create: `frontend/src/components/AccountGate.test.tsx`
- Modify: `frontend/src/main.tsx` (wrap `<App />` inside `<SignedIn>`)

**Interfaces:**
- Consumes: `useUser()` from `@clerk/clerk-react` (inside `<SignedIn>`, `user` is non-null once `isLoaded`).
- Produces: `AccountGate` (default export, `{ children: ReactNode }`); the localStorage key `auto-trader.lastUserId` (raw string, not JSON — new key, no existing reader).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/AccountGate.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// On a shared browser, user B signing in after user A must not inherit A's
// device-local state (activeLayoutId/scratch/autosave survive the hosted
// hydrate by design). The gate wipes ALL auto-trader.* keys when the Clerk
// user id differs from the one stamped on this browser — before children
// (and the persist hydrate they trigger) ever mount.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const clerk = vi.hoisted(() => ({ userId: "user_a" }));
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ isLoaded: true, user: { id: clerk.userId } }),
}));

import AccountGate from "./AccountGate";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const seed = () => {
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.b.capital.activeLayoutId", '"x"'); // device-local
  localStorage.setItem("unrelated.key", "1");
};

it("same user: renders children, keys intact", () => {
  seed();
  localStorage.setItem("auto-trader.lastUserId", "user_a");
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(screen.getByTestId("app")).toBeDefined();
  expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBe('"x"');
});

it("different user: wipes every auto-trader.* key (device-local included) and stamps the new id", () => {
  seed();
  localStorage.setItem("auto-trader.lastUserId", "user_b");
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(screen.getByTestId("app")).toBeDefined();
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBeNull();
  expect(localStorage.getItem("unrelated.key")).toBe("1");
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_a");
});

it("first sign-in on this browser (no stamp): wipes and stamps", () => {
  seed();
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_a");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/AccountGate.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `frontend/src/components/AccountGate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useUser } from "@clerk/clerk-react";
import { PREFIX } from "../lib/persist/core";

const LAST_USER_KEY = `${PREFIX}.lastUserId`;

/** Hosted-only guard between <SignedIn> and <App />. The hosted hydrate keeps
 * device-local keys (activeLayoutId/scratch/autosave) on purpose; on a shared
 * browser that leaks user A's layout state to user B. The wipe runs during
 * render, before children mount, so the persist hydrate never sees stale keys.
 * The stamp is a raw string (not JSON): no other code reads it. */
export default function AccountGate({ children }: { children: ReactNode }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || !user) return null; // <SignedIn> makes this transient
  if (localStorage.getItem(LAST_USER_KEY) !== user.id) {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${PREFIX}.`)) localStorage.removeItem(key);
    }
    localStorage.setItem(LAST_USER_KEY, user.id);
  }
  return <>{children}</>;
}
```

Check `PREFIX` is exported from `frontend/src/lib/persist/core.ts` (it is, line 10). In `frontend/src/main.tsx`, import `AccountGate` and change:

```tsx
        <SignedIn>
          <AccountGate>
            <App />
          </AccountGate>
        </SignedIn>
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/components/AccountGate.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check and run the component suite**

Run: `cd frontend && npx tsc -b && npx vitest run src/components src/lib/persist`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AccountGate.tsx frontend/src/components/AccountGate.test.tsx frontend/src/main.tsx
git commit -m "feat(hosted): wipe device-local state on account switch"
```

---

### Task 4: Deploy script for the authenticated deployment

**Files:**
- Modify: `scripts/deploy-demo.sh`

**Interfaces:**
- Consumes: nothing from other tasks (behavioral expectations only: `/api/brokers` 401s unauthenticated once the box env has `CLERK_JWKS_URL`).
- Produces: the script the operator runs at flip time. NEVER execute it in this plan.

- [ ] **Step 1: Edit the script**

All edits to `scripts/deploy-demo.sh`:

1. Constants block (after `API_BASE=...`):

```bash
CLERK_PK="pk_live_Y2xlcmsudHJhZGVyLnJhaGthci5wcm8k"
```

2. Pre-deploy guard, right after the `case` argument parsing (before the worktree build), so a deploy can never bring up an unauthenticated backend:

```bash
echo "==> preflight: box env must be hosted-mode (Clerk vars present)"
"${SSH[@]}" "$HOST" '
  set -e
  grep -q "^CLERK_JWKS_URL=" /etc/auto-trader/demo.env
  grep -q "^CLERK_AUTHORIZED_PARTIES=" /etc/auto-trader/demo.env
' || { echo "FAIL: /etc/auto-trader/demo.env is missing CLERK_JWKS_URL / CLERK_AUTHORIZED_PARTIES — add them first (see docs/superpowers/specs/2026-09-02-hosted-deployment-design.md §5)" >&2; exit 1; }
echo "==> preflight: no broker credentials on the box"
if "${SSH[@]}" "$HOST" 'grep -Eiq "capital|^IG_|mt5" /etc/auto-trader/demo.env'; then
  echo "FAIL: broker credentials found in /etc/auto-trader/demo.env" >&2; exit 1
fi
```

3. Frontend build line gains the Clerk key, and a bundle guard mirrors the API_BASE one:

```bash
  (cd "$WT/frontend" && VITE_API_BASE="$API_BASE" VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PK" npx vite build >/dev/null)
  grep -rq "$API_BASE" "$WT/frontend/dist/assets" \
    || { echo "API base not found in bundle — build misconfigured" >&2; exit 1; }
  grep -rq "$CLERK_PK" "$WT/frontend/dist/assets" \
    || { echo "Clerk publishable key not found in bundle — build misconfigured" >&2; exit 1; }
```

4. Smoke tests: keep `/health` and site checks as-is. Replace the `/api/brokers` body check + broker-leak case with an auth check (the leak check moved to preflight):

```bash
BROKERS_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$API_BASE/api/brokers")"
[ "$BROKERS_CODE" = 401 ] || { echo "FAIL: unauthenticated /api/brokers returned $BROKERS_CODE (want 401 — is the box env hosted-mode?)" >&2; exit 1; }
```

Keep the CORS preflight check unchanged (OPTIONS is auth-exempt and must stay 200).

5. Update the header comment: the script now deploys the AUTHENTICATED app (sign-in required); note the two Clerk env vars the box must carry and that `VITE_CLERK_PUBLISHABLE_KEY` is baked into the frontend build.

- [ ] **Step 2: Lint**

Run: `shellcheck scripts/deploy-demo.sh` (if shellcheck is unavailable: `bash -n scripts/deploy-demo.sh`)
Expected: no errors (pre-existing style warnings acceptable; note them).

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-demo.sh
git commit -m "feat(deploy): authenticated deploy — Clerk build key, hosted-mode preflight, 401 smoke test"
```

---

## Verification (after all tasks, before merge)

- `cd backend && python3 -m pytest -q` — full suite green.
- `cd frontend && npx tsc -b && npx vitest run` — full suite green.
- `bash -n scripts/deploy-demo.sh`.

## Not in this plan (runbook, requires explicit user OK)

1. SSH to the box, append to `/etc/auto-trader/demo.env`:
   `CLERK_JWKS_URL=https://clerk.trader.rahkar.pro/.well-known/jwks.json` and
   `CLERK_AUTHORIZED_PARTIES=https://trader.rahkar.pro`.
2. Run `scripts/deploy-demo.sh`.
3. Live verification per the spec's Testing section.
