# Shell Browser-Auth Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in to the Tauri shell by authenticating in the default browser: Chrome mints a Clerk sign-in token via the backend and hands it to a loopback listener in the shell, which signs the webview in.

**Architecture:** OAuth-style loopback handoff (RFC 8252). A new authed backend endpoint mints a single-use Clerk sign-in token for the caller. The shell command `browser_sign_in` opens the browser at a handoff page with a loopback port and a state nonce; the page redirects the token back to `127.0.0.1:<port>`; the shell navigates the main window to the app with `?__clerk_ticket=`, which a new signed-out component consumes.

**Tech Stack:** FastAPI + httpx (backend), React + @clerk/clerk-react + vitest (frontend), Tauri v2 + tauri-plugin-opener + std::net TcpListener (shell).

**Spec:** `docs/superpowers/specs/2026-09-11-shell-browser-auth-design.md`

## Global Constraints

- Commit to the current branch (`main`); never create a branch, never stash/clean/restore, stage only explicit paths.
- No em dashes ("—") or "--" in any UI copy or doc prose; split the sentence instead.
- Frontend: run ONLY the test files named in a step, never the whole suite (it locks up the machine). Typecheck with `npx tsc -b` (NOT `--noEmit`, which is a no-op here); judge by per-file parity, pre-existing unrelated errors may exist.
- Tauri three-edit rule for every new shell command: `generate_handler!` in `main.rs`, the command list in `build.rs`, and a permission entry in BOTH `capabilities/default.json` and `capabilities/served-ui.json`.
- The backend endpoint mints tokens only for the already-authenticated caller; `CLERK_SECRET_KEY` must never appear in a response, error string, or log line.
- Backend tests: `cd backend && python3 -m pytest tests/<file> -q`. Rust: `cd tauri-shell/src-tauri && cargo test --quiet` and `cargo build --quiet`.

---

### Task 1: Backend endpoint `POST /api/auth/shell-token`

**Files:**
- Create: `backend/auto_trader/api/routers/shell_auth.py`
- Modify: `backend/auto_trader/api/app.py` (router import + registration loop, around line 224)
- Test: `backend/tests/test_shell_auth.py`

**Interfaces:**
- Consumes: `auto_trader.api.deps.current_user` (FastAPI dependency returning the verified user id string), `tests.clerk_fake.install(monkeypatch)` + `clerk_fake.make_token(sub=...)` for authed test requests.
- Produces: `POST /api/auth/shell-token` returning `{"token": "<sign-in token>"}` on 200; 503 when `CLERK_SECRET_KEY` unset; 502 on Clerk failure; 401 unauthenticated (middleware). Task 3's frontend component calls this route.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_shell_auth.py`:

```python
"""The shell browser-auth handoff's token mint: /api/auth/shell-token."""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.routers import shell_auth
from tests import clerk_fake


@pytest.fixture()
def client(monkeypatch):
    clerk_fake.install(monkeypatch)
    with TestClient(app) as c:
        yield c


def _auth() -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub='user_123')}"}


def test_mints_a_token_for_the_request_user(client, monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["json"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"token": "sit_abc", "user_id": "user_123"})

    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(shell_auth, "_transport", lambda: httpx.MockTransport(handler))
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"token": "sit_abc"}
    assert seen["url"] == f"{shell_auth.API_BASE}/sign_in_tokens"
    assert seen["json"] == {"user_id": "user_123", "expires_in_seconds": 300}
    assert seen["auth"] == "Bearer sk_test_secret"


def test_unconfigured_is_503(client, monkeypatch):
    monkeypatch.delenv(shell_auth.SECRET_ENV, raising=False)
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 503


def test_clerk_failure_is_502_without_echoing_the_secret(client, monkeypatch):
    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(
        shell_auth,
        "_transport",
        lambda: httpx.MockTransport(lambda req: httpx.Response(500, json={"errors": []})),
    )
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 502
    assert "sk_test_secret" not in r.text


def test_missing_token_in_clerk_response_is_502(client, monkeypatch):
    monkeypatch.setenv(shell_auth.SECRET_ENV, "sk_test_secret")
    monkeypatch.setattr(
        shell_auth,
        "_transport",
        lambda: httpx.MockTransport(lambda req: httpx.Response(200, json={"nope": 1})),
    )
    r = client.post("/api/auth/shell-token", headers=_auth())
    assert r.status_code == 502


def test_unauthenticated_is_401(client):
    r = client.post("/api/auth/shell-token")
    assert r.status_code == 401
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python3 -m pytest tests/test_shell_auth.py -q`
Expected: FAIL with `ImportError` (no module `shell_auth`).

