# Per-Browser-Tab Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each browser tab independently selects its broker/account and named layout (the active chart tab already is per-tab), so multiple app tabs no longer interfere; saved data stays one shared, backend-synced store.

**Architecture:** The two remaining shared selections (`activeAccount`, `activeLayoutId`) move to a "sessionStorage first, localStorage as last-used seed" pattern, matching the existing `ACTIVE_TAB_SESSION_KEY`. The working chart-tab set is ALREADY per-layout (the autosave effect writes to the named layout body or device-local scratch), and `onBackendPush` already gates on "does the resolved workspace differ from what's on screen", which becomes per-tab automatically once the selections are session-scoped. The legacy unused `root("tabs")` working-set key is deleted (code + stored keys).

**Tech Stack:** React + TypeScript (frontend/src), vitest with an in-memory storage shim (node env, no jsdom for persist tests).

**Spec:** `docs/superpowers/specs/2026-07-16-per-browser-tab-sessions-design.md`. Deviation from spec, discovered during code reading: spec section 2 proposed new `layoutTabs.<id>` keys plus a migration. Not needed — the autosave effect (`App.tsx` "Persist the workspace" effect) already writes the working set into the layout body / scratch, and `loadTabs`/`saveTabs`/`root("tabs")` are dead code (only referenced by their own tests). Section 2 therefore reduces to deleting that dead code and pruning stale stored keys. Spec section 3 (push relevance gate) requires no code change for the same reason; it is covered by the verification task.

## Global Constraints

