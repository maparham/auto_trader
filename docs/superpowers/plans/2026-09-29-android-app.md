# Chartkar Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 Android app that bundles the Chartkar frontend, talks to the hosted backend, and signs in through the user's default browser.

**Architecture:** A new `tauri-android/` Tauri 2 project whose `frontendDist` is a production build of `frontend/`. Sign-in reuses the desktop shell's ticket handoff (`/api/auth/shell-token`, `?__clerk_ticket=`), but the ticket returns through an Android Intent URL to a verified App Link instead of a loopback listener. Android-only frontend behavior keys on a new `inAndroidApp()`.

**Tech Stack:** Tauri 2 (Rust), tauri-plugin-opener, tauri-plugin-deep-link, tauri-plugin-store; React + Vitest (frontend); FastAPI + pytest (backend config only).

**Spec:** `docs/superpowers/specs/2026-09-29-android-app-design.md`

## Global Constraints

- Package / identifier: `app.chartkar.android`.
- Handoff and callback host: `https://chartkar.app`; callback path `/app-auth/callback`.
- API base baked into the build: `https://api.chartkar.app`; Clerk key: the `CLERK_PK` value in `scripts/deploy-demo.sh`. `VITE_AGENT_BRIDGE` stays unset.
- Pending sign-in state TTL: 300 seconds, persisted in app-private storage.
- App origin: `http://tauri.localhost` by default, provisional until Task 3 decides (may become `https://tauri.localhost`). Every place that names it reads the value Task 3 records.
- No em dashes ("—" or "--") in UI text, comments or docs.
- Frontend tests: run only the named test files, never the whole suite. `tsc -b` is the typecheck.
- Rust builds, `cargo test`, Gradle and emulator runs are CPU-heavy on the user's laptop: batch them and ask before running.
- Commit to the current branch (`main`); stage files by explicit path; never stash, clean or restore (other sessions share the worktree).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. User taps "Sign in with your browser" twice: the first attempt's callback must be dropped as a mismatch, the second must succeed. (Task 9 test `decide_mismatch_keeps_pending`.)
2. User taps "Return to Chartkar" twice, or long after: the second callback finds nothing pending and shows "Sign-in expired", never a crash or a loop. (Task 9 test `decide_nothing_pending_is_expired`; Task 6 test for the message.)
3. A ticket or state containing `&`, `=`, `+` or `#` survives the intent URL round trip. (Task 5 test `round-trips awkward characters`.)
4. The App Link opens in the browser instead of the app: the ticket must not stay visible in the URL bar or history. (Task 7 test `strips the ticket from the URL`.)
5. Back pressed with two sheets stacked (settings sheet over tab overview) closes only the top one. (Task 8 test `closes only the topmost`.)

---

### Task 0: Android toolchain (user action)

No code. The SDK (`~/Library/Android/sdk`), NDK `27.2.12479018`, JDK 17, adb and tauri-cli 2.11.4 are already installed; Rust Android targets and env vars are not.

- [ ] **Step 1: Ask the user to run (downloads, low CPU):**

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

- [ ] **Step 2: Ask the user to add to `~/.zshrc`, then open a new shell:**

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
```

- [ ] **Step 3: Verify**

Run: `rustup target list --installed | grep android; echo $NDK_HOME; ls ~/Library/Android/sdk/system-images`
Expected: four android targets, the NDK path, at least one system image (else the user creates an emulator in Android Studio's Device Manager).

---

### Task 1: Scaffold `tauri-android/`

**Files:**
- Create: `tauri-android/.gitignore`
- Create: `tauri-android/README.md`
- Create: `tauri-android/scripts/build-frontend.sh`
- Create: `tauri-android/src-tauri/Cargo.toml`
- Create: `tauri-android/src-tauri/build.rs`
- Create: `tauri-android/src-tauri/tauri.conf.json`
- Create: `tauri-android/src-tauri/src/lib.rs`
- Create: `tauri-android/src-tauri/src/main.rs`
- Create: `tauri-android/src-tauri/capabilities/default.json`
- Create: `tauri-android/src-tauri/icons/` (generated)

**Interfaces:**
- Produces: a buildable Tauri app with an empty `generate_handler![]`, the three plugins registered, `run()` in `lib.rs` as the mobile entry point. Task 10 adds commands and setup.

- [ ] **Step 1: Frontend build script**

`tauri-android/scripts/build-frontend.sh`:

```bash
#!/usr/bin/env bash
# Builds frontend/ into frontend/dist-android for the APK. Same values the
# hosted build uses (scripts/deploy-demo.sh), so the app talks to prod.
set -euo pipefail
cd "$(dirname "$0")/../../frontend"
VITE_API_BASE="https://api.chartkar.app" \
VITE_CLERK_PUBLISHABLE_KEY="pk_live_Y2xlcmsuY2hhcnRrYXIuYXBwJA" \
  npx vite build --outDir dist-android --emptyOutDir
```

Run: `chmod +x tauri-android/scripts/build-frontend.sh`

- [ ] **Step 2: `.gitignore`**

```
src-tauri/target/
src-tauri/gen/schemas/
src-tauri/permissions/autogenerated/
```

Also add `dist-android/` to `frontend/.gitignore` (create the line; check the file first).

`src-tauri/gen/android/` IS committed: it holds the manifest and Gradle config that later tasks edit.

- [ ] **Step 3: `Cargo.toml`**

```toml
[package]
name = "chartkar-android"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"

[lib]
name = "chartkar_android_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri-plugin-opener = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-store = "2"
url = "2"
rand = "0.8"

