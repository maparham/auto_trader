# Tab Bridge Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generic Chrome extension that lets any page screenshot or focus its own tab while backgrounded, and Chartkar's agent bridge using it so `ui_screenshot` and `ui_focus_tab` no longer need a visible tab.

**Architecture:** The page posts a namespaced `window.postMessage` request; the extension's content script relays it to a background worker, which runs one of two fixed `chrome.debugger` / `chrome.tabs` operations on the sender's own tab and replies. Chartkar's `chart.screenshot` action routes through a small page-side client when the extension answers a `hello`, otherwise it falls back to today's canvas composite. `ui_focus_tab` on the backend tries a new in-page `tab.focus` action before AppleScript.

**Tech Stack:** Chrome Manifest V3, plain ES modules (no bundler), Node's built-in test runner for the extension, Vitest for the frontend, pytest for the backend.

**Spec:** `docs/superpowers/specs/2026-09-19-tab-bridge-extension-design.md`

## Global Constraints

- Extension lives at repo root `extension/`, no build step, no npm deps.
- Protocol namespace string is exactly `"tab-bridge"`; request frames carry `dir: "req"`, replies `dir: "res"`.
- The extension only ever targets `sender.tab.id`; a message can never name a tab.
- Exactly two CDP calls exist in the extension: `chrome.debugger.attach` / `detach` around `Page.captureScreenshot`. No dynamic dispatch into CDP.
- Attach and detach per capture; detach in `finally`.
- Page client timeouts: `hello` 300 ms, other ops 10 s.
- Frontend tests: run ONLY the named test files (never the whole suite). Backend tests: `cd backend && python3 -m pytest <file> -q`.
- No em dashes anywhere (code comments, docs, UI strings).
- Commit to the current branch, staging by explicit path only.

---

### Task 1: Extension op handlers (pure, testable)

**Files:**
- Create: `extension/handlers.js`
- Test: `extension/handlers.test.js`

**Interfaces:**
- Produces: `export const VERSION = "1.0.0"`, `export const OPS = ["screenshot", "focus"]`, `export function makeHandlers(chromeApi)` returning `{ hello(tabId), screenshot(tabId, args), focus(tabId) }`, each `async` returning a result object or throwing `OpError`. `export class OpError extends Error { constructor(code, message) }` with `.code`.

- [ ] **Step 1: Write the failing tests**

```js
// extension/handlers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandlers, OpError, OPS, VERSION } from "./handlers.js";

function fakeChrome({ captureResult = { data: "QUJD" }, attachError = null } = {}) {
  const calls = [];
  const chrome = {
    debugger: {
      attach: async (target, version) => {
        calls.push(["attach", target, version]);
        if (attachError) throw new Error(attachError);
      },
      sendCommand: async (target, method, params) => {
        calls.push(["send", target, method, params]);
        if (method !== "Page.captureScreenshot") throw new Error("unexpected " + method);
        return captureResult;
      },
      detach: async (target) => { calls.push(["detach", target]); },
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 77 }),
      update: async (tabId, props) => { calls.push(["tabs.update", tabId, props]); },
    },
    windows: {
      update: async (windowId, props) => { calls.push(["windows.update", windowId, props]); },
    },
  };
  return { chrome, calls };
}

test("hello reports version and ops", async () => {
  const { chrome } = fakeChrome();
  const h = makeHandlers(chrome);
  assert.deepEqual(await h.hello(5), { version: VERSION, ops: OPS });
});

test("screenshot attaches, captures with a scaled clip, detaches", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  const res = await h.screenshot(5, {
    clip: { x: 10, y: 20, width: 300, height: 200 }, format: "png", scale: 2,
  });
  assert.deepEqual(res, { mime: "image/png", image_base64: "QUJD", width: 300, height: 200 });
  assert.deepEqual(calls[0], ["attach", { tabId: 5 }, "1.3"]);
  assert.equal(calls[1][2], "Page.captureScreenshot");
  assert.deepEqual(calls[1][3], {
    format: "png", fromSurface: true,
    clip: { x: 10, y: 20, width: 300, height: 200, scale: 2 },
  });
  assert.deepEqual(calls[2], ["detach", { tabId: 5 }]);
});

test("screenshot passes jpeg quality and omits clip when absent", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  const res = await h.screenshot(5, { format: "jpeg", quality: 70 });
  assert.equal(res.mime, "image/jpeg");
  assert.deepEqual(calls[1][3], { format: "jpeg", quality: 70, fromSurface: true });
  assert.equal(res.width, null);
});

test("screenshot detaches even when capture throws, as CAPTURE_FAILED", async () => {
  const { chrome, calls } = fakeChrome();
  chrome.debugger.sendCommand = async () => { throw new Error("boom"); };
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, {}), (e) => e instanceof OpError && e.code === "CAPTURE_FAILED");
  assert.deepEqual(calls.at(-1), ["detach", { tabId: 5 }]);
});

test("screenshot reports DEBUGGER_BUSY when attach is refused", async () => {
  const { chrome, calls } = fakeChrome({ attachError: "Another debugger is already attached" });
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, {}), (e) => e instanceof OpError && e.code === "DEBUGGER_BUSY");
  assert.ok(!calls.some((c) => c[0] === "detach"), "no detach after a failed attach");
});

test("screenshot rejects a malformed clip with INVALID_ARGS before attaching", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  await assert.rejects(h.screenshot(5, { clip: { x: 0 } }), (e) => e.code === "INVALID_ARGS");
  await assert.rejects(h.screenshot(5, { format: "gif" }), (e) => e.code === "INVALID_ARGS");
  assert.equal(calls.length, 0);
});

test("focus activates the tab and raises its window", async () => {
  const { chrome, calls } = fakeChrome();
  const h = makeHandlers(chrome);
  assert.deepEqual(await h.focus(5), { focused: true });
  assert.deepEqual(calls, [
    ["tabs.update", 5, { active: true }],
    ["windows.update", 77, { focused: true }],
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test extension/`
Expected: FAIL, cannot find module `./handlers.js`