- [ ] **Step 3: Implement the router**

Create `backend/auto_trader/api/routers/shell_auth.py`:

```python
"""Mint a Clerk sign-in token for the Tauri shell's browser-auth handoff.

The shell opens the user's default browser (already signed in to Clerk) at a
handoff page, which POSTs here and forwards the returned single-use token to
the shell's loopback listener. The token can only be minted for the caller's
own verified user id, so this grants nothing the caller does not already have.

Config is CLERK_SECRET_KEY, read per request (same stance as core/clerk_admin)
so tests can monkeypatch without reloading. Unset means 503: the handoff is a
hosted-mode feature. The secret never appears in a response or a log line.
"""
from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..deps import current_user

router = APIRouter()

SECRET_ENV = "CLERK_SECRET_KEY"
API_BASE = "https://api.clerk.com/v1"
TIMEOUT_SECONDS = 10.0
TOKEN_TTL_SECONDS = 300

log = logging.getLogger(__name__)


def _transport():
    """Seam for tests: None means httpx's real transport."""
    return None


@router.post("/api/auth/shell-token")
async def shell_token(user_id: str = Depends(current_user)) -> dict:
    secret = os.environ.get(SECRET_ENV, "").strip()
    if not secret:
        raise HTTPException(503, "sign-in token minting is not configured")
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS, transport=_transport()
        ) as client:
            res = await client.post(
                f"{API_BASE}/sign_in_tokens",
                json={"user_id": user_id, "expires_in_seconds": TOKEN_TTL_SECONDS},
                headers={"Authorization": f"Bearer {secret}"},
            )
    except Exception as exc:  # status only: bodies/exc text can carry secrets
        log.warning("clerk sign-in token mint failed: %s", type(exc).__name__)
        raise HTTPException(502, "Clerk API unreachable")
    if res.status_code >= 400:
        log.warning("clerk sign-in token mint returned %s", res.status_code)
        raise HTTPException(502, f"Clerk API returned {res.status_code}")
    body = res.json()
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise HTTPException(502, "Clerk API returned no token")
    return {"token": token}
```

In `backend/auto_trader/api/app.py`, add `shell_auth` to the routers import (it sits next to the existing `from .routers import ...` line) and append it to the `for _module in (...)` registration tuple.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && python3 -m pytest tests/test_shell_auth.py -q`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/shell_auth.py backend/auto_trader/api/app.py backend/tests/test_shell_auth.py
git commit -m "feat(auth): mint Clerk sign-in tokens for the shell handoff"
```

---

### Task 2: Frontend boot-param parsing (`shellAuthBoot.ts`)

**Files:**
- Create: `frontend/src/lib/shellAuthBoot.ts`
- Test: `frontend/src/lib/shellAuthBoot.test.ts`

**Interfaces:**
- Produces: `parseShellAuthParams(search: string): { port: number; state: string } | null` and `parseClerkTicket(search: string): string | null`. Tasks 3, 4, 5 consume these; the exported interface name is `ShellAuthParams`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/shellAuthBoot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseClerkTicket, parseShellAuthParams } from "./shellAuthBoot";

describe("parseShellAuthParams", () => {
  it("parses a valid handoff boot", () => {
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=abc123")).toEqual({
      port: 49213,
      state: "abc123",
    });
  });

  it("returns null without the shell_auth flag", () => {
    expect(parseShellAuthParams("?port=49213&state=abc")).toBeNull();
    expect(parseShellAuthParams("")).toBeNull();
  });

  it("rejects a missing or invalid port", () => {
    expect(parseShellAuthParams("?shell_auth=1&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=0&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=65536&state=abc")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=12.5&state=abc")).toBeNull();
  });

  it("rejects a missing state", () => {
    expect(parseShellAuthParams("?shell_auth=1&port=49213")).toBeNull();
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=")).toBeNull();
  });
});