[profile.release]
strip = true
lto = true
```

- [ ] **Step 4: `build.rs`**

```rust
fn main() {
    // App commands need an ACL entry or invokes fail with "not allowed".
    // Keep this list in sync with `generate_handler!` in lib.rs.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["browser_sign_in"])),
    )
    .expect("failed to run tauri-build");
}
```

- [ ] **Step 5: `tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Chartkar",
  "version": "0.1.0",
  "identifier": "app.chartkar.android",
  "build": {
    "frontendDist": "../../frontend/dist-android",
    "beforeBuildCommand": "../scripts/build-frontend.sh"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{ "label": "main", "title": "Chartkar" }],
    "security": { "csp": null }
  },
  "plugins": {
    "deep-link": {
      "mobile": [
        {
          "scheme": ["https"],
          "host": "chartkar.app",
          "pathPrefix": ["/app-auth/callback"],
          "appLink": true
        }
      ]
    }
  },
  "bundle": {
    "active": true,
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.png"]
  }
}
```

Before relying on the `deep-link` block, check its shape against the installed plugin's README (`~/.cargo/registry/src/*/tauri-plugin-deep-link-2.*/README.md`); older 2.x releases take `host` + `pathPrefix` without `scheme`/`appLink`. Match what the resolved version documents.

- [ ] **Step 6: `src/lib.rs` and `src/main.rs`**

```rust
// lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Chartkar");
}
```

```rust
// main.rs: desktop entry, only used for `cargo check` on the laptop.
fn main() {
    chartkar_android_lib::run()
}
```

- [ ] **Step 7: `capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/mobile-schema.json",
  "identifier": "default",
  "description": "Commands reachable from the bundled app.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "deep-link:default",
    "store:default",
    "allow-browser-sign-in"
  ]
}
```

(`allow-browser-sign-in` resolves once Task 10 registers the command; until then remove it if `tauri build` rejects an unknown permission, and restore it in Task 10.)

- [ ] **Step 8: Icons and Android project (ask user first: CPU)**

```bash
cd tauri-android/src-tauri
cargo tauri icon ../../frontend/public/icons/icon-512.png   # check the exact file name in frontend/public/icons
cargo tauri android init
```

Expected: `icons/` populated, `gen/android/` created.

- [ ] **Step 9: First debug build on the emulator (ask user first: CPU)**

```bash
cd tauri-android/src-tauri
cargo tauri android dev
```

Expected: the app opens on the emulator and shows the Chartkar sign-in screen (the embedded Clerk card plus "Sign in with your browser", since `shouldShowSignIn` is already true inside any Tauri webview). The browser button fails for now; that is expected until Task 10.

- [ ] **Step 10: README**

`tauri-android/README.md`: what the app is (bundled UI, hosted backend), the Task 0 env vars, `cargo tauri android dev` / `cargo tauri android build --aab`, where `build-frontend.sh` gets its values, and a pointer to the spec.

- [ ] **Step 11: Commit**

```bash
git add tauri-android/.gitignore tauri-android/README.md tauri-android/scripts/build-frontend.sh tauri-android/src-tauri/Cargo.toml tauri-android/src-tauri/Cargo.lock tauri-android/src-tauri/build.rs tauri-android/src-tauri/tauri.conf.json tauri-android/src-tauri/src tauri-android/src-tauri/capabilities tauri-android/src-tauri/icons tauri-android/src-tauri/gen/android frontend/.gitignore
git commit -m "feat(android): scaffold the Tauri 2 Android app"
```

---

### Task 2: Backend allowlists for the app origin

The backend reads both allowlists from comma-separated env vars, so production needs a config change, not code. Add one test so the exact-string behavior the spec relies on is pinned.

**Files:**
- Test: `backend/tests/test_api_guard.py`
- Test: `backend/tests/test_api_auth.py`

- [ ] **Step 1: Write the tests**

Append to `backend/tests/test_api_guard.py`:

```python
def test_cors_origins_accepts_the_android_app_origin(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://chartkar.app,http://tauri.localhost")
    from auto_trader.api.guard import cors_origins

    origins = cors_origins()
    assert "http://tauri.localhost" in origins
    # Exact match: the https variant is a different origin.
    assert "https://tauri.localhost" not in origins
```

Append to `backend/tests/test_api_auth.py`, following the `clerk` fixture used by `test_wrong_azp_rejected`:

```python
def test_android_app_azp_accepted_when_listed(clerk, monkeypatch):
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://chartkar.app,http://tauri.localhost")
    assert auth.verify_token(clerk_fake.make_token(azp="http://tauri.localhost")) == "user_123"
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(azp="https://tauri.localhost"))
```

(Check how `test_wrong_azp_rejected` sets the parties env and asserts the error; mirror it exactly, including the imports.)

- [ ] **Step 2: Run**

Run: `cd backend && python3 -m pytest tests/test_api_guard.py tests/test_api_auth.py -q`
Expected: PASS (these pin current behavior; no production code changes).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_api_guard.py backend/tests/test_api_auth.py
git commit -m "test(auth): pin exact-origin matching for the Android app origin"
```

- [ ] **Step 4: Production config (user action, after Task 3 picks the origin)**

Ask the user to append the chosen origin to both `CORS_ORIGINS` and `CLERK_AUTHORIZED_PARTIES` in `/etc/auto-trader/demo.env` on the box and restart the backend service. Show the exact lines. Do not do this yourself.

---

### Task 3: Spike (origin, Clerk, back button)

Throwaway investigation on the Task 1 build. Nothing is committed except the findings appended to the spec. Inspect the app's webview from desktop Chrome at `chrome://inspect/#devices`.

- [ ] **Step 1: Secure context.** In the app's devtools console:

```js
({ secure: window.isSecureContext, subtle: !!crypto.subtle, push: "PushManager" in window, sw: "serviceWorker" in navigator, origin: location.origin })
```