- [ ] **Step 3: Write the handlers**

```js
// extension/handlers.js
// Pure op handlers for the Tab Bridge extension. Every op acts on the tab
// id the caller passes, which background.js always takes from sender.tab.id,
// so a page can only ever screenshot or focus itself. The `chrome` API is
// injected so these run under node's test runner with a fake.

export const VERSION = "1.0.0";
export const OPS = ["screenshot", "focus"];

const CDP_VERSION = "1.3";
const FORMATS = new Set(["png", "jpeg"]);

export class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function validateScreenshotArgs(args) {
  const { clip, format = "png", quality, scale } = args ?? {};
  if (!FORMATS.has(format)) throw new OpError("INVALID_ARGS", `format must be png or jpeg, got ${format}`);
  if (quality !== undefined && !(isFiniteNum(quality) && quality >= 0 && quality <= 100)) {
    throw new OpError("INVALID_ARGS", "quality must be 0..100");
  }
  if (scale !== undefined && !(isFiniteNum(scale) && scale > 0)) {
    throw new OpError("INVALID_ARGS", "scale must be a positive number");
  }
  if (clip !== undefined) {
    const ok = clip && ["x", "y", "width", "height"].every((k) => isFiniteNum(clip[k]))
      && clip.width > 0 && clip.height > 0;
    if (!ok) throw new OpError("INVALID_ARGS", "clip needs numeric x, y, width > 0, height > 0");
  }
  return { clip, format, quality, scale };
}

export function makeHandlers(chrome) {
  return {
    async hello() {
      return { version: VERSION, ops: OPS };
    },

    async screenshot(tabId, rawArgs) {
      const { clip, format, quality, scale } = validateScreenshotArgs(rawArgs);
      const target = { tabId };
      const params = { format, fromSurface: true };
      if (quality !== undefined) params.quality = quality;
      if (clip) params.clip = { ...clip, scale: scale ?? 1 };

      try {
        await chrome.debugger.attach(target, CDP_VERSION);
      } catch (e) {
        throw new OpError("DEBUGGER_BUSY", `cannot attach debugger to this tab (DevTools open?): ${e?.message ?? e}`);
      }
      try {
        const res = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
        return {
          mime: format === "png" ? "image/png" : "image/jpeg",
          image_base64: res.data,
          width: clip ? clip.width : null,
          height: clip ? clip.height : null,
        };
      } catch (e) {
        throw new OpError("CAPTURE_FAILED", `Page.captureScreenshot failed: ${e?.message ?? e}`);
      } finally {
        await chrome.debugger.detach(target).catch(() => {});
      }
    },

    async focus(tabId) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { focused: true };
    },
  };
}
```

Note: the fake's `detach` returns a promise, matching MV3's promise-returning `chrome.debugger.detach`; `.catch` on it is safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/`
Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add extension/handlers.js extension/handlers.test.js
git commit -m "feat(extension): Tab Bridge op handlers (screenshot via CDP, focus) with node tests"
```

---