describe("parseClerkTicket", () => {
  it("returns the ticket when present, null otherwise", () => {
    expect(parseClerkTicket("?__clerk_ticket=sit_abc")).toBe("sit_abc");
    expect(parseClerkTicket("?__clerk_ticket=")).toBeNull();
    expect(parseClerkTicket("?foo=1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts`
Expected: FAIL (cannot resolve `./shellAuthBoot`).

- [ ] **Step 3: Implement**

Create `frontend/src/lib/shellAuthBoot.ts`:

```ts
// Pure parsing for the shell browser-auth handoff boots, mirroring
// snapshotBoot.ts: ?shell_auth=1&port=..&state=.. boots the Chrome-side
// handoff page, ?__clerk_ticket=.. is the webview-side sign-in ticket.

export interface ShellAuthParams {
  port: number;
  state: string;
}

export function parseShellAuthParams(search: string): ShellAuthParams | null {
  const q = new URLSearchParams(search);
  if (q.get("shell_auth") !== "1") return null;
  const port = Number(q.get("port"));
  const state = q.get("state");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !state) return null;
  return { port, state };
}

export function parseClerkTicket(search: string): string | null {
  return new URLSearchParams(search).get("__clerk_ticket") || null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/shellAuthBoot.ts frontend/src/lib/shellAuthBoot.test.ts
git commit -m "feat(shell-auth): parse the handoff boot params and Clerk ticket"
```

---

### Task 3: Chrome-side handoff component (`ShellAuthHandoff`)

**Files:**
- Create: `frontend/src/components/ShellAuthHandoff.tsx`
- Test: `frontend/src/components/ShellAuthHandoff.test.tsx`

**Interfaces:**
- Consumes: `ShellAuthParams` from Task 2, `apiFetch` + `API_BASE` from `frontend/src/lib/http.ts`, Task 1's endpoint.
- Produces: `export default function ShellAuthHandoff({ params }: { params: ShellAuthParams })`. Task 5 renders it inside `<SignedIn>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ShellAuthHandoff.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// The Chrome side of the shell handoff: mint a sign-in token via the backend,
// then top-level-redirect it to the shell's loopback listener. A redirect,
// not a fetch: https-to-loopback fetches are blocked as mixed content.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { API_BASE } from "../lib/http";
import ShellAuthHandoff from "./ShellAuthHandoff";

const replace = vi.fn();

function stubLocation() {
  vi.stubGlobal("location", { ...window.location, replace });
}

afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.unstubAllGlobals();
});

it("mints a token and redirects it to the loopback listener", async () => {
  stubLocation();
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ token: "sit_abc" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />);
  await waitFor(() => expect(replace).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    `${API_BASE}/api/auth/shell-token`,
    expect.objectContaining({ method: "POST" }),
  );
  expect(replace).toHaveBeenCalledWith(
    "http://127.0.0.1:49213/callback?ticket=sit_abc&state=n0nce",
  );
});

it("shows the error and does not redirect when the mint fails", async () => {
  stubLocation();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  const { findByText } = render(
    <ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />,
  );
  await findByText(/failed \(503\)/);
  expect(replace).not.toHaveBeenCalled();
});

it("mints exactly once across a StrictMode double-mount", async () => {
  stubLocation();
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ token: "sit_abc" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { StrictMode } = await import("react");
  render(
    <StrictMode>
      <ShellAuthHandoff params={{ port: 49213, state: "n0nce" }} />
    </StrictMode>,
  );
  await waitFor(() => expect(replace).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/ShellAuthHandoff.test.tsx`
Expected: FAIL (cannot resolve `./ShellAuthHandoff`).

- [ ] **Step 3: Implement**

Create `frontend/src/components/ShellAuthHandoff.tsx`:

```tsx
// Chrome side of the shell browser-auth handoff (?shell_auth=1&port=..&state=..).
// Rendered inside <SignedIn>, so by the time this runs the user is
// authenticated in this browser. Mints a single-use Clerk sign-in token via
// the backend and hands it to the shell's loopback listener with a TOP-LEVEL
// redirect: a fetch from an https page to http://127.0.0.1 would be blocked
// as mixed content, a navigation is not.
import { useEffect, useRef, useState } from "react";
import { API_BASE, apiFetch } from "../lib/http";
import type { ShellAuthParams } from "../lib/shellAuthBoot";

export default function ShellAuthHandoff({ params }: { params: ShellAuthParams }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The token is single-use and the redirect leaves the page: never run
    // twice (StrictMode mounts effects twice in dev).
    if (started.current) return;
    started.current = true;
    void (async () => {
      let res: Response;
      try {
        res = await apiFetch(`${API_BASE}/api/auth/shell-token`, { method: "POST" });
      } catch {
        setError("could not reach the backend");
        return;
      }
      if (!res.ok) {
        setError(`sign-in token request failed (${res.status})`);
        return;
      }
      const body = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) {
        setError("the response carried no token");
        return;
      }
      const u = new URL(`http://127.0.0.1:${params.port}/callback`);
      u.searchParams.set("ticket", body.token);
      u.searchParams.set("state", params.state);
      window.location.replace(u.toString());
    })();
  }, [params]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        {error
          ? `Handoff failed: ${error}. Close this tab and click the sign-in button in Auto Trader again.`
          : "Signing in to Auto Trader..."}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/components/ShellAuthHandoff.test.tsx`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ShellAuthHandoff.tsx frontend/src/components/ShellAuthHandoff.test.tsx
git commit -m "feat(shell-auth): Chrome-side handoff page mints and forwards the ticket"
```

---

### Task 4: Webview-side sign-in component (`ShellTicketSignIn`)

**Files:**
- Create: `frontend/src/components/ShellTicketSignIn.tsx`
- Test: `frontend/src/components/ShellTicketSignIn.test.tsx`

**Interfaces:**
- Consumes: `parseClerkTicket` (Task 2), `inShell` + `shellInvoke` from `frontend/src/lib/shellBridge.ts` (`shellInvoke(cmd)` resolves to the command's return value, or `null` on any failure), `useSignIn` and `SignIn` from `@clerk/clerk-react`.
- Produces: `export default function ShellTicketSignIn()`: the ENTIRE signed-out screen. Task 5 renders it as the `<SignedOut>` branch. It shows "Signing you in..." while consuming a `__clerk_ticket`, else the Clerk `<SignIn />` card plus (inside the shell only) a "Sign in with your browser" button that invokes the Task 6 shell command `browser_sign_in` (returns the loopback port number).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ShellTicketSignIn.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// The webview side of the shell handoff: consume ?__clerk_ticket exactly once
// (it is single-use, so Clerk's own card must never also see it), fall back to
// the normal card on failure, and offer the browser handoff button only when
// running inside the shell.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const { signInCreate, setActive } = vi.hoisted(() => ({
  signInCreate: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock("@clerk/clerk-react", () => ({
  SignIn: () => <div data-testid="clerk-card" />,
  useSignIn: () => ({
    isLoaded: true,
    signIn: { create: signInCreate },
    setActive,
  }),
}));

import ShellTicketSignIn from "./ShellTicketSignIn";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  signInCreate.mockReset();
  setActive.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
});

it("consumes a ticket, activates the session, and strips the param", async () => {
  window.history.replaceState(null, "", "/?__clerk_ticket=sit_abc");
  signInCreate.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
  const { queryByTestId, getByText } = render(<ShellTicketSignIn />);
  getByText("Signing you in...");
  expect(queryByTestId("clerk-card")).toBeNull();
  await waitFor(() => expect(setActive).toHaveBeenCalledWith({ session: "sess_1" }));
  expect(signInCreate).toHaveBeenCalledWith({ strategy: "ticket", ticket: "sit_abc" });
  expect(window.location.search).not.toContain("__clerk_ticket");
});

it("falls back to the Clerk card when the ticket is rejected", async () => {
  window.history.replaceState(null, "", "/?__clerk_ticket=sit_bad");
  signInCreate.mockRejectedValue(new Error("expired"));
  const { findByTestId } = render(<ShellTicketSignIn />);
  await findByTestId("clerk-card");
  expect(setActive).not.toHaveBeenCalled();
  expect(window.location.search).not.toContain("__clerk_ticket");
});

it("shows the browser button only inside the shell, and it invokes browser_sign_in", async () => {
  const invoke = vi.fn(async () => 49213);
  const { queryByText, unmount } = render(<ShellTicketSignIn />);
  expect(queryByText("Sign in with your browser")).toBeNull();
  unmount();
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
  const { getByText } = render(<ShellTicketSignIn />);
  fireEvent.click(getByText("Sign in with your browser"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("browser_sign_in", undefined));
});

it("reports a failed browser_sign_in next to the button", async () => {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: { invoke: vi.fn(async () => Promise.reject(new Error("bind"))) },
  };
  const { getByText, findByText } = render(<ShellTicketSignIn />);
  fireEvent.click(getByText("Sign in with your browser"));
  await findByText(/Could not start browser sign-in/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/ShellTicketSignIn.test.tsx`
Expected: FAIL (cannot resolve `./ShellTicketSignIn`).

- [ ] **Step 3: Implement**

Create `frontend/src/components/ShellTicketSignIn.tsx`:

```tsx
// The signed-out screen, extended for the native shell's browser-auth handoff.
//
// Two jobs, both no-ops in a plain browser session:
// - Consume a ?__clerk_ticket= sign-in token (delivered by the shell after the
//   Chrome handoff). Consumed EXPLICITLY, with the Clerk card unmounted while
//   pending: the ticket is single-use, so nothing else may also try it.
// - Offer "Sign in with your browser" when running inside the shell, which
//   asks the shell (browser_sign_in) to start the loopback handoff.
import { useEffect, useRef, useState } from "react";
import { SignIn, useSignIn } from "@clerk/clerk-react";
import { parseClerkTicket } from "../lib/shellAuthBoot";
import { inShell, shellInvoke } from "../lib/shellBridge";

function stripTicketParam(): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("__clerk_ticket");
  window.history.replaceState(null, "", u.toString());
}

export default function ShellTicketSignIn() {
  // Read once on mount: the param is stripped as soon as the attempt settles.
  const [ticket] = useState(() => parseClerkTicket(window.location.search));
  const [ticketFailed, setTicketFailed] = useState(false);
  const [buttonError, setButtonError] = useState(false);
  const tried = useRef(false);
  const { signIn, setActive, isLoaded } = useSignIn();

  useEffect(() => {
    if (!ticket || !isLoaded || tried.current) return;
    tried.current = true;
    void (async () => {
      try {
        const res = await signIn.create({ strategy: "ticket", ticket });
        stripTicketParam();
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
        } else {
          setTicketFailed(true);
        }
      } catch {
        stripTicketParam();
        setTicketFailed(true);
      }
    })();
  }, [ticket, isLoaded, signIn, setActive]);

  if (ticket && !ticketFailed) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        Signing you in...
      </div>
    );
  }

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 14 }}>
        <SignIn />
        {inShell() && (
          <div style={{ textAlign: "center" }}>
            <button
              type="button"
              onClick={() => {
                setButtonError(false);
                void shellInvoke("browser_sign_in").then((port) => {
                  if (typeof port !== "number") setButtonError(true);
                });
              }}
            >
              Sign in with your browser
            </button>
            {buttonError && (
              <div>Could not start browser sign-in. Try again.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/components/ShellTicketSignIn.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ShellTicketSignIn.tsx frontend/src/components/ShellTicketSignIn.test.tsx
git commit -m "feat(shell-auth): consume the sign-in ticket and offer the browser handoff"
```

---

### Task 5: Wire both branches into `main.tsx`

**Files:**
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `parseShellAuthParams` (Task 2), `ShellAuthHandoff` (Task 3), `ShellTicketSignIn` (Task 4).
- Produces: the running app. `?shell_auth=1` renders the handoff inside `<SignedIn>`; the `<SignedOut>` branch is now `<ShellTicketSignIn />` (which renders the same Clerk card as before when no ticket/shell is involved).

- [ ] **Step 1: Edit `frontend/src/main.tsx`**

Add imports:

```tsx
import ShellAuthHandoff from './components/ShellAuthHandoff.tsx'
import ShellTicketSignIn from './components/ShellTicketSignIn.tsx'
import { parseShellAuthParams } from './lib/shellAuthBoot.ts'
```

After the `snapshotParams` line add:

```tsx
// The shell browser-auth handoff boot (?shell_auth=1&port=..&state=..): a
// Chrome tab opened by the native shell to mint and forward a sign-in ticket.
const shellAuthParams = parseShellAuthParams(window.location.search)
```

Replace the `<SignedIn>` body so the handoff short-circuits the app:

```tsx
<SignedIn>
  {shellAuthParams ? (
    <ShellAuthHandoff params={shellAuthParams} />
  ) : (
    <AccountGate>
      {bootMobile ? <MobileApp /> : <App />}
    </AccountGate>
  )}
</SignedIn>
```

Replace the `<SignedOut>` body (the centered `<SignIn />` div) with:

```tsx
<SignedOut>
  <ShellTicketSignIn />
</SignedOut>
```

- [ ] **Step 2: Typecheck and re-run the touched test files**

Run: `cd frontend && npx tsc -b; npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellAuthHandoff.test.tsx src/components/ShellTicketSignIn.test.tsx`
Expected: no NEW tsc errors attributable to these files; 13 tests passed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat(shell-auth): boot the handoff page and ticket sign-in"
```

---

### Task 6: Shell command `browser_sign_in` and the loopback listener

**Files:**
- Create: `tauri-shell/src-tauri/src/browser_auth.rs`
- Modify: `tauri-shell/src-tauri/Cargo.toml`, `tauri-shell/src-tauri/src/main.rs`, `tauri-shell/src-tauri/build.rs`, `tauri-shell/src-tauri/capabilities/default.json`, `tauri-shell/src-tauri/capabilities/served-ui.json`

**Interfaces:**
- Consumes: `crate::settings::load(&app).url` (the configured UI URL string), `tauri_plugin_opener::OpenerExt` for opening the browser, the frontend contract from Tasks 3-5 (handoff URL query `shell_auth=1&port=&state=`, callback path `/callback?ticket=&state=`, webview param `__clerk_ticket`).
- Produces: command `browser_sign_in() -> Result<u16, String>` (the loopback port; Task 4's button treats a non-number as failure). Managed state `browser_auth::PendingAuth`.

- [ ] **Step 1: Add dependencies**

In `tauri-shell/src-tauri/Cargo.toml` `[dependencies]` add:

```toml
tauri-plugin-opener = "2"
rand = "0.8"
```

- [ ] **Step 2: Write `browser_auth.rs` with failing-first tests included**

Create `tauri-shell/src-tauri/src/browser_auth.rs`:

```rust
//! Browser-auth loopback handoff (RFC 8252 shape): `browser_sign_in` opens the
//! default browser at the configured UI's handoff page with a one-shot
//! listener's port and a state nonce; the page redirects a single-use Clerk
//! sign-in token back to 127.0.0.1, and the main window is navigated to the
//! app with ?__clerk_ticket= for the frontend to consume.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// The state nonce of the currently pending sign-in attempt, if any. A new
/// attempt replaces it; the superseded listener thread notices and exits.
#[derive(Default)]
pub struct PendingAuth(pub Mutex<Option<String>>);

const DEADLINE: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);

const RESPONSE_OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
<!doctype html><meta charset=\"utf-8\"><title>Auto Trader</title>\
<body style=\"font:14px -apple-system,sans-serif;display:grid;place-items:center;height:100vh\">\
Signed in. You can close this tab and return to Auto Trader.</body>";

const RESPONSE_FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nforbidden";

fn random_state() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// "GET /callback?ticket=..&state=.. HTTP/1.1" -> (ticket, state).
/// Percent-decoding via the url crate; anything else is None.
pub fn parse_callback(request_line: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    let u = url::Url::parse(&format!("http://loopback{path}")).ok()?;
    if u.path() != "/callback" {
        return None;
    }
    let mut ticket = None;
    let mut state = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "ticket" => ticket = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    match (ticket, state) {
        (Some(t), Some(s)) if !t.is_empty() && !s.is_empty() => Some((t, s)),
        _ => None,
    }
}

/// The Chrome-side boot URL: the configured UI's ORIGIN (path dropped) with
/// the handoff query. None if the configured URL does not parse.
pub fn handoff_url(configured: &str, port: u16, state: &str) -> Option<String> {
    let base = url::Url::parse(configured).ok()?;
    let mut u = base.join("/").ok()?;
    u.query_pairs_mut()
        .append_pair("shell_auth", "1")
        .append_pair("port", &port.to_string())
        .append_pair("state", state);
    Some(u.to_string())
}

/// The webview target once a ticket arrived: the configured URL as-is with
/// __clerk_ticket appended (existing query preserved).
pub fn ticket_url(configured: &str, ticket: &str) -> Option<String> {
    let mut u = url::Url::parse(configured).ok()?;
    u.query_pairs_mut().append_pair("__clerk_ticket", ticket);
    Some(u.to_string())
}

/// Start (or restart) a browser sign-in. Returns the loopback port; the
/// frontend button treats any non-number reply as failure.
#[tauri::command]
pub fn browser_sign_in(app: tauri::AppHandle) -> Result<u16, String> {
    use tauri_plugin_opener::OpenerExt;

    let configured = crate::settings::load(&app).url;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_state();
    let url = handoff_url(&configured, port, &state)
        .ok_or_else(|| "the configured UI URL is invalid".to_string())?;

    // Replace any pending attempt; its listener thread exits on the mismatch.
    *app.state::<PendingAuth>().0.lock().unwrap() = Some(state.clone());

    let handle = app.clone();
    std::thread::spawn(move || listen(handle, listener, state));
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(port)
}

fn listen(app: tauri::AppHandle, listener: TcpListener, my_state: String) {
    let deadline = Instant::now() + DEADLINE;
    while Instant::now() < deadline {
        {
            let slot = app.state::<PendingAuth>().0.lock().unwrap();
            if slot.as_deref() != Some(my_state.as_str()) {
                return; // superseded by a newer attempt
            }
        }
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(_) => {
                std::thread::sleep(POLL);
                continue;
            }
        };
        // The listener is non-blocking (accept polling); the callback read
        // must not be, or a slow browser write races us into an empty read.
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let first = text.lines().next().unwrap_or("");
        match parse_callback(first) {
            // A wrong state gets a 403 and the listener KEEPS waiting: an
            // attacker must not be able to burn the slot out from under the
            // real callback.
            Some((ticket, state)) if state == my_state => {
                let _ = stream.write_all(RESPONSE_OK.as_bytes());
                *app.state::<PendingAuth>().0.lock().unwrap() = None;
                finish(&app, &ticket);
                return;
            }
            _ => {
                let _ = stream.write_all(RESPONSE_FORBIDDEN.as_bytes());
            }
        }
    }
    // Deadline passed: clear the pending slot only if it is still ours.
    let mut slot = app.state::<PendingAuth>().0.lock().unwrap();
    if slot.as_deref() == Some(my_state.as_str()) {
        *slot = None;
    }
}

/// Navigate the main window to the app with the ticket and bring it forward.
fn finish(app: &tauri::AppHandle, ticket: &str) {
    let configured = crate::settings::load(app).url;
    let Some(target) = ticket_url(&configured, ticket) else {
        eprintln!("shell: browser sign-in got a ticket but the configured URL is invalid");
        return;
    };
    let app = app.clone();
    // Window ops from a plain thread: hop to the main thread first.
    let _ = app.clone().run_on_main_thread(move || {
        let Some(w) = app.get_webview_window("main") else {
            eprintln!("shell: browser sign-in found no main window");
            return;
        };
        match tauri::Url::parse(&target) {
            Ok(u) => {
                if let Err(e) = w.navigate(u) {
                    eprintln!("shell: browser sign-in could not navigate: {e}");
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("shell: browser sign-in built a bad URL: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_callback() {
        let line = "GET /callback?ticket=sit_abc&state=n0nce HTTP/1.1";
        assert_eq!(
            parse_callback(line),
            Some(("sit_abc".into(), "n0nce".into()))
        );
    }

    #[test]
    fn percent_decodes_values() {
        let line = "GET /callback?ticket=a%2Bb&state=x%20y HTTP/1.1";
        assert_eq!(parse_callback(line), Some(("a+b".into(), "x y".into())));
    }

    #[test]
    fn rejects_wrong_path_or_missing_pieces() {
        assert_eq!(parse_callback("GET /other?ticket=t&state=s HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?ticket=t HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?state=s HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?ticket=&state=s HTTP/1.1"), None);
        assert_eq!(parse_callback(""), None);
    }

    #[test]
    fn handoff_url_uses_the_origin_only() {
        let u = handoff_url("https://chartkar.app/some/path?x=1", 49213, "n0nce").unwrap();
        assert_eq!(
            u,
            "https://chartkar.app/?shell_auth=1&port=49213&state=n0nce"
        );
    }

    #[test]
    fn ticket_url_appends_to_the_configured_url() {
        assert_eq!(
            ticket_url("https://chartkar.app", "sit_abc").unwrap(),
            "https://chartkar.app/?__clerk_ticket=sit_abc"
        );
        assert_eq!(
            ticket_url("http://localhost:5173/?a=1", "t").unwrap(),
            "http://localhost:5173/?a=1&__clerk_ticket=t"
        );
    }
}
```

- [ ] **Step 3: Run the module tests to verify they fail to compile, then register the command**

Run: `cd tauri-shell/src-tauri && cargo test --quiet`
Expected: only the 3 settings tests run (an undeclared module is silently ignored, which is the failure mode here). Then make the three-edit-rule changes plus wiring in `main.rs`:

- `mod browser_auth;` next to `mod appnap;`
- `.manage(browser_auth::PendingAuth::default())` next to the existing `.manage(Unread::default())`
- `.plugin(tauri_plugin_opener::init())` next to the other plugins
- `generate_handler![...]` gains `browser_auth::browser_sign_in`

In `build.rs`, append `"browser_sign_in"` to the commands array.

In BOTH `capabilities/default.json` and `capabilities/served-ui.json`, append `"allow-browser-sign-in"` to `permissions`.

In `capabilities/served-ui.json` only, extend `remote.urls` to:

```json
"urls": ["http://localhost:*", "http://127.0.0.1:*", "https://chartkar.app", "https://www.chartkar.app"]
```

(This also fixes native banners and the tray glyph being silently dead against the hosted app.)

- [ ] **Step 4: Run tests and build**

Run: `cd tauri-shell/src-tauri && cargo test --quiet && cargo build --quiet`
Expected: 8 tests pass (3 settings + 5 browser_auth), clean build.

- [ ] **Step 5: Commit**

```bash
git add tauri-shell/src-tauri/src/browser_auth.rs tauri-shell/src-tauri/src/main.rs tauri-shell/src-tauri/build.rs tauri-shell/src-tauri/Cargo.toml tauri-shell/src-tauri/Cargo.lock tauri-shell/src-tauri/capabilities/default.json tauri-shell/src-tauri/capabilities/served-ui.json
git commit -m "feat(shell): browser sign-in via a loopback handoff"
```

---

### Task 7: Docs and ship bookkeeping

**Files:**
- Modify: `tauri-shell/README.md`, `docs/superpowers/specs/2026-09-11-shell-browser-auth-design.md`

**Interfaces:**
- Consumes: everything above, shipped.
- Produces: docs that match reality.

- [ ] **Step 1: Update `tauri-shell/README.md`**

Add a "Browser sign-in" section: what the button does, the loopback + state-nonce flow, the `browser_sign_in` command in the three-edit-rule list, and that `served-ui.json` now includes the chartkar.app origins. Add to the human-verification list: the end-to-end handoff against chartkar.app (button, Chrome tab, shell lands signed in), the signed-out-Chrome variant, and the listener timeout.

- [ ] **Step 2: Update the spec status line**

In `docs/superpowers/specs/2026-09-11-shell-browser-auth-design.md` change the status to `**Status:** Shipped <today's date> (plan: docs/superpowers/plans/2026-09-11-shell-browser-auth.md)`.

- [ ] **Step 3: Final verification sweep**

Run: `cd backend && python3 -m pytest tests/test_shell_auth.py -q`
Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellAuthHandoff.test.tsx src/components/ShellTicketSignIn.test.tsx`
Run: `cd tauri-shell/src-tauri && cargo test --quiet`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tauri-shell/README.md docs/superpowers/specs/2026-09-11-shell-browser-auth-design.md
git commit -m "docs(shell): record the browser sign-in handoff"
```