If `secure` is false: set `"app": { "windows": [{ "label": "main", "title": "Chartkar", "useHttpsScheme": true }] }` (check the key's exact place in the Tauri 2 config schema), rebuild, rerun. Record the origin that ends up secure.

- [ ] **Step 2: Backend reach.** Ask the user to do Task 2 Step 4 with the Step 1 origin. Then in the app console:

```js
await fetch("https://api.chartkar.app/api/brokers").then(r => r.status)
```

Expected: 200 (CORS passes). A `/ws/state` connect is checked in Step 3 once signed in.

- [ ] **Step 3: Clerk session.** Sign in with the embedded Clerk card (password). Check: the app loads, API calls succeed (no 401 in the network tab, confirming `azp`), `/ws/state` connects. Kill the app from recents, reopen: still signed in?

- [ ] **Step 4: Ticket sign-in.** Sign out. In desktop Chrome on chartkar.app (signed in), run in the console:

```js
(await (await fetch("https://api.chartkar.app/api/auth/shell-token", { method: "POST", headers: { Authorization: `Bearer ${await window.Clerk.session.getToken()}` } })).json()).token
```

In the app console: `location.href = "/?__clerk_ticket=" + encodeURIComponent("<token>")`. Expected: signed in.

- [ ] **Step 5: Back button.** With the settings sheet open, press back. Record: closes the app, does nothing, or goes back in webview history.

- [ ] **Step 6: Record and decide.** Append a `## Spike findings (date)` section to the spec: chosen origin, results of Steps 1 to 5, and one of:
  - **Go:** continue with Task 4.
  - **Adjust:** Clerk session fails in Step 3 or 4. Stop and report to the user. Plan B (headless clerk-js, `standardBrowser: false`, token cache) gets its own plan.

If the origin changed to https, update the Global Constraints line of this plan and the spec's Architecture origin line in the same commit.

```bash
git add docs/superpowers/specs/2026-09-29-android-app-design.md docs/superpowers/plans/2026-09-29-android-app.md
git commit -m "docs(android): spike findings"
```

---

### Task 4: `inAndroidApp()` and push hidden in the app

**Files:**
- Modify: `frontend/src/lib/shellBridge.ts`
- Modify: `frontend/src/lib/pushClient.ts:13-19`
- Modify: `frontend/src/mobile/MobileApp.tsx:78-82`
- Test: `frontend/src/lib/shellBridge.test.ts` (create if missing)
- Test: `frontend/src/lib/pushClient.test.ts` (create if missing, else append)

**Interfaces:**
- Produces: `export function inAndroidApp(): boolean` in `lib/shellBridge.ts`.

- [ ] **Step 1: Failing tests**

`frontend/src/lib/shellBridge.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { inAndroidApp } from "./shellBridge";

const w = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete w.__TAURI__;
  vi.unstubAllGlobals();
});

function ua(value: string) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: value });
}

it("is true only inside a Tauri webview on Android", () => {
  ua("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36");
  expect(inAndroidApp()).toBe(false); // Android Chrome, no shell
  w.__TAURI__ = { core: {} };
  expect(inAndroidApp()).toBe(true);
  ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  expect(inAndroidApp()).toBe(false); // desktop shell
});
```

Add to `frontend/src/lib/pushClient.test.ts` (keep existing tests; add `// @vitest-environment jsdom` if the file is new):

```ts
import { afterEach, expect, it, vi } from "vitest";
import { pushSupported } from "./pushClient";

it("reports push unsupported inside the Android app even if the WebView exposes the APIs", () => {
  const w = window as unknown as Record<string, unknown>;
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("navigator", { ...navigator, serviceWorker: {}, userAgent: "Mozilla/5.0 (Linux; Android 14)" });
  w.__TAURI__ = { core: {} };
  expect(pushSupported()).toBe(false);
  delete w.__TAURI__;
  expect(pushSupported()).toBe(true);
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && npx vitest run src/lib/shellBridge.test.ts src/lib/pushClient.test.ts`
Expected: FAIL (`inAndroidApp` is not exported; push reports supported in the app).

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/shellBridge.ts`:

```ts
/** True only inside the Android app (tauri-android/). The desktop shell is
 *  also a Tauri webview, so Android-only behavior must key on this, never on
 *  inShell() alone. */
export function inAndroidApp(): boolean {
  return inShell() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}
```

In `frontend/src/lib/pushClient.ts`, `pushSupported()`:

```ts
import { inAndroidApp } from "./shellBridge";

/** Feature-detect Push API + service worker support (Safari on some OSes,
 *  and any non-secure-context page, lack one or both). Always false in the
 *  Android app: a WebView cannot deliver web push, and FCM is sub-project B. */
export function pushSupported(): boolean {
  return (
    !inAndroidApp() &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis
  );
}
```

In `frontend/src/mobile/MobileApp.tsx` (the `alert-sw.js` effect near line 78):

```tsx
  useEffect(() => {
    if (inAndroidApp()) return; // no web push in the app; FCM is sub-project B
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/alert-sw.js").catch(() => {});
    }
  }, []);
```

with `import { inAndroidApp } from "../lib/shellBridge";`.

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/lib/shellBridge.test.ts src/lib/pushClient.test.ts src/mobile/MobileApp.test.tsx src/mobile/MobileSettingsSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/shellBridge.ts frontend/src/lib/shellBridge.test.ts frontend/src/lib/pushClient.ts frontend/src/lib/pushClient.test.ts frontend/src/mobile/MobileApp.tsx
git commit -m "feat(android): detect the Android app and hide web push there"
```

---

### Task 5: Handoff params union and the "Return to Chartkar" button

**Files:**
- Modify: `frontend/src/lib/shellAuthBoot.ts`
- Modify: `frontend/src/components/ShellAuthHandoff.tsx`
- Test: `frontend/src/lib/shellAuthBoot.test.ts`
- Test: `frontend/src/components/ShellAuthHandoff.test.tsx`

**Interfaces:**
- Produces:
  - `type ShellAuthParams = { kind: "loopback"; port: number; state: string } | { kind: "app"; state: string }`
  - `APP_CALLBACK_URL = "https://chartkar.app/app-auth/callback"`, `APP_PACKAGE = "app.chartkar.android"`
  - `appReturnIntentUrl(ticket: string, state: string): string`
- Consumes: nothing new. `main.tsx` passes `shellAuthParams` through unchanged, so it needs no edit.

- [ ] **Step 1: Update and extend parser tests**

In `frontend/src/lib/shellAuthBoot.test.ts`, change the first expectation to include `kind: "loopback"`:

```ts
    expect(parseShellAuthParams("?shell_auth=1&port=49213&state=abc123")).toEqual({
      kind: "loopback",
      port: 49213,
      state: "abc123",
    });
```

Add:

```ts
describe("parseShellAuthParams, Android app shape", () => {
  it("parses return=app with a state and no port", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app&state=s1")).toEqual({ kind: "app", state: "s1" });
  });
  it("ignores a stray port on the app shape", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app&port=49213&state=s1")).toEqual({ kind: "app", state: "s1" });
  });
  it("rejects the app shape without a state", () => {
    expect(parseShellAuthParams("?shell_auth=1&return=app")).toBeNull();
  });
});

describe("appReturnIntentUrl", () => {
  it("pins the package and carries no ticket in the fallback", () => {
    const u = appReturnIntentUrl("sit_abc", "s1");
    expect(u.startsWith("intent://chartkar.app/app-auth/callback?")).toBe(true);
    expect(u).toContain("#Intent;scheme=https;package=app.chartkar.android;");
    expect(u.endsWith(";end")).toBe(true);
    const fallback = decodeURIComponent(u.split("S.browser_fallback_url=")[1].split(";")[0]);
    expect(fallback).toBe("https://chartkar.app/app-auth/callback");
  });
  it("round-trips awkward characters", () => {
    const u = appReturnIntentUrl("a&b=c+d#e", "s/1?");
    const query = u.slice(u.indexOf("?") + 1, u.indexOf("#Intent"));
    const q = new URLSearchParams(query);
    expect(q.get("ticket")).toBe("a&b=c+d#e");
    expect(q.get("state")).toBe("s/1?");
  });
});
```