### Task 2: Extension shell (manifest, content script, background worker, README)

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/content.js`
- Create: `extension/background.js`
- Create: `extension/README.md`

**Interfaces:**
- Consumes: `makeHandlers`, `OpError`, `OPS` from Task 1.
- Produces: the page-facing protocol. Page posts `{ns:"tab-bridge", dir:"req", id, op, args?}` to its own window; receives `{ns:"tab-bridge", dir:"res", id, ok:true, result}` or `{..., ok:false, error:{code,message}}`.

No unit tests for this task: these three files are Chrome-API glue with no logic beyond forwarding. Verification is the manual install check in Step 5.

- [ ] **Step 1: Write the manifest**

```json
{
  "manifest_version": 3,
  "name": "Tab Bridge",
  "version": "1.0.0",
  "description": "Lets a web page screenshot or focus its own tab, even while backgrounded. Generic; any page that speaks the tab-bridge postMessage protocol can use it.",
  "permissions": ["debugger", "tabs"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ]
}
```

- [ ] **Step 2: Write the content script**

```js
// extension/content.js
// Relay between the page and the background worker. Accepts only requests
// posted by this same window (never an iframe or a cross-window opener), and
// only frames carrying our namespace, so unrelated postMessage traffic is
// ignored. Injects nothing into the page.
const NS = "tab-bridge";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const f = event.data;
  if (!f || f.ns !== NS || f.dir !== "req" || typeof f.id !== "string") return;
  chrome.runtime.sendMessage({ op: f.op, args: f.args ?? {} }, (reply) => {
    const err = chrome.runtime.lastError;
    const res = err
      ? { ok: false, error: { code: "EXTENSION_ERROR", message: err.message } }
      : reply;
    window.postMessage({ ns: NS, dir: "res", id: f.id, ...res }, "*");
  });
});
```

- [ ] **Step 3: Write the background worker**

```js
// extension/background.js
// Dispatches ops to handlers.js. The tab acted on is ALWAYS sender.tab.id,
// so a page can only affect itself. Ops for one tab are serialised: a
// second debugger attach on the same tab would fail.
import { makeHandlers, OpError, OPS } from "./handlers.js";

const handlers = makeHandlers(chrome);
const queues = new Map(); // tabId -> promise chain

function serialised(tabId, fn) {
  const prev = queues.get(tabId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: { code: "NO_TAB", message: "message did not come from a tab" } });
    return false;
  }
  const op = msg?.op;
  const known = op === "hello" || OPS.includes(op);
  if (!known) {
    sendResponse({ ok: false, error: { code: "UNKNOWN_OP", message: `unknown op: ${String(op)}` } });
    return false;
  }
  serialised(tabId, () => handlers[op](tabId, msg.args ?? {}))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({
      ok: false,
      error: e instanceof OpError
        ? { code: e.code, message: e.message }
        : { code: "EXTENSION_ERROR", message: String(e?.message ?? e) },
    }));
  return true; // keep the channel open for the async reply
});
```

- [ ] **Step 4: Write the README**

```markdown
# Tab Bridge

A tiny Chrome extension that lets a web page screenshot or focus **its own
tab**, even while the tab is in the background. Page JavaScript cannot do
either: Chrome pauses requestAnimationFrame in hidden tabs, so canvases stop
painting, and pages may not steal focus. The extension can, via
`chrome.debugger` and `chrome.tabs`.

It is generic. Any page that speaks the protocol below can use it. Chartkar
is the first consumer (`frontend/src/lib/tabBridge.ts`).

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. **Load unpacked**, pick this `extension/` folder.
3. Reload the app's tab.

While a screenshot is being taken Chrome shows its yellow "Tab Bridge started
debugging this browser" bar on the tab. It disappears when the capture ends.
Launch Chrome with `--silent-debugger-extension-api` to suppress it. A tab
with DevTools open refuses the attach (`DEBUGGER_BUSY`); close DevTools.

## Protocol

Post to your own window, listen for the reply with the same `id`:

    window.postMessage({ ns: "tab-bridge", dir: "req", id, op, args }, "*")
    // reply: { ns: "tab-bridge", dir: "res", id, ok: true, result }
    //     or { ns: "tab-bridge", dir: "res", id, ok: false, error: { code, message } }

| op | args | result |
|----|------|--------|
| `hello` | none | `{ version, ops }` (use with a short timeout to detect the extension) |
| `screenshot` | `clip?: {x, y, width, height}` (CSS px, page coords), `scale?` (device pixel ratio), `format?: "png" \| "jpeg"`, `quality?: 0..100` | `{ mime, image_base64, width, height }` |
| `focus` | none | `{ focused: true }` |

Error codes: `UNKNOWN_OP`, `INVALID_ARGS`, `DEBUGGER_BUSY`, `CAPTURE_FAILED`,
`EXTENSION_ERROR`.

Only the requesting tab is ever targeted. No cross-tab operations exist.

## Tests

    node --test extension/