- Work directly on `main`; commit after each task. No branches.
- No backward-compat/dual-read paths: legacy-key cleanup deletes, it does not keep a fallback reader.
- All persist tests run in vitest node env with `installMemStorage()`; direct `sessionStorage` access in library code must be try/catch-guarded like existing `localStorage` access in `core.ts`.
- Frontend commands run from `frontend/`: `npx vitest run <file>` for tests, `npx tsc -b --noEmit 2>/dev/null || npx tsc --noEmit` for typecheck (use whichever the repo's `package.json` `typecheck`/`build` script actually runs; `npm run build` is the fallback).
- Do not kill running HMR dev servers.

---

### Task 1: Session storage primitives (`sessionGet`/`sessionSet`/`sessionRemove`) + test shim

**Files:**
- Modify: `frontend/src/lib/testMemStorage.ts`
- Modify: `frontend/src/lib/persist/core.ts` (after the `saveLocal`/`removeLocal` block, ~line 319)
- Test: `frontend/src/lib/persist/core.test.ts`

**Interfaces:**
- Produces: `sessionGet(key: string): string | null`, `sessionSet(key: string, value: string): void`, `sessionRemove(key: string): void` exported from `lib/persist/core.ts` (re-exported by the `lib/persist.ts` barrel via `export *`). Raw-string API: callers JSON-encode/decode themselves.
- Produces: `installMemStorage()` now also installs an in-memory `sessionStorage` (separate instance from `localStorage`).

- [ ] **Step 1: Install sessionStorage in the test shim**

In `frontend/src/lib/testMemStorage.ts`, replace the `installMemStorage` function with:

```ts
export function installMemStorage(): MemStorage {
  const storage = new MemStorage();
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;
  // Session-scoped selections (activeAccount / activeLayoutId) read sessionStorage
  // first; give tests a separate in-memory instance so the two layers are distinct.
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage =
    new MemStorage();
  return storage;
}
```

- [ ] **Step 2: Write the failing tests**

In `frontend/src/lib/persist/core.test.ts`, add (match the file's existing import style — it already imports from `"./core"` after an `installMemStorage()` call; add `sessionStorage.clear()` to its `beforeEach` if one exists, otherwise inside the new describe):

```ts
describe("session storage primitives", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("sessionGet/sessionSet round-trip raw strings in sessionStorage only", () => {
    expect(sessionGet("k")).toBeNull();
    sessionSet("k", "v1");
    expect(sessionGet("k")).toBe("v1");
    expect(localStorage.getItem("k")).toBeNull(); // never touches localStorage
  });

  it("sessionRemove deletes the key", () => {
    sessionSet("k", "v1");
    sessionRemove("k");
    expect(sessionGet("k")).toBeNull();
  });
});
```

Add `sessionGet, sessionSet, sessionRemove` to the test file's import from `"./core"` (or `P.` accesses if it uses a namespace import).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/persist/core.test.ts`
Expected: FAIL — `sessionGet` is not exported.

- [ ] **Step 4: Implement the primitives**

In `frontend/src/lib/persist/core.ts`, after the `removeLocal` function (~line 319), add:

```ts
// --- per-browser-tab session values -------------------------------------------
//
// The "what am I looking at" selections (active account, active layout) are
// PER BROWSER TAB: sessionStorage is this tab's truth, and callers keep a
// localStorage copy as the last-used seed for future tabs (same pattern as
// App.tsx's ACTIVE_TAB_SESSION_KEY). Raw-string API — callers JSON-encode.
// Guarded like the localStorage helpers so the module stays usable in node.
export function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
export function sessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/persist/core.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/testMemStorage.ts frontend/src/lib/persist/core.ts frontend/src/lib/persist/core.test.ts
git commit -m "feat(persist): session storage primitives for per-browser-tab selections"
```

---

### Task 2: Per-browser-tab active account/broker

**Files:**
- Modify: `frontend/src/lib/persist/core.ts:35-44` (`brokerFromActiveAccount`)
- Modify: `frontend/src/App.tsx:387-394` (activeAccount state init) and `frontend/src/App.tsx:461-475` (persist effect)
- Test: `frontend/src/lib/persist/core.test.ts`

**Interfaces:**
- Consumes: `sessionGet` from Task 1.
- Produces: behavior only — no new exports. The contract other code relies on: `sessionStorage["activeAccount"]` is this tab's account; `localStorage["activeAccount"]` is the last-used seed; `getPersistBroker()` initializes from session first.

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/persist/core.test.ts` add. Note: `persistBroker` is lazily cached module state, so the test must reset modules and re-import to exercise the init path:

```ts
describe("persistBroker init reads the per-tab session account first", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("session activeAccount wins over the localStorage seed", async () => {
    localStorage.setItem("activeAccount", "capital:paper");
    sessionStorage.setItem("activeAccount", "ig-demo:paper");
    vi.resetModules();
    const core = await import("./core");
    expect(core.getPersistBroker()).toBe("ig-demo");
  });

  it("falls back to the localStorage seed, then the default", async () => {
    localStorage.setItem("activeAccount", "ig-live:live");
    vi.resetModules();
    let core = await import("./core");
    expect(core.getPersistBroker()).toBe("ig-live");

    localStorage.clear();
    vi.resetModules();
    core = await import("./core");
    expect(core.getPersistBroker()).toBe("capital");
  });
});
```

Add `vi` to the vitest import in that file if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist/core.test.ts`
Expected: FAIL — first test returns `"capital"` (session value ignored).

- [ ] **Step 3: Implement `brokerFromActiveAccount` session-first**

In `frontend/src/lib/persist/core.ts`, replace the body of `brokerFromActiveAccount` (lines 35-44):

```ts
function brokerFromActiveAccount(): string {
  try {
    // App persists the active account as "{broker}:{env}": sessionStorage is THIS
    // browser tab's selection; the bare localStorage key is the last-used seed
    // shared by all tabs (see App.tsx's activeAccount state + persist effect).
    const acct =
      sessionStorage.getItem("activeAccount") ??
      localStorage.getItem("activeAccount");
    if (acct) return acct.split(":")[0];
  } catch {
    /* test/node env without storage → default below */
  }
  return "capital"; // feed.ts DEFAULT_BROKER; literal to avoid an import cycle
}
```

(Use direct `sessionStorage` inside the existing try/catch rather than `sessionGet` — the function already guards, and `sessionGet` is defined later in the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Make App.tsx read/write both layers**

In `frontend/src/App.tsx`, update the state initializer (currently lines 391-393). Also update the comment above it (lines 387-389) — it says "Device-local"; the selection is now per browser tab with a device seed:

```tsx
  // Active broker / trading account (registry key "{broker}:{env}"). Drives BOTH
  // the chart data feed (epics are broker-specific) and order/position routing.
  // PER BROWSER TAB: sessionStorage is this tab's selection (each app tab can sit
  // on a different broker); the bare localStorage key is only the last-used seed
  // a brand-new tab opens on. The list of selectable accounts comes from GET
  // /api/brokers.
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<TradeAccount>(
    () =>
      sessionStorage.getItem("activeAccount") ??
      localStorage.getItem("activeAccount") ??
      DEFAULT_ACCOUNT,
  );
```

Then in the persist effect (currently line 464), replace the single `localStorage.setItem` line and fix the last-account map to merge with what's on disk (two tabs share the device-local map; writing our stale in-memory copy whole would drop a sibling tab's newer entry for ANOTHER broker — our own broker's entry must win from memory):

```tsx
  useEffect(() => {
    sessionStorage.setItem("activeAccount", activeAccount); // this tab's truth
    localStorage.setItem("activeAccount", activeAccount); // seed for future tabs
    // ... (setTradesAccount(activeAccount) line stays unchanged) ...
    // Remember this as the broker's last-used account (read when the tab-bar selector
    // switches back to this broker). Merge disk-first: sibling tabs write this shared
    // device-local map too, and their newer entries for OTHER brokers must survive.
    lastAccountByBroker.current = {
      ...loadLastAccountByBroker(),
      ...lastAccountByBroker.current,
      [brokerId]: activeAccount,
    };
    saveLastAccountByBroker(lastAccountByBroker.current);
  }, [activeAccount, brokerId]);
```

Keep the existing `setTradesAccount(activeAccount);` call and its comment exactly where they are (between the storage writes and the last-account bookkeeping).

- [ ] **Step 6: Typecheck + full persist tests**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts src/lib/persist/core.test.ts && npm run build`
Expected: tests PASS; build/typecheck clean. (If `package.json` has a `typecheck` script, use it instead of `build`.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/persist/core.ts frontend/src/lib/persist/core.test.ts frontend/src/App.tsx
git commit -m "feat(sessions): active broker/account is per browser tab (session-first, device seed)"
```

---

### Task 3: Per-browser-tab active layout

**Files:**
- Modify: `frontend/src/lib/persist/workspace.ts:315-322` (`loadActiveLayoutId`/`saveActiveLayoutId`) and its import list from `./core`
- Test: `frontend/src/lib/persist.test.ts`

**Interfaces:**
- Consumes: `sessionGet`, `sessionSet` from Task 1 (import into `workspace.ts` from `./core`).
- Produces: `loadActiveLayoutId(): string | null` / `saveActiveLayoutId(id: string | null)` keep their exact signatures; behavior becomes session-first. A session value of JSON `null` means "this tab explicitly chose scratch" and must NOT fall back to the localStorage seed.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/persist.test.ts`, add a describe block (note the file's `beforeEach` only clears localStorage — clear sessionStorage inside this block):

```ts
describe("per-browser-tab active layout (session-first with device seed)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => P.setPersistBroker("capital"));

  it("a fresh tab seeds from the localStorage last-used value", () => {
    localStorage.setItem("auto-trader.b.capital.activeLayoutId", JSON.stringify("L1"));
    expect(P.loadActiveLayoutId()).toBe("L1");
  });

  it("saving writes both layers and the session value wins afterwards", () => {
    P.saveActiveLayoutId("L2");
    expect(sessionStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBe('"L2"');
    expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBe('"L2"');
    // A sibling tab moving the device seed does not move THIS tab.
    localStorage.setItem("auto-trader.b.capital.activeLayoutId", JSON.stringify("L9"));
    expect(P.loadActiveLayoutId()).toBe("L2");
  });

  it("explicit scratch (null) in this tab does not fall back to the seed", () => {
    localStorage.setItem("auto-trader.b.capital.activeLayoutId", JSON.stringify("L1"));
    P.saveActiveLayoutId(null);
    expect(P.loadActiveLayoutId()).toBeNull();
    // The device seed follows too (null clears it, matching prior removeLocal behavior).
    expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBeNull();
  });

  it("session selections are per broker (key includes the broker root)", () => {
    P.saveActiveLayoutId("cap-layout");
    P.setPersistBroker("ig-demo");
    expect(P.loadActiveLayoutId()).toBeNull(); // ig-demo tab state is untouched
    P.saveActiveLayoutId("ig-layout");
    P.setPersistBroker("capital");
    expect(P.loadActiveLayoutId()).toBe("cap-layout");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: the new block FAILS (session layer not consulted; null falls back to seed).

- [ ] **Step 3: Implement session-first load/save**

In `frontend/src/lib/persist/workspace.ts`, add `sessionGet, sessionSet` to the import from `"./core"`, then replace `loadActiveLayoutId`/`saveActiveLayoutId` (lines 315-322):

```ts
// Which layout THIS BROWSER TAB currently shows (null = scratch). Session-first:
// sessionStorage is this tab's truth (each app tab can sit on a different layout);
// the device-local localStorage copy is the last-used seed a brand-new tab opens
// on. A session value of JSON null means this tab EXPLICITLY chose scratch — it
// must not fall back to the seed, or "go to scratch" would undo itself on reload.
export function loadActiveLayoutId(): string | null {
  const raw = sessionGet(activeLayoutKey());
  if (raw != null) {
    try {
      return JSON.parse(raw) as string | null;
    } catch {
      /* corrupt session entry → fall back to the seed */
    }
  }
  return load<string | null>(activeLayoutKey(), null);
}
export function saveActiveLayoutId(id: string | null): void {
  sessionSet(activeLayoutKey(), JSON.stringify(id));
  if (id == null) removeLocal(activeLayoutKey());
  else saveLocal(activeLayoutKey(), id);
}
```

Also update the two comments that describe the old scoping: the "Device-local: which layout this browser/tab currently shows" line above these functions is replaced by the comment in the snippet, and in the module's sync-split comment block (~lines 203-208 and 215-218) change "DEVICE-LOCAL → each browser/tab can have a different layout open" wording for `activeLayoutId` to "PER BROWSER TAB (session-first; device-local seed)".

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: PASS (all existing tests too — the seed fallback keeps old callers working).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/workspace.ts frontend/src/lib/persist.test.ts
git commit -m "feat(sessions): active layout is per browser tab (session-first, device seed)"
```

---

### Task 4: Retire the dead `root("tabs")` working-set key

**Files:**
- Modify: `frontend/src/lib/persist/workspace.ts` (delete `tabsKey`/`loadTabs`/`saveTabs`, lines 78-112 region)
- Modify: `frontend/src/lib/persist/alerts.ts:267-295` (`pruneLegacyGlobalWorkspace` area — add sibling prune) — or place the new prune in `workspace.ts`; keep it next to `pruneLegacyGlobalWorkspace`'s call site contractually via App
- Modify: `frontend/src/App.tsx` (~line 628, after `pruneLegacyGlobalWorkspace()`)
- Test: `frontend/src/lib/persist.test.ts` (retarget v1-migration tests + per-broker-isolation test; add prune test)

**Interfaces:**
- Consumes: `removeKeyEverywhere` from `core.ts`.
- Produces: `pruneLegacyTabsKeys(): void` exported from `frontend/src/lib/persist/workspace.ts` (re-exported by the barrel). `loadTabs`/`saveTabs` cease to exist — nothing outside their own tests referenced them (verified by grep).

- [ ] **Step 1: Retarget the tests that used loadTabs/saveTabs**

In `frontend/src/lib/persist.test.ts`:

(a) Rewrite the `"loadTabs migration (v1 single-chart → cell-based)"` describe (lines 149-196) to exercise the same migration through a LAYOUT BODY, which is where `migrateTabs` still runs. Replace the whole block with:

```ts
describe("layout-body migration (v1 single-chart → cell-based)", () => {
  it("wraps a pre-cells tab into one primary cell, preserving symbol/period", () => {
    localStorage.setItem(
      "auto-trader.b.capital.layout.L1",
      JSON.stringify({ tabs: [{ id: "t1", symbol: SYMBOL, period: PERIOD }], activeTabId: "t1" }),
    );
    const ws = P.loadLayout("L1");
    expect(ws).not.toBeNull();
    const t = ws!.tabs[0];
    expect(t.layout).toBe("1");
    expect(t.cells).toHaveLength(1);
    expect(t.activeCellId).toBe(t.cells[0].id);
    expect(t.cells[0].symbol).toEqual(SYMBOL);
    expect(t.cells[0].period).toEqual(PERIOD);
    // Migrated cell reuses the tab's primary scope so existing keys still resolve.
    expect(t.cells[0].scope).toBe(P.primaryCellScope("t1"));
  });

  it("a drawing saved under the pre-cells key is readable via the migrated cell's scope", () => {
    localStorage.setItem(
      "auto-trader.tab.t1.drawings.US100",
      JSON.stringify([{ name: "trend", points: [{ value: 1 }] }]),
    );
    localStorage.setItem(
      "auto-trader.b.capital.layout.L1",
      JSON.stringify({ tabs: [{ id: "t1", symbol: SYMBOL, period: PERIOD }], activeTabId: "t1" }),
    );
    const t = P.loadLayout("L1")!.tabs[0];
    expect(P.loadDrawings(t.cells[0].scope, "US100")).toHaveLength(1);
  });

  it("leaves already-migrated (cell-based) tabs untouched", () => {
    const cellBased = [
      {
        id: "t9",
        layout: "2h",
        activeCellId: "c1",
        cells: [
          { id: "c1", symbol: SYMBOL, period: PERIOD, scope: "tab.t9" },
          { id: "c2", symbol: SYMBOL, period: PERIOD, scope: "tab.t9.cell.c2" },
        ],
      },
    ];
    localStorage.setItem(
      "auto-trader.b.capital.layout.L1",
      JSON.stringify({ tabs: cellBased, activeTabId: "t9" }),
    );
    expect(P.loadLayout("L1")!.tabs).toEqual(cellBased);
  });
});
```

(b) Rewrite the `"roots (tabs) are isolated per broker"` test (lines ~449-460) to use scratch, which is the surviving broker-rooted workspace store:

```ts
  it("roots (scratch workspace) are isolated per broker", () => {
    P.setPersistBroker("capital");
    P.saveScratch({ tabs: [seedTab("cap1")], activeTabId: "" });
    P.setPersistBroker("ig-demo");
    expect(P.loadScratch()).toBeNull(); // ig-demo starts empty — capital's tabs don't leak
    P.saveScratch({ tabs: [seedTab("ig1")], activeTabId: "" });
    expect(P.loadScratch()!.tabs.map((t) => t.id)).toEqual(["ig1"]);
    P.setPersistBroker("capital");
    expect(P.loadScratch()!.tabs.map((t) => t.id)).toEqual(["cap1"]);
    expect(localStorage.getItem("auto-trader.b.capital.scratch")).not.toBeNull();
    expect(localStorage.getItem("auto-trader.b.ig-demo.scratch")).not.toBeNull();
  });
```

(c) Add the prune test:

```ts
describe("pruneLegacyTabsKeys", () => {
  it("removes stale per-broker .tabs keys and nothing else", () => {
    localStorage.setItem("auto-trader.b.capital.tabs", "[]");
    localStorage.setItem("auto-trader.b.ig-demo.tabs", "[]");
    localStorage.setItem("auto-trader.b.capital.scratch", "{}");
    localStorage.setItem("auto-trader.b.capital.layout.tabs", "{}"); // a layout ID that happens to be "tabs"
    P.pruneLegacyTabsKeys();
    expect(localStorage.getItem("auto-trader.b.capital.tabs")).toBeNull();
    expect(localStorage.getItem("auto-trader.b.ig-demo.tabs")).toBeNull();
    expect(localStorage.getItem("auto-trader.b.capital.scratch")).not.toBeNull();
    expect(localStorage.getItem("auto-trader.b.capital.layout.tabs")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: FAIL — `pruneLegacyTabsKeys` not exported (the retargeted migration tests should already pass; if any fail, the retarget is wrong — fix before proceeding).

- [ ] **Step 3: Delete dead code and add the prune**

In `frontend/src/lib/persist/workspace.ts`:

(a) Delete `const tabsKey = () => root("tabs");` (line 79), `loadTabs` (lines 105-109), and `saveTabs` (lines 110-112). Keep `migrateTabV1`/`migrateTabs` (still used by `loadLayout`/`loadScratch`); update `migrateTabs`'s comment to say "Shared by loadLayout and loadScratch (layout bodies)". If `root` becomes unused in the import list after this, leave it — `defaultLayoutKey`/`activeLayoutKey`/`scratchKey`/`autosaveKey` still use it.

(b) Add near the bottom of the file:

```ts
// One-time cleanup: the live working tab set USED to persist under a per-broker
// `.tabs` root; the autosave effect has long written the working set into the
// named layout body / scratch instead, leaving those keys as dead weight in
// localStorage and the backend. Cheap full scan, idempotent, safe to run every
// boot — call AFTER hydrateFromBackend so the deletes reach the backend.
export function pruneLegacyTabsKeys(): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Exactly `auto-trader.b.<broker>.tabs` — broker ids never contain dots, so
    // require no further dot after the broker segment (a layout named "tabs"
    // lives under `...layout.tabs` and must survive).
    if (k && /^auto-trader\.b\.[^.]+\.tabs$/.test(k)) doomed.push(k);
  }
  for (const k of doomed) removeKeyEverywhere(k);
}
```

`removeKeyEverywhere` is already imported in this file.

- [ ] **Step 4: Call the prune on boot**

In `frontend/src/App.tsx`, inside the hydration effect right after the `pruneLegacyGlobalWorkspace();` call (~line 628), add:

```tsx
      pruneLegacyGlobalWorkspace();
      // The working tab set now lives in the layout body / scratch; drop the
      // abandoned per-broker `.tabs` roots (localStorage + backend).
      pruneLegacyTabsKeys();
```

Add `pruneLegacyTabsKeys` to the big import from `"./lib/persist"`.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts && npm run build`
Expected: PASS / clean. The build also proves nothing else imported `loadTabs`/`saveTabs`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/workspace.ts frontend/src/lib/persist.test.ts frontend/src/App.tsx
git commit -m "refactor(persist): retire dead per-broker tabs root; prune stale keys on boot"
```

---

### Task 5: End-to-end verification (two browser tabs)

**Files:**
- No source changes expected. Fixes discovered here get their own micro-commits.

**Interfaces:**
- Consumes: everything above; verifies spec sections 3 and 5 (push gate + edge cases), which required no code change.

- [ ] **Step 1: Full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (no regressions outside persist).

- [ ] **Step 2: Manual two-tab pass against the dev server**

Use the running HMR dev server (do not restart it). Open the app in two browser tabs and verify, in order:

1. **Broker independence:** switch tab A to a different broker (tab-bar selector). Tab B stays on its broker; no remount/flash in B. Reload tab A — it stays on its chosen broker. Reload tab B — unchanged. A brand-new third tab opens on tab A's broker (last-used seed).
2. **Layout independence:** with both tabs on the same broker, switch tab A to layout X and tab B to layout Y. Each survives its own reload. Switching tab A to scratch does not move tab B, and reloading A keeps it on scratch even though B later saves a layout selection.
3. **Same-layout live sync still works:** both tabs on layout X; add a chart tab / draw a trendline in A; B picks it up (grid refresh) within a beat. Edit in B; A picks it up.
4. **Cross-layout non-interference:** with A on X and B on Y, edit B's workspace; A must not remount (watch for chart flicker) — only its layout picker refreshes.
5. **Legacy key prune:** in DevTools console of either tab, `Object.keys(localStorage).filter(k => /\.b\.[^.]+\.tabs$/.test(k))` returns `[]` after a reload.
6. **Live-engine lease unchanged:** if quick to check, arm live trading on the same market in both tabs — the second must refuse (lease); different markets/brokers may both arm.

Expected: all six hold. Any failure: stop, diagnose with superpowers:systematic-debugging, fix, re-verify.

- [ ] **Step 3: Commit any verification fixes and finish**

```bash
git status  # should be clean if no fixes were needed
```

If fixes were made, commit them individually with `fix(sessions): ...` messages.