Update the import to `import { appReturnIntentUrl, parseClerkTicket, parseShellAuthParams } from "./shellAuthBoot";`.

- [ ] **Step 2: Handoff component tests**

In `frontend/src/components/ShellAuthHandoff.test.tsx`, change every `params={{ port: 49213, state: "n0nce" }}` to `params={{ kind: "loopback", port: 49213, state: "n0nce" }}`. Add:

```tsx
it("app shape: mints, does not navigate, and shows a return link", async () => {
  stubLocation();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ token: "sit_abc" }), { status: 200 }),
  ));
  const { findByRole } = render(<ShellAuthHandoff params={{ kind: "app", state: "s1" }} />);
  const link = await findByRole("link", { name: "Return to Chartkar" });
  expect(link.getAttribute("href")).toBe(appReturnIntentUrl("sit_abc", "s1"));
  expect(replace).not.toHaveBeenCalled();
});
```

with `import { appReturnIntentUrl } from "../lib/shellAuthBoot";`.

- [ ] **Step 3: Run, expect FAIL**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellAuthHandoff.test.tsx`
Expected: FAIL (no `kind`, no `appReturnIntentUrl`, no link).

- [ ] **Step 4: Implement the parser**

Replace the body of `frontend/src/lib/shellAuthBoot.ts` above `parseClerkTicket`:

```ts
// Pure parsing for the shell browser-auth handoff boots, mirroring
// snapshotBoot.ts. Two handoff shapes boot the browser-side page:
// ?shell_auth=1&port=..&state=.. (desktop shell, loopback return) and
// ?shell_auth=1&return=app&state=.. (Android app, intent-URL return).
// ?__clerk_ticket=.. is the webview-side sign-in ticket.

export type ShellAuthParams =
  | { kind: "loopback"; port: number; state: string }
  | { kind: "app"; state: string };

export const APP_CALLBACK_URL = "https://chartkar.app/app-auth/callback";
export const APP_PACKAGE = "app.chartkar.android";

export function parseShellAuthParams(search: string): ShellAuthParams | null {
  const q = new URLSearchParams(search);
  if (q.get("shell_auth") !== "1") return null;
  const state = q.get("state");
  if (!state) return null;
  if (q.get("return") === "app") return { kind: "app", state };
  const port = Number(q.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: "loopback", port, state };
}

/** The Android return link. An intent URL, not the plain https callback:
 *  Chrome does not hand a same-site navigation to an App Link app, and an
 *  intent URL on a tap opens the pinned package regardless of domain. The
 *  fallback (app not installed) carries no ticket. */
export function appReturnIntentUrl(ticket: string, state: string): string {
  const q = new URLSearchParams({ ticket, state });
  const cb = new URL(APP_CALLBACK_URL);
  return (
    `intent://${cb.host}${cb.pathname}?${q.toString()}` +
    `#Intent;scheme=https;package=${APP_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(APP_CALLBACK_URL)};end`
  );
}
```

- [ ] **Step 5: Implement the handoff branch**

In `frontend/src/components/ShellAuthHandoff.tsx`: add `const [appTicket, setAppTicket] = useState<string | null>(null);`. Replace the three lines that build and navigate to the loopback URL with:

```tsx
      if (params.kind === "app") {
        // A tap is required: Chrome only hands an intent URL to an app on a
        // user gesture. The token's 5 minute TTL already started at the mint.
        setAppTicket(body.token);
        return;
      }
      const u = new URL(`http://127.0.0.1:${params.port}/callback`);
      u.searchParams.set("ticket", body.token);
      u.searchParams.set("state", params.state);
      window.location.replace(u.toString());
```

Replace the returned JSX's inner `<div>` content:

```tsx
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        {error ? (
          `Handoff failed: ${error}. Close this tab and tap the sign-in button in Chartkar again.`
        ) : appTicket ? (
          <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
            <a
              href={appReturnIntentUrl(appTicket, params.state)}
              style={{
                background: "var(--accent)",
                color: "var(--accent-text)",
                borderRadius: 8,
                padding: "12px 28px",
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Return to Chartkar
            </a>
            <div>This link works for 5 minutes. If it has expired, sign in from the app again.</div>
          </div>
        ) : (
          "Signing in to Chartkar..."
        )}
      </div>
```

Update the file's header comment to mention the app shape, and import `appReturnIntentUrl`.

- [ ] **Step 6: Run, expect PASS; typecheck**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellAuthHandoff.test.tsx && npx tsc -b`
Expected: PASS, no type errors (main.tsx passes the union through untouched).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/shellAuthBoot.ts frontend/src/lib/shellAuthBoot.test.ts frontend/src/components/ShellAuthHandoff.tsx frontend/src/components/ShellAuthHandoff.test.tsx
git commit -m "feat(android): app-shaped handoff with an intent-URL return link"
```

---

### Task 6: Sign-in screen on Android

**Files:**
- Modify: `frontend/src/components/ShellTicketSignIn.tsx`
- Modify: `frontend/src/lib/shellAuthBoot.ts` (add `parseAuthError`)
- Test: `frontend/src/components/ShellTicketSignIn.test.tsx`
- Test: `frontend/src/lib/shellAuthBoot.test.ts`

**Interfaces:**
- Consumes: `inAndroidApp()` (Task 4).
- Produces: `parseAuthError(search: string): "expired" | null`. Task 10's Rust navigates to `/?auth_error=expired`; this is the reader.

- [ ] **Step 1: Failing tests**

In `frontend/src/lib/shellAuthBoot.test.ts`:

```ts
describe("parseAuthError", () => {
  it("recognises only the expired code", () => {
    expect(parseAuthError("?auth_error=expired")).toBe("expired");
    expect(parseAuthError("?auth_error=other")).toBeNull();
    expect(parseAuthError("")).toBeNull();
  });
});
```

In `frontend/src/components/ShellTicketSignIn.test.tsx`, add a helper and tests:

```tsx
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36";

function androidApp(invoke: (...a: unknown[]) => Promise<unknown>) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: ANDROID_UA });
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
}

it("Android: hides the Clerk card and treats a true reply as success", async () => {
  const invoke = vi.fn(async () => true);
  androidApp(invoke);
  const { queryByTestId, getByText, queryByText } = render(<ShellTicketSignIn />);
  expect(queryByTestId("clerk-card")).toBeNull();
  fireEvent.click(getByText("Sign in with your browser"));
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(queryByText(/Could not start browser sign-in/)).toBeNull();
  vi.unstubAllGlobals();
});