```

- [ ] **Step 5: Manual install check**

Load the unpacked extension per the README. Open any http(s) page, run in DevTools console:

```js
window.addEventListener("message", (e) => e.data?.dir === "res" && console.log(e.data));
window.postMessage({ ns: "tab-bridge", dir: "req", id: "1", op: "hello" }, "*");
```

Expected: a logged `{ok: true, result: {version: "1.0.0", ops: [...]}}`. Then close DevTools (it blocks the attach), and from another tab's console you cannot test the first tab, which is the point; instead re-open the page's console only to POST the request, close DevTools within a second, and confirm the reply logs on re-open, or simply proceed to Task 4's probe, which exercises it end to end.

- [ ] **Step 6: Commit**

```bash
git add extension/manifest.json extension/content.js extension/background.js extension/README.md
git commit -m "feat(extension): Tab Bridge manifest, content relay, background dispatcher, README"
```

---

### Task 3: Page-side client `tabBridge.ts`

**Files:**
- Create: `frontend/src/lib/tabBridge.ts`
- Test: `frontend/src/lib/tabBridge.test.ts`

**Interfaces:**
- Produces:
  - `probeTabBridge(): Promise<{version: string; ops: string[]} | null>` (cached when found; re-probed when the last answer was null).
  - `tabBridgeScreenshot(args: {clip?: {x:number;y:number;width:number;height:number}; scale?: number; format?: "png"|"jpeg"; quality?: number}): Promise<{mime: string; image_base64: string; width: number|null; height: number|null}>`
  - `tabBridgeFocus(): Promise<{focused: true}>`
  - `class TabBridgeError extends Error { code: string }`
  - `resetTabBridgeForTest(): void`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/tabBridge.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  probeTabBridge, tabBridgeScreenshot, tabBridgeFocus, TabBridgeError, resetTabBridgeForTest,
} from "./tabBridge";

type Frame = { ns: string; dir: string; id: string; op?: string; args?: unknown };

// A fake extension: answers every "req" frame posted on this window.
function installFakeExtension(answer: (f: Frame) => object | null) {
  const handler = (e: MessageEvent) => {
    const f = e.data as Frame;
    if (!f || f.ns !== "tab-bridge" || f.dir !== "req") return;
    const res = answer(f);
    if (res) window.postMessage({ ns: "tab-bridge", dir: "res", id: f.id, ...res }, "*");
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

describe("tabBridge", () => {
  let uninstall: (() => void) | null = null;
  beforeEach(() => { resetTabBridgeForTest(); vi.useFakeTimers(); });
  afterEach(() => { uninstall?.(); uninstall = null; vi.useRealTimers(); });

  it("probe resolves to the hello result and caches it", async () => {
    let hellos = 0;
    uninstall = installFakeExtension((f) => {
      if (f.op === "hello") { hellos++; return { ok: true, result: { version: "1.0.0", ops: ["screenshot", "focus"] } }; }
      return null;
    });
    const p = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ version: "1.0.0", ops: ["screenshot", "focus"] });
    const again = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await again).toEqual({ version: "1.0.0", ops: ["screenshot", "focus"] });
    expect(hellos).toBe(1);
  });

  it("probe resolves null after 300ms with no extension, and re-probes next time", async () => {
    const p = probeTabBridge();
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBeNull();
    uninstall = installFakeExtension(() => ({ ok: true, result: { version: "1.0.0", ops: [] } }));
    const p2 = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await p2).toEqual({ version: "1.0.0", ops: [] });
  });

  it("screenshot forwards args and resolves the matching reply only", async () => {
    let seen: Frame | null = null;
    uninstall = installFakeExtension((f) => {
      if (f.op !== "screenshot") return null;
      seen = f;
      // A stray reply with another id must be ignored:
      window.postMessage({ ns: "tab-bridge", dir: "res", id: "nope", ok: true, result: { mime: "x" } }, "*");
      return { ok: true, result: { mime: "image/png", image_base64: "QUJD", width: 10, height: 5 } };
    });
    const p = tabBridgeScreenshot({ clip: { x: 1, y: 2, width: 10, height: 5 }, scale: 2, format: "png" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ mime: "image/png", image_base64: "QUJD", width: 10, height: 5 });
    expect(seen!.args).toEqual({ clip: { x: 1, y: 2, width: 10, height: 5 }, scale: 2, format: "png" });
  });

  it("screenshot rejects with the extension's error code", async () => {
    uninstall = installFakeExtension(() => ({ ok: false, error: { code: "DEBUGGER_BUSY", message: "devtools open" } }));
    const p = tabBridgeScreenshot({});
    await vi.runAllTimersAsync();
    await expect(p).rejects.toMatchObject({ code: "DEBUGGER_BUSY" });
    await expect(p).rejects.toBeInstanceOf(TabBridgeError);
  });

  it("screenshot times out after 10s as EXTENSION_TIMEOUT", async () => {
    const p = tabBridgeScreenshot({});
    const assertion = expect(p).rejects.toMatchObject({ code: "EXTENSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("ignores frames with the wrong namespace or direction", async () => {
    uninstall = installFakeExtension((f) => {
      window.postMessage({ ns: "other", dir: "res", id: f.id, ok: true, result: { focused: true } }, "*");
      window.postMessage({ ns: "tab-bridge", dir: "req", id: f.id, ok: true, result: { focused: true } }, "*");
      return null;
    });
    const p = tabBridgeFocus();
    const assertion = expect(p).rejects.toMatchObject({ code: "EXTENSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tabBridge.test.ts`
Expected: FAIL, cannot resolve `./tabBridge`

- [ ] **Step 3: Write the client**