it("Android: shows the expired message from ?auth_error=expired and strips it", () => {
  androidApp(vi.fn(async () => true));
  window.history.replaceState(null, "", "/?auth_error=expired");
  const { getByText } = render(<ShellTicketSignIn />);
  getByText("Sign-in expired, try again.");
  expect(window.location.search).not.toContain("auth_error");
  vi.unstubAllGlobals();
});

it("desktop shell keeps the Clerk card", () => {
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: vi.fn(async () => 1) } };
  const { getByTestId } = render(<ShellTicketSignIn />);
  getByTestId("clerk-card");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellTicketSignIn.test.tsx`

- [ ] **Step 3: Implement**

In `shellAuthBoot.ts`:

```ts
/** ?auth_error=expired: set by the Android app when a sign-in callback
 *  arrived with nothing pending or past its deadline. */
export function parseAuthError(search: string): "expired" | null {
  return new URLSearchParams(search).get("auth_error") === "expired" ? "expired" : null;
}
```

In `ShellTicketSignIn.tsx`:
- import `parseAuthError` and `inAndroidApp`.
- `const [expired] = useState(() => parseAuthError(window.location.search) === "expired");` plus a mount effect that deletes `auth_error` from the URL with `replaceState` (same pattern as `stripTicketParam`).
- `const android = inAndroidApp();`
- Render `{!android && <SignIn />}`.
- Success check: `.then((reply) => { if (typeof reply !== "number" && reply !== true) setButtonError(true); })`, with a comment: desktop returns its loopback port, Android returns `true`, `shellInvoke` maps failure to `null`.
- Above the button: `{expired && <div>Sign-in expired, try again.</div>}`.
- Update the header comment for the Android behavior.

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/lib/shellAuthBoot.test.ts src/components/ShellTicketSignIn.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/shellAuthBoot.ts frontend/src/lib/shellAuthBoot.test.ts frontend/src/components/ShellTicketSignIn.tsx frontend/src/components/ShellTicketSignIn.test.tsx
git commit -m "feat(android): browser-only sign-in screen with an expired notice"
```

---

### Task 7: `/app-auth/callback` fallback page and App Link hosting

**Files:**
- Create: `frontend/src/lib/appAuthCallbackBoot.ts`
- Create: `frontend/src/components/AppAuthCallbackPage.tsx`
- Modify: `frontend/src/main.tsx` (boot branch before the Clerk tree)
- Create: `frontend/public/.well-known/assetlinks.json`
- Test: `frontend/src/lib/appAuthCallbackBoot.test.ts`
- Test: `frontend/src/components/AppAuthCallbackPage.test.tsx`

**Interfaces:**
- Produces: `shouldBootAppAuthCallback(pathname?: string): boolean`.

- [ ] **Step 1: Failing tests**

`frontend/src/lib/appAuthCallbackBoot.test.ts`:

```ts
import { expect, it } from "vitest";
import { shouldBootAppAuthCallback } from "./appAuthCallbackBoot";

it("matches the callback path with or without a trailing slash", () => {
  expect(shouldBootAppAuthCallback("/app-auth/callback")).toBe(true);
  expect(shouldBootAppAuthCallback("/app-auth/callback/")).toBe(true);
  expect(shouldBootAppAuthCallback("/")).toBe(false);
  expect(shouldBootAppAuthCallback("/app-auth")).toBe(false);
});
```

`frontend/src/components/AppAuthCallbackPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import AppAuthCallbackPage from "./AppAuthCallbackPage";

afterEach(cleanup);

it("strips the ticket from the URL and never renders it", () => {
  window.history.replaceState(null, "", "/app-auth/callback?ticket=sit_secret&state=s1");
  const { container, getByText } = render(<AppAuthCallbackPage />);
  getByText(/Open the Chartkar app/);
  expect(window.location.search).toBe("");
  expect(container.textContent).not.toContain("sit_secret");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && npx vitest run src/lib/appAuthCallbackBoot.test.ts src/components/AppAuthCallbackPage.test.tsx`

- [ ] **Step 3: Implement**

`frontend/src/lib/appAuthCallbackBoot.ts`:

```ts
// /app-auth/callback is the Android App Link target. The app normally
// receives it; this page only renders when the link opened in a browser
// instead (app not installed, link not verified). Same pathname-only
// routing as adminBoot.ts.
export function shouldBootAppAuthCallback(pathname: string = window.location.pathname): boolean {
  return pathname.replace(/\/+$/, "") === "/app-auth/callback";
}
```

`frontend/src/components/AppAuthCallbackPage.tsx`:

```tsx
// Browser fallback for the Android sign-in return link. The URL may carry a
// single-use ticket: drop it from the address bar and history before
// anything else, and never render it.
import { useState } from "react";

export default function AppAuthCallbackPage() {
  useState(() => {
    window.history.replaceState(null, "", window.location.pathname);
    return null;
  });
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        Open the Chartkar app and sign in again from there.
      </div>
    </div>
  );
}
```

In `frontend/src/main.tsx`: `import AppAuthCallbackPage from './components/AppAuthCallbackPage.tsx'`, `import { shouldBootAppAuthCallback } from './lib/appAuthCallbackBoot.ts'`, a `const bootAppAuthCallback = shouldBootAppAuthCallback()` with a one-line comment next to the other boot decisions, and make it the first branch of the render: `{bootAppAuthCallback ? (<AppAuthCallbackPage />) : snapshotParams ? (...`. It renders outside the Clerk tree so Clerk never sees the ticket.

- [ ] **Step 4: `assetlinks.json` with the debug key**

Get the debug fingerprint: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA256`

`frontend/public/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "app.chartkar.android",
      "sha256_cert_fingerprints": ["<DEBUG SHA256 from keytool, colon-separated>"]
    }
  }
]
```

Task 12 adds the upload and Play signing fingerprints.

- [ ] **Step 5: Run, expect PASS; typecheck**

Run: `cd frontend && npx vitest run src/lib/appAuthCallbackBoot.test.ts src/components/AppAuthCallbackPage.test.tsx && npx tsc -b`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/appAuthCallbackBoot.ts frontend/src/lib/appAuthCallbackBoot.test.ts frontend/src/components/AppAuthCallbackPage.tsx frontend/src/components/AppAuthCallbackPage.test.tsx frontend/src/main.tsx frontend/public/.well-known/assetlinks.json
git commit -m "feat(android): App Link callback fallback page and assetlinks"
```