```ts
// frontend/src/lib/tabBridge.ts
// Page-side client for the Tab Bridge Chrome extension (extension/ at the
// repo root). The extension lets this page screenshot or focus its own tab
// while backgrounded, which page JS cannot do (rAF is paused in hidden tabs,
// and pages may not steal focus). Frames travel over window.postMessage on
// this window; the extension's content script relays them. Protocol and
// error codes: extension/README.md.

const NS = "tab-bridge";
const HELLO_TIMEOUT_MS = 300;
const OP_TIMEOUT_MS = 10_000;

export class TabBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TabBridgeHello { version: string; ops: string[] }

export interface ScreenshotArgs {
  clip?: { x: number; y: number; width: number; height: number };
  scale?: number;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface ScreenshotResult {
  mime: string; image_base64: string; width: number | null; height: number | null;
}

interface ResFrame {
  ns: string; dir: string; id: string; ok: boolean;
  result?: unknown; error?: { code: string; message: string };
}

let seq = 0;
let hello: TabBridgeHello | null = null;

export function resetTabBridgeForTest(): void {
  hello = null;
  seq = 0;
}

function request<T>(op: string, args: object, timeoutMs: number): Promise<T> {
  if (typeof window === "undefined") {
    return Promise.reject(new TabBridgeError("NO_WINDOW", "no window"));
  }
  const id = `tb-${Date.now()}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      const f = e.data as ResFrame | null;
      if (!f || f.ns !== NS || f.dir !== "res" || f.id !== id) return;
      if (f.ok) done(() => resolve(f.result as T));
      else done(() => reject(new TabBridgeError(f.error?.code ?? "EXTENSION_ERROR", f.error?.message ?? "extension error")));
    };
    const timer = setTimeout(
      () => done(() => reject(new TabBridgeError("EXTENSION_TIMEOUT", `${op}: no reply from the Tab Bridge extension within ${timeoutMs}ms`))),
      timeoutMs,
    );
    window.addEventListener("message", onMessage);
    window.postMessage({ ns: NS, dir: "req", id, op, args }, "*");
  });
}

/** Detects the extension. A found answer is cached for the page's life; a
 * null answer is re-probed next call (the user may install it later). */
export async function probeTabBridge(): Promise<TabBridgeHello | null> {
  if (hello) return hello;
  try {
    hello = await request<TabBridgeHello>("hello", {}, HELLO_TIMEOUT_MS);
  } catch {
    hello = null;
  }
  return hello;
}

export function tabBridgeScreenshot(args: ScreenshotArgs): Promise<ScreenshotResult> {
  return request<ScreenshotResult>("screenshot", args, OP_TIMEOUT_MS);
}

export function tabBridgeFocus(): Promise<{ focused: true }> {
  return request<{ focused: true }>("focus", {}, OP_TIMEOUT_MS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tabBridge.test.ts`
Expected: 6 passing. If jsdom's `MessageEvent.source` is null for `window.postMessage`, the `e.source !== window` guard will swallow everything; in that case change the guard to `if (e.source !== null && e.source !== window) return;` and keep the wrong-namespace test as the isolation proof.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/tabBridge.ts frontend/src/lib/tabBridge.test.ts
git commit -m "feat(agent): page-side client for the Tab Bridge extension"
```

---

### Task 4: `chart.screenshot` via the extension, plus `tab.focus` action

**Files:**
- Modify: `frontend/src/agent/actions/chart.ts` (the `chart.screenshot` handler, around lines 89-131; add `tab.focus` after it)
- Test: `frontend/src/agent/actions/chart.test.ts`

**Interfaces:**
- Consumes: `probeTabBridge`, `tabBridgeScreenshot`, `tabBridgeFocus`, `TabBridgeError` from Task 3. `focusedChart()` already returns `chart` (klinecharts `Chart`, which has `getDom(): HTMLElement`).
- Produces: `chart.screenshot` result shape unchanged (`{epic, cellId, resolution, mime, image_base64}`) plus `via: "extension" | "canvas"`. New action `tab.focus` (kind `write`, no params) returning `{focused: true}`; errors `NO_EXTENSION` when the probe is null.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("chart.screenshot", ...)` block (and a new describe) in `chart.test.ts`. The existing tests mock nothing about the extension, so add a module mock at the top of the file, after the existing imports:

```ts
import { vi } from "vitest";
import * as tabBridge from "../../lib/tabBridge";

vi.mock("../../lib/tabBridge", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/tabBridge")>();
  return {
    ...actual,
    probeTabBridge: vi.fn(async () => null),
    tabBridgeScreenshot: vi.fn(),
    tabBridgeFocus: vi.fn(),
  };
});
```

Then the tests:

```ts
  it("uses the Tab Bridge extension when present, clipped to the chart container", async () => {
    vi.mocked(tabBridge.probeTabBridge).mockResolvedValueOnce({ version: "1.0.0", ops: ["screenshot", "focus"] });
    vi.mocked(tabBridge.tabBridgeScreenshot).mockResolvedValueOnce({
      mime: "image/png", image_base64: "QUJD", width: 640, height: 400,
    });
    const chart = Object.assign(fakeChart(), {
      getDom: () => ({ getBoundingClientRect: () => ({ x: 12, y: 34, width: 640, height: 400 }) }),
      getConvertPictureUrl: () => { throw new Error("canvas path must not run when the extension answers"); },
    });
    provide(chart as never);
    const res = await invokeAction("chart.screenshot", {}, ctx) as { image_base64: string; via: string };
    expect(res.image_base64).toBe("QUJD");
    expect(res.via).toBe("extension");
    expect(vi.mocked(tabBridge.tabBridgeScreenshot).mock.calls[0][0]).toMatchObject({
      clip: { x: 12, y: 34, width: 640, height: 400 }, format: "png",
    });
  });

  it("works with the extension even when the tab is backgrounded", async () => {
    vi.mocked(tabBridge.probeTabBridge).mockResolvedValueOnce({ version: "1.0.0", ops: ["screenshot", "focus"] });
    vi.mocked(tabBridge.tabBridgeScreenshot).mockResolvedValueOnce({
      mime: "image/png", image_base64: "QUJD", width: 1, height: 1,
    });
    const chart = Object.assign(fakeChart(), {
      getDom: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) }),
    });
    provide(chart as never);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      const res = await invokeAction("chart.screenshot", {}, ctx) as { via: string };
      expect(res.via).toBe("extension");
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it("surfaces an extension capture failure as SCREENSHOT_FAILED, without a canvas fallback", async () => {
    vi.mocked(tabBridge.probeTabBridge).mockResolvedValueOnce({ version: "1.0.0", ops: ["screenshot", "focus"] });
    vi.mocked(tabBridge.tabBridgeScreenshot).mockRejectedValueOnce(new tabBridge.TabBridgeError("DEBUGGER_BUSY", "devtools open"));
    const chart = Object.assign(fakeChart(), {
      getDom: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) }),
      getConvertPictureUrl: () => { throw new Error("must not fall back to canvas"); },
    });
    provide(chart as never);
    await expect(invokeAction("chart.screenshot", {}, ctx)).rejects.toMatchObject({
      code: "SCREENSHOT_FAILED", message: expect.stringMatching(/DEBUGGER_BUSY.*devtools open/),
    });
  });

  it("hidden-tab error names the extension when it is absent", async () => {
    const chart = Object.assign(fakeChart(), {
      getConvertPictureUrl: () => { throw new Error("unreachable"); },
    });
    provide(chart as never);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      await expect(invokeAction("chart.screenshot", {}, ctx)).rejects.toThrow(/Tab Bridge extension/);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });
```

And a new block:

```ts
describe("tab.focus", () => {
  beforeEach(() => { clearRegistryForTest(); registerChartActions(); });

  it("is a write action that asks the extension to focus the tab", async () => {
    vi.mocked(tabBridge.probeTabBridge).mockResolvedValueOnce({ version: "1.0.0", ops: ["screenshot", "focus"] });
    vi.mocked(tabBridge.tabBridgeFocus).mockResolvedValueOnce({ focused: true });
    expect(listActions().find((a) => a.name === "tab.focus")?.kind).toBe("write");
    expect(await invokeAction("tab.focus", {}, ctx)).toEqual({ focused: true });
  });

  it("errors NO_EXTENSION when the extension is absent", async () => {
    await expect(invokeAction("tab.focus", {}, ctx)).rejects.toMatchObject({ code: "NO_EXTENSION" });
  });
});
```

Check how the existing `describe("chart.screenshot")` block sets up (`beforeEach` with `clearRegistryForTest(); registerChartActions();`) and mirror it. The existing "errors instead of returning a blank PNG when the tab is backgrounded" test keeps passing unchanged since the default probe mock returns null.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts`
Expected: the 6 new tests FAIL (`via` undefined, `tab.focus` unknown action, message lacks "Tab Bridge"); existing ones pass.

- [ ] **Step 3: Implement**

In `chart.ts`, add the import:

```ts
import { probeTabBridge, tabBridgeScreenshot, tabBridgeFocus, TabBridgeError } from "../../lib/tabBridge";
```

Replace the `chart.screenshot` handler body. Keep `chartBackgroundColor`, `compositeChartPng`, `MAX_B64` and the `grab` helper exactly as they are; only the control flow changes:

```ts
    handler: async () => {
      const { chart, epic, cellId, resolution } = focusedChart();

      // Preferred path: the Tab Bridge extension (extension/ at the repo
      // root) captures the tab through Chrome's debugger, which forces a
      // fresh frame even while the tab is backgrounded. Clipped to the chart
      // container so the agent sees the chart, not the whole app.
      if (await probeTabBridge()) {
        const r = chart.getDom().getBoundingClientRect();
        const clip = {
          x: r.x + (window.scrollX || 0), y: r.y + (window.scrollY || 0),
          width: r.width, height: r.height,
        };
        const scale = window.devicePixelRatio || 1;
        try {
          let shot = await tabBridgeScreenshot({ clip, scale, format: "png" });
          if (shot.image_base64.length > MAX_B64) {
            shot = await tabBridgeScreenshot({ clip, scale, format: "jpeg", quality: 80 });
          }
          return { epic, cellId, resolution, mime: shot.mime, image_base64: shot.image_base64, via: "extension" };
        } catch (e) {
          const code = e instanceof TabBridgeError ? e.code : "EXTENSION_ERROR";
          throw new ActionError("SCREENSHOT_FAILED", `screenshot via extension failed: ${code}: ${(e as Error).message}`);
        }
      }

      // Fallback: copy the pane canvases the chart already painted. See the
      // long note below on why a backgrounded tab cannot do this.
      if (typeof document !== "undefined" && document.hidden) {
        throw new ActionError(
          "TAB_HIDDEN",
          "the app's browser tab is backgrounded and the Tab Bridge extension is not installed; install it (extension/README.md) or focus the tab and retry",
        );
      }
      // ... existing bg / grab / try-catch unchanged, but add via: "canvas"
      // to the returned object.
    },
```