- [ ] **Step 7: Hosting check (after the user's next deploy)**

```bash
curl -sI https://chartkar.app/.well-known/assetlinks.json | grep -i "^HTTP\|content-type"
curl -sI https://chartkar.app/app-auth/callback | grep -i "^HTTP"
```

Expected: `200` + `application/json`; `200` for the callback. If the callback 404s, add `frontend/public/_redirects` with `/app-auth/*  /index.html  200` and commit. If assetlinks has the wrong type, add `frontend/public/_headers`:

```
/.well-known/assetlinks.json
  Content-Type: application/json
```

---

### Task 8: Back button closes the topmost sheet (Android only)

Skip this task if Task 3 Step 5 found the back button already closes sheets (it will not: sheets have no history entries today). If Step 5 found back leaves the app instead of going back in webview history, also do Step 6.

**Files:**
- Create: `frontend/src/mobile/backStack.ts`
- Modify: `frontend/src/mobile/Sheet.tsx`
- Modify: `frontend/src/mobile/MobileChartView.tsx` (tab overview)
- Test: `frontend/src/mobile/backStack.test.ts`

**Interfaces:**
- Consumes: `inAndroidApp()` (Task 4).
- Produces: `useBackClose(active: boolean, onClose: () => void): void` and, for tests, `pushBackCloser(close: () => void): () => void`.

- [ ] **Step 1: Failing tests**

`frontend/src/mobile/backStack.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { pushBackCloser } from "./backStack";

afterEach(() => vi.restoreAllMocks());

function pressBack() {
  window.dispatchEvent(new PopStateEvent("popstate"));
}

it("back closes the sheet that registered", () => {
  const close = vi.fn();
  pushBackCloser(close);
  pressBack();
  expect(close).toHaveBeenCalledOnce();
});

it("closes only the topmost when two are stacked", () => {
  const bottom = vi.fn();
  const top = vi.fn();
  pushBackCloser(bottom);
  pushBackCloser(top);
  pressBack();
  expect(top).toHaveBeenCalledOnce();
  expect(bottom).not.toHaveBeenCalled();
  pressBack();
  expect(bottom).toHaveBeenCalledOnce();
});

it("closing from the UI pops its history entry without calling the closer", () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => pressBack());
  const close = vi.fn();
  const release = pushBackCloser(close);
  release();
  expect(back).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("release after a back press is a no-op", () => {
  const back = vi.spyOn(window.history, "back");
  const close = vi.fn();
  const release = pushBackCloser(close);
  pressBack();
  release();
  expect(back).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && npx vitest run src/mobile/backStack.test.ts`

- [ ] **Step 3: Implement**

`frontend/src/mobile/backStack.ts`:

```ts
// Android back closes the topmost open sheet before it navigates or leaves
// the app. Each open sheet pushes one history entry and a closer; the back
// press pops the entry and runs the top closer. Closing a sheet from its own
// UI pops its entry with history.back() and skips that one popstate, so the
// two paths stay in sync. Android app only: the web app keeps its history
// untouched.
import { useEffect, useRef } from "react";
import { inAndroidApp } from "../lib/shellBridge";

type Closer = () => void;

const stack: Closer[] = [];
let skipNextPop = false;
let installed = false;

function onPop(): void {
  if (skipNextPop) {
    skipNextPop = false;
    return;
  }
  stack.pop()?.();
}

export function pushBackCloser(close: Closer): () => void {
  if (!installed) {
    window.addEventListener("popstate", onPop);
    installed = true;
  }
  stack.push(close);
  window.history.pushState({ chartkarSheet: true }, "");
  return () => {
    const i = stack.lastIndexOf(close);
    if (i === -1) return; // already closed by a back press
    stack.splice(i, 1);
    skipNextPop = true;
    window.history.back();
  };
}

export function useBackClose(active: boolean, onClose: Closer): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active || !inAndroidApp()) return;
    return pushBackCloser(() => ref.current());
  }, [active]);
}
```

In `Sheet.tsx`: `import { useBackClose } from "./backStack";` and call `useBackClose(true, onClose);` at the top of the component (a Sheet is mounted only while open).

In `MobileChartView.tsx`: `useBackClose(pull.open, () => pull.setOpen(false));` next to the `usePullPanel()` call.

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npx vitest run src/mobile/backStack.test.ts src/mobile/Sheet.test.tsx src/mobile/MobileTabOverview.test.tsx src/mobile/MobileChartView.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mobile/backStack.ts frontend/src/mobile/backStack.test.ts frontend/src/mobile/Sheet.tsx frontend/src/mobile/MobileChartView.tsx
git commit -m "feat(android): back closes the topmost sheet first"
```

- [ ] **Step 6 (only if Task 3 Step 5 found back leaves the app): map back to webview history**

In `tauri-android/src-tauri/gen/android/app/src/main/java/app/chartkar/android/MainActivity.kt` (path per `cargo tauri android init`), register an `OnBackPressedCallback` that calls the webview's `goBack()` when `canGoBack()`, else disables itself and re-dispatches so the activity finishes. Get the WebView through Tauri's `onWebViewCreate(webView: WebView)` override on `TauriActivity`. Verify on the emulator: sheet open + back closes it; nothing open + back after navigating goes back; at the root, back leaves the app. Commit the file.

---

### Task 9: Rust sign-in state logic (pure, tested)

**Files:**
- Create: `tauri-android/src-tauri/src/auth.rs`
- Modify: `tauri-android/src-tauri/src/lib.rs` (add `mod auth;`)

**Interfaces:**
- Produces (all `pub` in `auth`):
  - `const TTL_SECS: u64 = 300`, `const CALLBACK_HOST: &str = "chartkar.app"`, `const CALLBACK_PATH: &str = "/app-auth/callback"`, `const HANDOFF_ORIGIN: &str = "https://chartkar.app/"`
  - `struct Pending { state: String, expires_at: u64 }` (serde)
  - `enum Outcome { Accept(String), Expired, Mismatch }`
  - `fn parse_callback(url: &str) -> Option<(String, String)>` returns `(ticket, state)`
  - `fn decide(pending: Option<&Pending>, state: &str, ticket: String, now: u64) -> Outcome`
  - `fn handoff_url(state: &str) -> String`
  - `fn app_url(current: &url::Url, key: &str, value: &str) -> url::Url` (the bundled index, origin kept, query replaced)
  - `fn random_state() -> String`

- [ ] **Step 1: Write the module with its tests first**

`tauri-android/src-tauri/src/auth.rs`:

```rust
//! Browser sign-in for the Android app. The app opens chartkar.app's handoff
//! page with a random state, the page mints a single-use Clerk ticket and
//! returns it through an intent URL to /app-auth/callback, and the app checks
//! the state before loading its bundled UI with ?__clerk_ticket=. Pending
//! state is persisted by the caller, because Android may kill the app while
//! the user is in the browser.

use serde::{Deserialize, Serialize};

pub const TTL_SECS: u64 = 300;
pub const CALLBACK_HOST: &str = "chartkar.app";
pub const CALLBACK_PATH: &str = "/app-auth/callback";
pub const HANDOFF_ORIGIN: &str = "https://chartkar.app/";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pending {
    pub state: String,
    pub expires_at: u64,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Accept(String),
    Expired,
    Mismatch,
}

pub fn random_state() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// "https://chartkar.app/app-auth/callback?ticket=..&state=.." -> (ticket, state).
/// Any other scheme, host or path, or a missing value, is None.
pub fn parse_callback(raw: &str) -> Option<(String, String)> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "https" || u.host_str() != Some(CALLBACK_HOST) {
        return None;
    }
    if u.path().trim_end_matches('/') != CALLBACK_PATH {
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

/// Nothing pending or past the deadline: Expired (the caller clears state
/// and tells the user). A different state: Mismatch (dropped; a newer
/// attempt stays pending). Otherwise Accept with the ticket.
pub fn decide(pending: Option<&Pending>, state: &str, ticket: String, now: u64) -> Outcome {
    match pending {
        None => Outcome::Expired,
        Some(p) if p.state != state => Outcome::Mismatch,
        Some(p) if now > p.expires_at => Outcome::Expired,
        Some(_) => Outcome::Accept(ticket),
    }
}

pub fn handoff_url(state: &str) -> String {
    let mut u = url::Url::parse(HANDOFF_ORIGIN).expect("constant origin parses");
    u.query_pairs_mut()
        .append_pair("shell_auth", "1")
        .append_pair("return", "app")
        .append_pair("state", state);
    u.to_string()
}

/// The bundled index at the webview's own origin (http or https
/// tauri.localhost, whichever the build uses) with one query pair.
pub fn app_url(current: &url::Url, key: &str, value: &str) -> url::Url {
    let mut u = current.join("/").expect("root joins");
    u.set_query(None);
    u.query_pairs_mut().append_pair(key, value);
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(state: &str, expires_at: u64) -> Pending {
        Pending { state: state.into(), expires_at }
    }

    #[test]
    fn parse_callback_reads_ticket_and_state() {
        assert_eq!(
            parse_callback("https://chartkar.app/app-auth/callback?ticket=sit_a%26b&state=s1"),
            Some(("sit_a&b".into(), "s1".into()))
        );
    }

    #[test]
    fn parse_callback_rejects_other_hosts_paths_and_schemes() {
        assert_eq!(parse_callback("https://evil.example/app-auth/callback?ticket=t&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/other?ticket=t&state=s"), None);
        assert_eq!(parse_callback("http://chartkar.app/app-auth/callback?ticket=t&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/app-auth/callback?ticket=&state=s"), None);
        assert_eq!(parse_callback("https://chartkar.app/app-auth/callback?ticket=t"), None);
    }

    #[test]
    fn decide_accepts_matching_state_in_time() {
        let p = pending("s1", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 1000), Outcome::Accept("t".into()));
    }

    #[test]
    fn decide_expired_after_deadline() {
        let p = pending("s1", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 1001), Outcome::Expired);
    }

    #[test]
    fn decide_nothing_pending_is_expired() {
        assert_eq!(decide(None, "s1", "t".into(), 0), Outcome::Expired);
    }

    #[test]
    fn decide_mismatch_keeps_pending() {
        // A second tap on "Sign in" replaced s1 with s2; s1's callback is dropped.
        let p = pending("s2", 1000);
        assert_eq!(decide(Some(&p), "s1", "t".into(), 10), Outcome::Mismatch);
    }

    #[test]
    fn pending_round_trips_through_json() {
        let p = pending("s1", 42);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(serde_json::from_value::<Pending>(v).unwrap(), p);
    }

    #[test]
    fn handoff_url_shape() {
        assert_eq!(
            handoff_url("s1"),
            "https://chartkar.app/?shell_auth=1&return=app&state=s1"
        );
    }

    #[test]
    fn app_url_keeps_origin_and_replaces_query() {
        let cur = url::Url::parse("http://tauri.localhost/some/path?x=1").unwrap();
        assert_eq!(
            app_url(&cur, "__clerk_ticket", "sit_a&b").as_str(),
            "http://tauri.localhost/?__clerk_ticket=sit_a%26b"
        );
        let https = url::Url::parse("https://tauri.localhost/").unwrap();
        assert!(app_url(&https, "auth_error", "expired").as_str().starts_with("https://tauri.localhost/?"));
    }

    #[test]
    fn random_state_is_64_hex_chars_and_varies() {
        let a = random_state();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_state());
    }
}
```

Add `mod auth;` to `lib.rs`.

- [ ] **Step 2: Run the tests (ask user first: CPU)**

Run: `cd tauri-android/src-tauri && cargo test --lib auth`
Expected: all 10 tests PASS. (Written with the implementation because the module is pure and small; if any test fails, fix the function, not the test, unless the test contradicts the spec.)

- [ ] **Step 3: Commit**

```bash
git add tauri-android/src-tauri/src/auth.rs tauri-android/src-tauri/src/lib.rs
git commit -m "feat(android): sign-in state and callback parsing"
```

---

### Task 10: Wire `browser_sign_in`, persistence and the deep link

**Files:**
- Modify: `tauri-android/src-tauri/src/auth.rs` (command + handler)
- Modify: `tauri-android/src-tauri/src/lib.rs`
- Modify: `tauri-android/src-tauri/capabilities/default.json` (restore `allow-browser-sign-in` if removed in Task 1)

**Interfaces:**
- Consumes: everything Task 9 produces.
- Produces: the `browser_sign_in` command (returns `true`), `handle_urls(app, urls)`.

- [ ] **Step 1: Add the command and handler to `auth.rs`** (above the tests module)

```rust
use tauri::Manager;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "auth.json";
const PENDING_KEY: &str = "pending";

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_pending(app: &tauri::AppHandle) -> Option<Pending> {
    let store = app.store(STORE_FILE).ok()?;
    serde_json::from_value(store.get(PENDING_KEY)?).ok()
}

fn save_pending(app: &tauri::AppHandle, p: Option<&Pending>) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    match p {
        Some(p) => store.set(PENDING_KEY, serde_json::to_value(p).map_err(|e| e.to_string())?),
        None => {
            store.delete(PENDING_KEY);
        }
    }
    store.save().map_err(|e| e.to_string())
}

/// Start (or restart) a browser sign-in. Returns true once the browser is
/// opened; the frontend button accepts true (Android) or a port (desktop).
#[tauri::command]
pub fn browser_sign_in(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;
    let p = Pending { state: random_state(), expires_at: now_secs() + TTL_SECS };
    save_pending(&app, Some(&p))?; // persisted: the app may be killed while in the browser
    app.opener()
        .open_url(handoff_url(&p.state), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Deep-link entry, for both a warm app and a cold start.
pub fn handle_urls(app: &tauri::AppHandle, urls: &[url::Url]) {
    for raw in urls {
        let Some((ticket, state)) = parse_callback(raw.as_str()) else { continue };
        let pending = load_pending(app);
        let target = match decide(pending.as_ref(), &state, ticket, now_secs()) {
            Outcome::Mismatch => continue,
            Outcome::Accept(t) => {
                let _ = save_pending(app, None);
                ("__clerk_ticket", t)
            }
            Outcome::Expired => {
                let _ = save_pending(app, None);
                ("auth_error", "expired".to_string())
            }
        };
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(cur) = w.url() {
                let _ = w.navigate(app_url(&cur, target.0, &target.1));
            }
        }
    }
}
```

(Check the store plugin's resolved API for `delete`'s return type and whether `store.set` takes `impl Into<String>`; adjust the calls, not the behavior.)

- [ ] **Step 2: Wire it in `lib.rs`**

```rust
mod auth;

use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![auth::browser_sign_in])
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                auth::handle_urls(&handle, &event.urls());
            });
            // Cold start: the callback that launched the app.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                auth::handle_urls(app.handle(), &urls);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chartkar");
}
```

- [ ] **Step 3: Compile and rerun unit tests (ask user first: CPU)**

Run: `cd tauri-android/src-tauri && cargo test --lib auth && cargo tauri android build --debug --apk`
Expected: tests PASS, APK builds.

- [ ] **Step 4: Commit**

```bash
git add tauri-android/src-tauri/src/auth.rs tauri-android/src-tauri/src/lib.rs tauri-android/src-tauri/capabilities/default.json
git commit -m "feat(android): browser sign-in command and App Link callback"
```

---

### Task 11: End-to-end verification on emulator and device (manual)

Needs Tasks 4 to 10 deployed: the frontend changes live on chartkar.app (the user deploys; ask), and a fresh debug APK.

- [ ] **Step 1: Verify App Link association**

Run: `adb shell pm get-app-links app.chartkar.android`
Expected: `chartkar.app: verified`. If not, recheck assetlinks (Task 7 Step 7) and run `adb shell pm verify-app-links --re-verify app.chartkar.android`.

- [ ] **Step 2: Walk the checklist, record pass/fail for each**

1. Fresh install: sign-in screen shows only "Sign in with your browser".
2. Tap it: Chrome opens chartkar.app; sign in with a password saved in Chrome (autofill offered).
3. Handoff page shows "Return to Chartkar"; tap it: the app opens (the same-site case) and is signed in.
4. Killed process: start sign-in, then `adb shell am kill app.chartkar.android` (or force stop from developer options) while in Chrome, tap return: the app cold-starts and completes sign-in.
5. Tap "Sign in" twice, return from the first tab: dropped; return from the second: signed in.
6. Wait 5+ minutes on the handoff page, tap return: the app shows "Sign-in expired, try again."
7. Sign out, sign back in.
8. Back button: settings sheet open closes it; tab overview open closes it; settings over overview closes only settings; nothing open leaves the app.
9. Rotation: portrait and landscape both render; status and nav bar insets respected.
10. Alerts settings: no push toggle; Telegram settings still present.

- [ ] **Step 3: Record results** as a short "E2E results (date)" section at the end of this plan and commit it. Any failure goes back to the owning task.

---

### Task 12: Release build and Play Console readiness

**Files:**
- Modify: `tauri-android/src-tauri/tauri.conf.json` (version)
- Modify: `frontend/public/.well-known/assetlinks.json`
- Modify: `tauri-android/README.md` (release section)

- [ ] **Step 1: Upload keystore (user action).** Ask the user to create it outside the repo:

```bash
keytool -genkey -v -keystore ~/keys/chartkar-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