Move the existing multi-paragraph comment about hidden-tab canvases so it sits above the `document.hidden` check (it still applies to the fallback). Update the action `description` string: replace the trailing "Fails with TAB_HIDDEN ... retry." sentence with:

```
"With the Tab Bridge extension installed (extension/README.md) this works while the tab is backgrounded; without it, fails with TAB_HIDDEN when the tab is hidden."
```

Add the `tab.focus` action right after `chart.screenshot`:

```ts
  registerAction({
    name: "tab.focus",
    description:
      "Bring this app's browser tab to the front via the Tab Bridge extension. Errors NO_EXTENSION when the extension is not installed (ui_focus_tab then falls back to AppleScript on macOS).",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => {
      if (!(await probeTabBridge())) {
        throw new ActionError("NO_EXTENSION", "Tab Bridge extension not installed (see extension/README.md)");
      }
      try {
        return await tabBridgeFocus();
      } catch (e) {
        const code = e instanceof TabBridgeError ? e.code : "EXTENSION_ERROR";
        throw new ActionError("FOCUS_FAILED", `${code}: ${(e as Error).message}`);
      }
    },
  });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/agent/actions/chart.test.ts src/agent/registry.test.ts`
Expected: all pass.
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "chart.ts|tabBridge.ts"`
Expected: no lines (per the project's typecheck convention, judge by per-file parity, not a clean exit).

- [ ] **Step 5: Manual end-to-end probe**

With the extension loaded and the app open at http://localhost:5173, switch to another tab, then:

```bash
cd backend && python3 -m scripts.agent_bridge_probe --screenshot /tmp/hidden.png
```

Expected: a non-blank PNG of the focused chart. Open it and confirm candles are visible.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/agent/actions/chart.ts frontend/src/agent/actions/chart.test.ts
git commit -m "feat(agent): chart.screenshot captures through the Tab Bridge extension; add tab.focus"
```

---

### Task 5: `ui_focus_tab` prefers the in-page `tab.focus`

**Files:**
- Modify: `backend/auto_trader/api/mcp_server.py` (`ui_focus_tab`, around line 418)
- Test: `backend/tests/test_mcp_browser_tabs.py`

**Interfaces:**
- Consumes: `HUB.request("invoke", {"action": "tab.focus", "args": {}}, session_id=None)`; the tab answers `{"focused": True}` or raises `ActionFailedError(code="NO_EXTENSION", ...)`; `NoTabError` when no tab is connected.
- Produces: `ui_focus_tab()` returns `{"focused": "extension"}` on the extension path; unchanged `{"focused": url}` on the AppleScript path.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_mcp_browser_tabs.py`:

```python
from auto_trader.api.agent_bridge import ActionFailedError, NoTabError


class _Hub:
    def __init__(self, result=None, exc=None):
        self.result, self.exc, self.calls = result, exc, []

    async def request(self, kind, payload, session_id=None):
        self.calls.append((kind, payload))
        if self.exc:
            raise self.exc
        return self.result


@pytest.mark.anyio
async def test_focus_tab_prefers_the_extension(monkeypatch):
    hub = _Hub(result={"focused": True})
    monkeypatch.setattr(mcp_server, "HUB", hub)
    run = fake_osascript("FOCUSED:should-not-run")
    monkeypatch.setattr(mcp_server, "_osascript", run)
    res = await mcp_server.ui_focus_tab()
    assert res == {"focused": "extension"}
    assert hub.calls == [("invoke", {"action": "tab.focus", "args": {}})]
    assert run.calls == []


@pytest.mark.anyio
async def test_focus_tab_falls_back_to_applescript_without_extension(monkeypatch):
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=ActionFailedError("NO_EXTENSION", "not installed")))
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript(f"FOCUSED:{URL}/"))
    res = await mcp_server.ui_focus_tab()
    assert res == {"focused": f"{URL}/"}


@pytest.mark.anyio
async def test_focus_tab_falls_back_to_applescript_with_no_tab(monkeypatch):
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=NoTabError()))
    monkeypatch.setattr(mcp_server, "_osascript", fake_osascript("NONE"))
    with pytest.raises(RuntimeError, match="ui_open_tab"):
        await mcp_server.ui_focus_tab()


@pytest.mark.anyio
async def test_focus_tab_off_macos_without_extension_names_it(monkeypatch):
    monkeypatch.setattr(mcp_server, "_IS_MACOS", False)
    monkeypatch.setattr(mcp_server, "HUB", _Hub(exc=ActionFailedError("NO_EXTENSION", "not installed")))
    with pytest.raises(RuntimeError, match="Tab Bridge extension"):
        await mcp_server.ui_focus_tab()
```

The existing `test_focus_tab_found` and `test_focus_tab_missing_points_at_open` do not patch `HUB`, so they will hit the real (empty) hub, get `NoTabError`, and fall through to AppleScript exactly as before. They should keep passing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_mcp_browser_tabs.py -q`
Expected: the 4 new tests FAIL (extension path not taken, wrong messages).

- [ ] **Step 3: Implement**

Replace `ui_focus_tab`:

```python
@mcp.tool()
async def ui_focus_tab() -> dict:
    """Bring the Chartkar browser tab to the front. Tries the connected tab's
    tab.focus action first (needs the Tab Bridge extension, extension/README.md,
    works on any OS), then falls back to AppleScript on macOS local dev.
    Errors if no tab is open; ui_open_tab creates one."""
    try:
        await HUB.request("invoke", {"action": "tab.focus", "args": {}})
        return {"focused": "extension"}
    except ActionFailedError as e:
        if e.code != "NO_EXTENSION":
            raise _friendly(e) from e
    except (NoTabError, TabTimeoutError):
        pass
    if not _IS_MACOS:
        raise RuntimeError(
            "focusing the tab needs the Tab Bridge extension off macOS "
            "(extension/README.md); AppleScript fallback is macOS-only"
        )
    _require_local_macos()
    result = await _osascript(_focus_script(_frontend_url()))
    if result.startswith("FOCUSED:"):
        return {"focused": result[len("FOCUSED:"):]}
    raise RuntimeError("no Chartkar tab open in Chrome (ui_open_tab creates one)")
```

`ActionFailedError`, `NoTabError`, `TabTimeoutError` are already imported at the top of `mcp_server.py` (they are used by `_friendly` and the `ui_*` tools); verify with `grep -n "^from .agent_bridge import" backend/auto_trader/api/mcp_server.py` and add any missing name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_mcp_browser_tabs.py tests/test_mcp_screenshot.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/tests/test_mcp_browser_tabs.py
git commit -m "feat(mcp): ui_focus_tab uses the Tab Bridge extension before AppleScript"
```

---

### Task 6: Docs

**Files:**
- Modify: `CLAUDE.md` (Agent UI Bridge section, the "Browser tab control" paragraph and the "How to analyse a chart visually" recipe step 3)

- [ ] **Step 1: Update CLAUDE.md**

Insert after the "Browser tab control (macOS local dev only; ...)" paragraph:

```markdown
Tab Bridge extension (`extension/` at the repo root, generic, unpacked
install per `extension/README.md`): a page can screenshot or focus its own
tab through `chrome.debugger` / `chrome.tabs`, which works while the tab is
backgrounded. `chart.screenshot` uses it when its `hello` probe answers
(result carries `via: "extension"`), clipped to the chart container, and
falls back to the canvas composite otherwise (`via: "canvas"`, TAB_HIDDEN
when hidden). `ui_focus_tab` tries the in-page `tab.focus` action first, so
it works on any OS with the extension, and only then AppleScript. The
extension is not Chartkar-specific: it answers a namespaced `postMessage`
protocol on any http(s) origin and never targets a tab other than the
requester's.
```

In the "How to analyse a chart visually" recipe, step 3, replace the sentence starting "`ui_screenshot` fails with TAB_HIDDEN" with:

```
`ui_screenshot` works with the tab backgrounded when the Tab Bridge
extension is installed; without it, it fails with TAB_HIDDEN, so call
`ui_focus_tab` and retry.
```

Also add `tab.focus` to the registered-actions list in the same section ("and app shell (`market.select`, `tab.list`, `tab.focus`, `panel.backtest.open`)") and bump the count from 27 to 28.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Tab Bridge extension in the agent bridge notes"
```

---

## Self-review

- **Spec coverage:** extension parts (Tasks 1, 2), page client (3), `chart.screenshot` + `tab.focus` (4), `ui_focus_tab` fallback (5), README and CLAUDE.md (2, 6), security rules (Global Constraints, Task 2 background). Error codes from the spec all appear: `UNKNOWN_OP`, `DEBUGGER_BUSY`, `CAPTURE_FAILED`, `INVALID_ARGS` in Task 1/2, `EXTENSION_TIMEOUT` in Task 3, `SCREENSHOT_FAILED`/`NO_EXTENSION` in Task 4.
- **Placeholders:** none; every step carries its code.
- **Type consistency:** `ScreenshotResult` (Task 3) matches the handler result (Task 1: `mime, image_base64, width, height`). `tab.focus` error code `NO_EXTENSION` is what Task 5 checks. `via` field added in Task 4 only, and documented in Task 6.