and to wire it into `gen/android/app/build.gradle.kts` through a `keystore.properties` file that is gitignored (Tauri's Android signing guide shows the exact block). Never commit the keystore or its passwords.

- [ ] **Step 2: Version.** `versionCode` comes from the `version` in `tauri.conf.json` (Tauri derives it); bump `version` for each upload.

- [ ] **Step 3: Build the bundle (ask user first: CPU)**

Run: `cd tauri-android/src-tauri && cargo tauri android build --aab`
Expected: a signed `.aab` under `gen/android/app/build/outputs/bundle/`.

- [ ] **Step 4: Fingerprints.** Add the upload key SHA-256 (`keytool -list -v -keystore ~/keys/chartkar-upload.jks -alias upload`) and, after enrolling in Play App Signing, the app-signing key SHA-256 from Play Console > Setup > App signing, to `sha256_cert_fingerprints` in `assetlinks.json`. Keep the debug one.

- [ ] **Step 5: Play gates checklist (user actions, record status in the README)**
  - Developer account created.
  - Internal testing upload (optional smoke test).
  - Closed test with at least 12 testers for 14 consecutive days (required for personal accounts created after 2023-11-13) before production access.
  - Account deletion: check whether Clerk's `<UserProfile />` in the app exposes "Delete account" (Clerk dashboard > User & authentication > "Allow users to delete their accounts"). If not enabled or not reachable, raise it with the user as a follow-up task; the console needs a deletion URL either way.
  - Data safety form: account data (email), alert and trading settings, broker connections.
  - Privacy policy URL: `https://chartkar.app/privacy/`.

- [ ] **Step 6: Commit**

```bash
git add tauri-android/src-tauri/tauri.conf.json frontend/public/.well-known/assetlinks.json tauri-android/README.md
git commit -m "chore(android): release signing notes and assetlinks fingerprints"
```
