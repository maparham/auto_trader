# Mobile Companion (PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable mobile PWA shell inside the existing frontend — live compact chart with indicators and drawing tools, alerts, positions & P&L, and an order ticket — reusing the desktop data layer and ChartCore.

**Architecture:** A third boot branch in `main.tsx` (inside `ClerkProvider > SignedIn > AccountGate`) mounts `MobileApp`: a bottom-tab shell (Chart · Alerts · Positions · Trade) that mounts `ChartCore` in a new `compact` mode and re-hosts the `lib/signals` request→modal set in mobile-sheet form. Data layer (`lib/http`, `lib/feed`, `lib/persist`, `lib/alertsApi`, `lib/trading`), theme, and persistence sync are reused untouched.

**Tech Stack:** React 19 + TypeScript (strict), Vite 8, klinecharts 10, Vitest + Testing Library (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-mobile-companion-design.md`

## Global Constraints

- All work happens in `frontend/`. Run tests with `cd frontend && npx vitest run <file>`; lint with `npx eslint <files>`.
- Commit to the **current branch** (`main`). NEVER create a branch. NEVER run `git stash`, `git clean`, or `git checkout -- .` — other sessions may share this worktree. Stage by explicit path only (`git add <file> <file>`), never `git add -A` or `git add .`.
- Never suggest or run `git push`.
- No new npm dependencies.
- Desktop behavior must not change: every new render path is gated behind the mobile boot branch or the `compact` prop (default off).
- New UI text/styling follows existing conventions: CSS variables from `theme.ts` (`var(--bg)`, `var(--fg)`, `var(--border)`, etc. — read `src/index.css` for the token set), muted gray (not accent blue) for persistent toggle "on" states.
- The existing `Tooltip`/`InfoTip` components are desktop pointer affordances — don't add tooltips to mobile UI; use visible labels.
- Existing tests must keep passing. Before the final task, `npx vitest run` must be green and `npm run build` must succeed.

## File Structure

New files (all under `frontend/`):

- `src/lib/mobileBoot.ts` + `.test.ts` — pure boot-branch decision (URL param / stored choice / media query).
- `src/lib/mobileScope.ts` + `.test.ts` — initial-market and drawings-scope resolution from `view.<epic>` heartbeats.
- `src/mobile/MobileApp.tsx` — shell: bootstrap, tab bar, tab routing, modal host mount.
- `src/mobile/mobile.css` — all mobile styles (one file; imported by MobileApp).
- `src/mobile/mobileChartState.ts` — module signals sharing the live chart/controller/symbol/period between mobile views.
- `src/mobile/Sheet.tsx` + `.test.tsx` — bottom-sheet primitive (portal + backdrop).
- `src/mobile/MobileChartView.tsx` + `.test.tsx` — chart tab (top bar, period sheet, ChartCore mount).
- `src/mobile/MobileModals.tsx` + `.test.tsx` — signal→modal re-hosting.
- `src/mobile/MobileDrawBar.tsx` + `.test.tsx` — pencil FAB, tool strip, magnet toggle, selection actions.
- `src/mobile/MobileIndicatorsSheet.tsx` + `.test.tsx` — active-indicator list + add picker.
- `src/mobile/MobileAlertsView.tsx` + `.test.tsx` — alerts tab (active + fired history).
- `src/mobile/MobilePositionsView.tsx` + `.test.tsx` — positions tab.
- `src/mobile/MobileTradeView.tsx` + `.test.tsx` — trade tab wrapping OrderTicket.
- `public/manifest.webmanifest`, icon PNGs — PWA install surface.

Modified files:

- `src/main.tsx` — third boot branch.
- `src/ChartCore.tsx` — `compact?: boolean` prop gating desktop chrome.
- `index.html` — manifest link + mobile meta tags.
- `public/alert-sw.js` — app-shell precache added to the existing push SW.

---

### Task 1: Mobile boot decision (`lib/mobileBoot.ts`)

**Files:**
- Create: `src/lib/mobileBoot.ts`
- Test: `src/lib/mobileBoot.test.ts`

**Interfaces:**
- Produces: `decideMobileBoot(search: string, stored: string | null, coarseSmall: boolean): { mobile: boolean; persist: "1" | "0" | null }` — pure decision; `persist` non-null when the URL forced a choice that should be remembered.
- Produces: `shouldBootMobile(): boolean` — impure wrapper reading `window.location.search`, `localStorage["auto-trader.mobileBoot"]`, and `matchMedia("(max-width: 768px) and (pointer: coarse)")`, persisting per the decision. `main.tsx` calls only this.

Decision table for `decideMobileBoot`:
- `?m=1` in search → `{mobile: true, persist: "1"}`
- `?m=0` in search → `{mobile: false, persist: "0"}`
- else stored `"1"` → `{mobile: true, persist: null}`; stored `"0"` → `{mobile: false, persist: null}`
- else → `{mobile: coarseSmall, persist: null}`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mobileBoot.test.ts
import { describe, it, expect } from "vitest";
import { decideMobileBoot } from "./mobileBoot";

describe("decideMobileBoot", () => {
  it("?m=1 forces mobile and persists", () => {
    expect(decideMobileBoot("?m=1", null, false)).toEqual({ mobile: true, persist: "1" });
  });
  it("?m=0 forces desktop and persists, beating a stored choice", () => {
    expect(decideMobileBoot("?m=0", "1", true)).toEqual({ mobile: false, persist: "0" });
  });
  it("stored choice wins over media", () => {
    expect(decideMobileBoot("", "1", false)).toEqual({ mobile: true, persist: null });
    expect(decideMobileBoot("?foo=bar", "0", true)).toEqual({ mobile: false, persist: null });
  });
  it("falls back to the media query", () => {
    expect(decideMobileBoot("", null, true)).toEqual({ mobile: true, persist: null });
    expect(decideMobileBoot("", null, false)).toEqual({ mobile: false, persist: null });
  });
  it("ignores junk m values", () => {
    expect(decideMobileBoot("?m=2", null, false)).toEqual({ mobile: false, persist: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/mobileBoot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/mobileBoot.ts
// Boot-branch decision for the mobile PWA shell (spec:
// 2026-09-07-mobile-companion-design.md). Pure half + a window-reading wrapper
// so main.tsx stays declarative and the logic is unit-testable.

const STORE_KEY = "auto-trader.mobileBoot";

export function decideMobileBoot(
  search: string,
  stored: string | null,
  coarseSmall: boolean,
): { mobile: boolean; persist: "1" | "0" | null } {
  const m = new URLSearchParams(search).get("m");
  if (m === "1") return { mobile: true, persist: "1" };
  if (m === "0") return { mobile: false, persist: "0" };
  if (stored === "1") return { mobile: true, persist: null };
  if (stored === "0") return { mobile: false, persist: null };
  return { mobile: coarseSmall, persist: null };
}

export function shouldBootMobile(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    /* storage unavailable */
  }
  const coarseSmall =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
  const d = decideMobileBoot(window.location.search, stored, coarseSmall);
  if (d.persist) {
    try {
      localStorage.setItem(STORE_KEY, d.persist);
    } catch {
      /* best-effort */
    }
  }
  return d.mobile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mobileBoot.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mobileBoot.ts src/lib/mobileBoot.test.ts
git commit -m "feat(mobile): boot-branch decision logic"
```

---

### Task 2: MobileApp skeleton + main.tsx branch

**Files:**
- Create: `src/mobile/MobileApp.tsx`, `src/mobile/mobile.css`
- Modify: `src/main.tsx`
- Test: `src/mobile/MobileApp.test.tsx`

**Interfaces:**
- Consumes: `shouldBootMobile()` from Task 1; `hydrateFromBackend` from `./lib/persist`; `hydrateAlerts` from `./lib/alertsApi`; `applyThemeToDocument, loadSettings` from `./theme`.
- Produces: `MobileApp` (default export) — full-screen shell with a bottom tab bar. Exports `type MobileTab = "chart" | "alerts" | "positions" | "trade"` and a module-level `mobileTabSignal = new Signal<MobileTab>("chart")` (imported by later tasks to switch tabs programmatically, e.g. `stageChartOrder` → trade tab).
- Tab content: placeholder `<div>`s in this task; Tasks 6/10/11/12 replace them.

Key requirements:
- Import `App.tsx`'s registrar side effects WITHOUT mounting App. `main.tsx` already statically imports `App.tsx`, and the mobile branch lives in `main.tsx`, so the registrations run regardless — no extra work needed, but add a comment in `MobileApp.tsx` noting the dependency (see `src/lib/moduleInitOrder.test.ts`).
- Bootstrap sequence mirrors `SnapshotApp.tsx:36-44`: `hydrateFromBackend()` → `hydrateAlerts()` → `applyThemeToDocument(loadSettings())` → render tabs. Render `null` until hydrated; on hydration failure still render (localStorage is the source of truth — log the error via `console.warn`).
- The mobile branch in `main.tsx` goes INSIDE the Clerk tree (and inside the no-Clerk fallback):

```tsx
// main.tsx — inside <AccountGate> replace <App /> with:
{shouldBootMobile() ? <MobileApp /> : <App />}
// and the CLERK-disabled fallback branch becomes:
shouldBootMobile() ? <MobileApp /> : <App />
```

(The `?snapshot=1` branch stays first and untouched. Call `shouldBootMobile()` ONCE into a `const bootMobile` before `createRoot` so both branches agree.)

- `mobile.css`: import at top of `MobileApp.tsx`. Shell layout:

```css
.m-app { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); }
.m-body { flex: 1; min-height: 0; position: relative; }
.m-tabbar { display: flex; border-top: 1px solid var(--border); background: var(--bg); padding-bottom: env(safe-area-inset-bottom); }
.m-tabbar button { flex: 1; padding: 10px 0 8px; background: none; border: none; color: var(--fg-muted, var(--fg)); font-size: 12px; }
.m-tabbar button.active { color: var(--fg); font-weight: 600; }
```

(Verify the actual muted-foreground variable name in `src/index.css` and use that.)

- [ ] **Step 1: Write the failing test**

```tsx
// src/mobile/MobileApp.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/persist", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hydrateFromBackend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/alertsApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hydrateAlerts: vi.fn().mockResolvedValue(undefined),
}));

import MobileApp, { mobileTabSignal } from "./MobileApp";

describe("MobileApp shell", () => {
  beforeEach(() => mobileTabSignal.set("chart"));

  it("renders the four tabs after hydration and switches on tap", async () => {
    render(<MobileApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alerts" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Chart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trade" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(mobileTabSignal.value).toBe("alerts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/MobileApp.test.tsx` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement MobileApp**

```tsx
// src/mobile/MobileApp.tsx
// Mobile companion shell (spec: 2026-09-07-mobile-companion-design.md).
// NOTE: klinecharts custom indicators/overlays are registered by App.tsx's
// module-level side effects; main.tsx imports App statically, so they are
// registered before we mount (see lib/moduleInitOrder.test.ts).
import { useEffect, useState, useSyncExternalStore } from "react";
import { Signal } from "../lib/signals";
import { hydrateFromBackend } from "../lib/persist";
import { hydrateAlerts } from "../lib/alertsApi";
import { applyThemeToDocument, loadSettings } from "../theme";
import "./mobile.css";

export type MobileTab = "chart" | "alerts" | "positions" | "trade";
export const mobileTabSignal = new Signal<MobileTab>("chart");

const TABS: { id: MobileTab; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "alerts", label: "Alerts" },
  { id: "positions", label: "Positions" },
  { id: "trade", label: "Trade" },
];

export default function MobileApp() {
  const [ready, setReady] = useState(false);
  const tab = useSyncExternalStore(
    (fn) => mobileTabSignal.subscribe(fn),
    () => mobileTabSignal.value,
  );

  useEffect(() => {
    hydrateFromBackend()
      .then(() => hydrateAlerts())
      .catch((e) => console.warn("mobile hydrate failed; using local state", e))
      .finally(() => {
        applyThemeToDocument(loadSettings());
        setReady(true);
      });
  }, []);

  if (!ready) return null;

  return (
    <div className="m-app">
      <div className="m-body">
        {tab === "chart" && <div data-tab="chart" />}
        {tab === "alerts" && <div data-tab="alerts" />}
        {tab === "positions" && <div data-tab="positions" />}
        {tab === "trade" && <div data-tab="trade" />}
      </div>
      <nav className="m-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => mobileTabSignal.set(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
```

Check `Signal`'s actual `subscribe` return/API in `src/lib/signals.ts:15` and match it. If the repo already has a `useSignal`-style hook (grep `useSyncExternalStore` under `src/`), reuse that pattern instead.

- [ ] **Step 4: Run test** — `npx vitest run src/mobile/MobileApp.test.tsx` — PASS.

- [ ] **Step 5: Wire main.tsx** (as shown in Interfaces above; import `shouldBootMobile` and `MobileApp`).

- [ ] **Step 6: Verify no desktop regression**

Run: `npx vitest run` — all existing tests still pass. Run `npx tsc -b --noEmit` (or `npm run build`) — compiles.

- [ ] **Step 7: Commit**

```bash
git add src/mobile/MobileApp.tsx src/mobile/mobile.css src/mobile/MobileApp.test.tsx src/main.tsx
git commit -m "feat(mobile): MobileApp shell + boot branch in main.tsx"
```

---

### Task 3: Initial market + drawings-scope resolution (`lib/mobileScope.ts`)

**Files:**
- Create: `src/lib/mobileScope.ts`
- Test: `src/lib/mobileScope.test.ts`

**Interfaces:**
- Consumes: `viewKey`, `ViewDescriptor` from `./viewHeartbeat`; `brokerRoot`, `load` from `./persist`; `resolveDescriptor` from `./snapshotBoot`; `fetchFavorites`, `Instrument` from `./feed`.
- Produces:
  - `freshestView(broker: string): ViewDescriptor | null` — scan `localStorage` keys starting with `brokerRoot(broker, "view.")`, JSON-parse each, return the valid descriptor (has string `scope`, string `resolution`, object `symbol`) with the greatest `updatedAt`, else null. (Mirror the scan loop in `viewHeartbeat.ts` `pruneHeartbeats`.)
  - `mobileDrawScope(broker: string, epic: string): string` — `resolveDescriptor(broker, epic)?.scope ?? "mobile"`. The `"mobile"` fallback scope is a constant; drawings persist keyed `scope+epic` so one fallback scope is safe across markets.
  - `initialMarket(broker: string): Promise<{ symbol: Instrument; resolution: string } | null>` — `freshestView(broker)` → `{symbol: d.symbol, resolution: d.resolution}`; else first of `await fetchFavorites(broker)` with resolution `"MINUTE_5"`; else null (caller shows the symbol search).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mobileScope.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { brokerRoot } from "./persist";
import { freshestView, mobileDrawScope } from "./mobileScope";

const desc = (epic: string, updatedAt: number, scope = `tab.t1.cell.c1`) => ({
  scope, epic, broker: "capital", resolution: "MINUTE_5",
  symbol: { epic, name: epic }, barSpace: 8, width: 390, height: 500, updatedAt,
});

describe("mobileScope", () => {
  beforeEach(() => localStorage.clear());

  it("freshestView picks the newest valid heartbeat", () => {
    localStorage.setItem(brokerRoot("capital", "view.US100"), JSON.stringify(desc("US100", 100)));
    localStorage.setItem(brokerRoot("capital", "view.GOLD"), JSON.stringify(desc("GOLD", 200)));
    localStorage.setItem(brokerRoot("capital", "view.BAD"), "{not json");
    expect(freshestView("capital")?.epic).toBe("GOLD");
  });

  it("freshestView returns null with no heartbeats", () => {
    expect(freshestView("capital")).toBeNull();
  });

  it("mobileDrawScope adopts the epic's heartbeat scope", () => {
    localStorage.setItem(brokerRoot("capital", "view.US100"), JSON.stringify(desc("US100", 100, "tab.x.cell.y")));
    expect(mobileDrawScope("capital", "US100")).toBe("tab.x.cell.y");
  });

  it("mobileDrawScope falls back to the mobile scope", () => {
    expect(mobileDrawScope("capital", "US100")).toBe("mobile");
  });
});
```

NOTE: check `brokerRoot`'s import path — it's exported from `./persist` (re-export) or `./persist/core`; use whichever `viewHeartbeat.ts` uses. Also check the shape validation `resolveDescriptor` applies (`snapshotBoot.ts:28-32`) and reuse it. If the test's `symbol` object needs more `Instrument` fields to satisfy types, cast via `as unknown as ViewDescriptor`.

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run src/lib/mobileScope.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/lib/mobileScope.ts
// Which market + drawings scope the mobile shell opens with (spec §1, §2).
import { brokerRoot } from "./persist";
import { resolveDescriptor } from "./snapshotBoot";
import type { ViewDescriptor } from "./viewHeartbeat";
import { fetchFavorites, type Instrument } from "./feed";

export const MOBILE_FALLBACK_SCOPE = "mobile";

function validDescriptor(v: unknown): v is ViewDescriptor {
  const d = v as ViewDescriptor | null;
  return !!d && typeof d.scope === "string" && !!d.scope &&
    typeof d.resolution === "string" && typeof d.epic === "string" &&
    !!d.symbol && typeof d.symbol === "object";
}

export function freshestView(broker: string): ViewDescriptor | null {
  const prefix = brokerRoot(broker, "view.");
  let best: ViewDescriptor | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      if (validDescriptor(parsed) && (best === null || (parsed.updatedAt ?? 0) > (best.updatedAt ?? 0)))
        best = parsed;
    } catch {
      /* junk entry — skip */
    }
  }
  return best;
}

export function mobileDrawScope(broker: string, epic: string): string {
  return resolveDescriptor(broker, epic)?.scope ?? MOBILE_FALLBACK_SCOPE;
}

export async function initialMarket(
  broker: string,
): Promise<{ symbol: Instrument; resolution: string } | null> {
  const d = freshestView(broker);
  if (d) return { symbol: d.symbol, resolution: d.resolution };
  try {
    const favs = await fetchFavorites(broker);
    if (favs.length) return { symbol: favs[0], resolution: "MINUTE_5" };
  } catch {
    /* backend down — caller shows symbol search */
  }
  return null;
}
```

- [ ] **Step 4: Run test** — PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/mobileScope.ts src/lib/mobileScope.test.ts
git commit -m "feat(mobile): initial-market and drawings-scope resolution"
```

---

### Task 4: ChartCore `compact` mode

**Files:**
- Modify: `src/ChartCore.tsx` (Props at `:234-285`; chrome JSX at `:4999` `ChartRangeBar`, `:5012` `DetachedPill`, `:5019` `ReplayPill`, `:5063` `ReplayTicket`, `:5340` `ReplayStartPanel`, `:5362` `CandleCacheStatsModal`)
- Create: `src/chart/compactChrome.ts`
- Test: `src/chart/compactChrome.test.ts`

**Interfaces:**
- Produces: `compactHides(compact: boolean | undefined): { rangeBar: boolean; replay: boolean; detachedPill: boolean; cacheStats: boolean }` — pure map from the flag to which chrome is suppressed (all `true` when compact).
- Produces: `compact?: boolean` added to ChartCore `Props` (default undefined = desktop, zero behavior change).

Implementation notes:
- In ChartCore's return, wrap each listed chrome element: `{!hides.rangeBar && <ChartRangeBar .../>}` etc. `ReplayPill`, `ReplayTicket`, `ReplayStartPanel` are all gated by `hides.replay`. `MarketInfoPopover`, `ChartLegend`, and the three `ContextMenu`s STAY — the legend is already collapsible, and mobile browsers synthesize `contextmenu` on long-press, so the existing right-click menus (drawing edit/delete lives there) work via long-press for free.
- Do NOT touch any hook or effect — only JSX gating. Hooks must run identically in both modes (Rules of Hooks + no behavior drift).

- [ ] **Step 1: Write the failing test**

```ts
// src/chart/compactChrome.test.ts
import { describe, it, expect } from "vitest";
import { compactHides } from "./compactChrome";

describe("compactHides", () => {
  it("desktop hides nothing", () => {
    expect(compactHides(undefined)).toEqual({ rangeBar: false, replay: false, detachedPill: false, cacheStats: false });
    expect(compactHides(false)).toEqual({ rangeBar: false, replay: false, detachedPill: false, cacheStats: false });
  });
  it("compact hides desktop chrome", () => {
    expect(compactHides(true)).toEqual({ rangeBar: true, replay: true, detachedPill: true, cacheStats: true });
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement `compactChrome.ts`**

```ts
// src/chart/compactChrome.ts
// Which built-in ChartCore chrome the mobile compact mode suppresses (spec §2).
export interface CompactHides {
  rangeBar: boolean;
  replay: boolean;
  detachedPill: boolean;
  cacheStats: boolean;
}
export function compactHides(compact: boolean | undefined): CompactHides {
  const on = compact === true;
  return { rangeBar: on, replay: on, detachedPill: on, cacheStats: on };
}
```

- [ ] **Step 4: Run test — PASS.**
- [ ] **Step 5: Wire into ChartCore** — add `compact?: boolean;` to `Props` with a doc comment; `const hides = compactHides(compact);` near the top of the render body; gate the six JSX sites listed above.
- [ ] **Step 6: Full test run** — `npx vitest run` all green; `npx tsc -b --noEmit` clean.
- [ ] **Step 7: Commit**

```bash
git add src/chart/compactChrome.ts src/chart/compactChrome.test.ts src/ChartCore.tsx
git commit -m "feat(chart): compact mode gating desktop chrome for mobile"
```

---

### Task 5: Bottom-sheet primitive (`mobile/Sheet.tsx`)

**Files:**
- Create: `src/mobile/Sheet.tsx`
- Modify: `src/mobile/mobile.css`
- Test: `src/mobile/Sheet.test.tsx`

**Interfaces:**
- Produces: `Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode })` — portal (`createPortal` to `document.body`) rendering a dimmed backdrop + a bottom-anchored panel. Backdrop click and Escape call `onClose`. The panel has `role="dialog"`, `aria-label={title}`, max-height 85vh, internal scroll.

- [ ] **Step 1: Write the failing test**

```tsx
// src/mobile/Sheet.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sheet from "./Sheet";

describe("Sheet", () => {
  it("renders children in a dialog and closes on backdrop click", async () => {
    const onClose = vi.fn();
    render(<Sheet title="Test sheet" onClose={onClose}><p>hello</p></Sheet>);
    expect(screen.getByRole("dialog", { name: "Test sheet" })).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    await userEvent.click(document.querySelector(".m-sheet-backdrop")!);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><p>x</p></Sheet>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
// src/mobile/Sheet.tsx
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function Sheet({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="m-sheet-backdrop" onClick={onClose}>
      <div
        className="m-sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="m-sheet-title">{title}</div>}
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
```

CSS to append to `mobile.css`:

```css
.m-sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 200; display: flex; align-items: flex-end; }
.m-sheet { width: 100%; max-height: 85vh; background: var(--bg); border-top: 1px solid var(--border); border-radius: 12px 12px 0 0; display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom); }
.m-sheet-title { padding: 12px 16px; font-weight: 600; border-bottom: 1px solid var(--border); }
.m-sheet-body { overflow-y: auto; padding: 8px 0; }
```

- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/Sheet.tsx src/mobile/Sheet.test.tsx src/mobile/mobile.css
git commit -m "feat(mobile): bottom-sheet primitive"
```

---

### Task 6: Chart tab (`MobileChartView`)

**Files:**
- Create: `src/mobile/MobileChartView.tsx`, `src/mobile/mobileChartState.ts`
- Modify: `src/mobile/MobileApp.tsx` (replace chart placeholder), `src/mobile/mobile.css`
- Test: `src/mobile/MobileChartView.test.tsx`

**Interfaces:**
- Consumes: `initialMarket`, `mobileDrawScope` from `../lib/mobileScope`; `PERIODS`, `periodByResolution`, `type Period`, `type Instrument`, `DEFAULT_BROKER` from `../lib/feed`; `ChartCore` (with Task 4's `compact`); `loadSettings` from `../theme`; `Sheet` from Task 5; `requestSymbolSearch` + the symbol-search signal from `../lib/signals` (read `signals.ts:738` for the signal it sets — host the modal in Task 7).
- Produces (`mobileChartState.ts`):

```ts
import { Signal } from "../lib/signals";
import type { Chart } from "klinecharts";
import type { ChartController } from "../lib/chartController";
import type { Instrument, Period } from "../lib/feed";

export interface MobileChartCtx {
  chart: Chart;
  controller: ChartController;
}
export const mobileChartCtx = new Signal<MobileChartCtx | null>(null);
export const mobileSymbol = new Signal<Instrument | null>(null);
export const mobilePeriod = new Signal<Period | null>(null);
```

(Verify `ChartController`'s export location — `src/lib/chartController.ts`.)

Behavior:
- On mount: `initialMarket(DEFAULT_BROKER)` (use the active data broker the way App does — grep how App derives `brokerId`; if that is complex, `DEFAULT_BROKER` is acceptable for V1) → set `mobileSymbol` / `mobilePeriod` (via `periodByResolution(res)` with fallback `{resolution: res, label: res}`); null → immediately `requestSymbolSearch()`.
- Render: top bar with two buttons — symbol name (opens symbol search via `requestSymbolSearch()`) and period label (opens a `Sheet` listing `PERIODS`; tap sets `mobilePeriod`) — plus an "Indicators" button (wired in Task 9, placeholder button now) ； below, `ChartCore` filling the remaining space with `cellId="mobile"`, `tabId="mobile"`, `scope={mobileDrawScope(broker, symbol.epic)}`, settings-derived props copied from `SnapshotApp.tsx:66-84`, `compact`, `focused`, `syncCrosshair={false}`, `syncTime={false}`, `locked={false}`, `onReady={(_, chart, controller) => mobileChartCtx.set({ chart, controller })}`, `onPeriod={(_, p) => mobilePeriod.set(p)}`.
- Keep the ChartCore mount keyed by `symbol.epic` (`key={symbol.epic}`) so a symbol change remounts cleanly with the new scope.
- The test must mock `ChartCore` (klinecharts needs a real canvas): `vi.mock("../ChartCore", () => ({ default: (p: {symbol: {epic: string}}) => <div data-testid="chartcore" data-epic={p.symbol.epic} /> }))`.

- [ ] **Step 1: Write the failing test** — renders with a seeded heartbeat (reuse Task 3's seeding helper inline), asserts top bar shows the symbol name and mocked ChartCore gets the epic; tapping the period button opens a sheet listing "5m"-style labels from `PERIODS`, tapping one updates the period label.

```tsx
// src/mobile/MobileChartView.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { brokerRoot } from "../lib/persist";

vi.mock("../ChartCore", () => ({
  default: (p: { symbol: { epic: string } }) => (
    <div data-testid="chartcore" data-epic={p.symbol.epic} />
  ),
}));

import MobileChartView from "./MobileChartView";
import { mobileSymbol, mobilePeriod } from "./mobileChartState";
import { DEFAULT_BROKER, PERIODS } from "../lib/feed";

describe("MobileChartView", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileSymbol.set(null);
    mobilePeriod.set(null);
    localStorage.setItem(
      brokerRoot(DEFAULT_BROKER, "view.US100"),
      JSON.stringify({
        scope: "tab.t.cell.c", epic: "US100", broker: DEFAULT_BROKER,
        resolution: "MINUTE_5", symbol: { epic: "US100", name: "US 100" },
        barSpace: 8, width: 390, height: 500, updatedAt: Date.now(),
      }),
    );
  });

  it("boots on the freshest heartbeat and mounts the chart", async () => {
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore").dataset.epic).toBe("US100"));
    expect(screen.getByRole("button", { name: /US 100/ })).toBeTruthy();
  });

  it("changes period via the sheet", async () => {
    render(<MobileChartView />);
    await waitFor(() => screen.getByTestId("chartcore"));
    await userEvent.click(screen.getByRole("button", { name: PERIODS.find(p => p.resolution === "MINUTE_5")!.label }));
    const other = PERIODS.find((p) => p.resolution !== "MINUTE_5")!;
    await userEvent.click(screen.getByRole("button", { name: other.label }));
    expect(mobilePeriod.value?.resolution).toBe(other.resolution);
  });
});
```

(Adjust label-matching to the real `Period.label` values — read `feed.ts:23-64` first. If `new Date()`/network calls fire from imported modules, mock `../lib/feed`'s `fetchFavorites` too.)

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement `mobileChartState.ts` + `MobileChartView.tsx`** per Interfaces/Behavior above, mount into `MobileApp` (`{tab === "chart" && <MobileChartView />}` — keep it MOUNTED but hidden (`style={{display: tab==="chart"?undefined:"none"}}`) so the chart's websocket survives tab switches).
- [ ] **Step 4: PASS; full `npx vitest run` green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileChartView.tsx src/mobile/MobileChartView.test.tsx src/mobile/mobileChartState.ts src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): chart tab with period/symbol top bar"
```

---

### Task 7: Signal→modal re-hosting (`MobileModals`)

**Files:**
- Create: `src/mobile/MobileModals.tsx`
- Modify: `src/mobile/MobileApp.tsx` (mount `<MobileModals />` last), `src/mobile/mobile.css`
- Test: `src/mobile/MobileModals.test.tsx`

**Interfaces:**
- Consumes signals from `../lib/signals`: `alertModalRequest` (`{price} | null`), `alertEditRequest` (`{id} | null`), `alertGlobalEditRequest`, `drawingSettingsRequest` (`{id} | null`), `indicatorSettingsRequest` (`{paneId, name, ...} | null` — read `signals.ts:776`), `confirmRequest`, the symbol-search signal (read `requestSymbolSearch` at `signals.ts:738` for its backing signal), `draftOrderSignal`.
- Consumes: `mobileChartCtx`, `mobileSymbol`, `mobilePeriod` from Task 6; desktop modal components `AlertModal`, `DrawingSettings`, `IndicatorSettings`, `ConfirmDialog`, `SymbolSearchModal`.
- Produces: `MobileModals()` — one component subscribing to each signal (`useSyncExternalStore`), rendering the corresponding DESKTOP modal component when non-null. Copy the exact prop wiring from `App.tsx:2806-2960` (AlertModal create/edit/global-edit incl. `requestConfirm` delete flow, IndicatorSettings, DrawingSettings, ConfirmDialog last), substituting `mobileChartCtx.value?.controller` for `focusedController`, `mobileSymbol.value` for `symbol`, `mobilePeriod.value` for `period`, scope from the controller (`controller.scope`), `cellId: "mobile"`, `brokerId` as in Task 6.
- `draftOrderSignal` handling: when it becomes non-null, `mobileTabSignal.set("trade")` (Task 12's ticket reads the draft).
- Symbol-search select handler: `mobileSymbol.set(instrument)`.
- The desktop modals are fixed-position dialogs; add a `mobile.css` override so `.m-app` descendant modals fit the viewport:

```css
/* Desktop modals re-hosted on mobile: full-width, bottom-anchored. */
.m-modal-host > * { max-width: 100vw !important; }
```

(Refine per-component during implementation; wrap the rendered modals in `<div className="m-modal-host">`.)

- [ ] **Step 1: Write the failing test** — mock the heavy modal components; assert each signal mounts its host:

```tsx
// src/mobile/MobileModals.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("../AlertModal", () => ({ default: () => <div data-testid="alert-modal" /> }));
vi.mock("../DrawingSettings", () => ({ default: () => <div data-testid="drawing-settings" /> }));
vi.mock("../IndicatorSettings", () => ({ default: () => <div data-testid="indicator-settings" /> }));
vi.mock("../ConfirmDialog", () => ({ default: () => <div data-testid="confirm" /> }));
vi.mock("../SymbolSearchModal", () => ({ default: () => <div data-testid="symbol-search" /> }));

import MobileModals from "./MobileModals";
import { alertModalRequest, drawingSettingsRequest, requestConfirm, confirmRequest, draftOrderSignal, stageChartOrder } from "../lib/signals";
import { mobileChartCtx, mobileSymbol } from "./mobileChartState";
import { mobileTabSignal } from "./MobileApp";

describe("MobileModals", () => {
  beforeEach(() => {
    alertModalRequest.set(null);
    drawingSettingsRequest.set(null);
    confirmRequest.set(null);
    draftOrderSignal.set(null);
    mobileSymbol.set({ epic: "US100", name: "US 100" } as never);
    mobileChartCtx.set({ controller: { overlays: {} }, chart: {} } as never);
  });

  it("hosts the alert modal on alertModalRequest", () => {
    render(<MobileModals />);
    act(() => alertModalRequest.set({ price: 123 }));
    expect(screen.getByTestId("alert-modal")).toBeTruthy();
  });

  it("hosts confirm on requestConfirm", () => {
    render(<MobileModals />);
    act(() => requestConfirm({ message: "sure?", onConfirm: () => {} }));
    expect(screen.getByTestId("confirm")).toBeTruthy();
  });

  it("routes a staged chart order to the trade tab", () => {
    render(<MobileModals />);
    act(() => stageChartOrder({ epic: "US100", side: "buy", price: 100 }));
    expect(mobileTabSignal.value).toBe("trade");
  });
});
```

(Add analogous cases for drawingSettingsRequest — it needs a controller with `overlays`; keep the mock ctx above.)

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** per Interfaces — copy App.tsx's wiring faithfully (especially AlertModal's three variants and ConfirmDialog-rendered-last ordering).
- [ ] **Step 4: PASS; full suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileModals.tsx src/mobile/MobileModals.test.tsx src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): re-host signal-driven modals in the mobile shell"
```

---

### Task 8: Drawing tool strip (`MobileDrawBar`)

**Files:**
- Create: `src/mobile/MobileDrawBar.tsx`
- Modify: `src/mobile/MobileChartView.tsx` (render over the chart), `src/mobile/mobile.css`
- Test: `src/mobile/MobileDrawBar.test.tsx`

**Interfaces:**
- Consumes: `DRAW_TOOLS`, `toolLabel` from `../lib/drawTools`; glyphs from `../DrawIcons` (read its export shape first); `getSupportedOverlays` from `klinecharts`; `mobileChartCtx` from Task 6; `magnetSignal` from `../lib/magnet` (read `lib/magnet.ts` for the toggle's value shape); `drawingSettingsRequest`, `requestConfirm` from `../lib/signals`.
- Produces: `MobileDrawBar()` — a floating ✏️ FAB (bottom-right, above the tab bar). Tapping toggles a horizontal, scrollable tool strip. Behavior mirrors `DrawSidebar.arm()` (`DrawSidebar.tsx:225-249`):
  - filter tools by `getSupportedOverlays()` + `"recurringRange"`;
  - `timeRange`/`recurringRange` arm `controller.timeRangeArmed` / `controller.recurringHighlightArmed` signals;
  - everything else: `controller.overlays.addDrawing(name)`;
  - then `controller.focusChart?.()` and close the strip.
- Strip extras: a **magnet toggle** button (sets `magnetSignal` — muted gray when on, per toggle convention) and, when `controller.overlays.getSelectedDrawingId()` is non-null (poll via the overlays drawing listener — `setDrawingListener` is single-slot, so if ChartCore already occupies it, subscribe via a 500ms interval re-render instead; verify during implementation), an action row: **Edit** → `drawingSettingsRequest.set({ id })`, **Delete** → `requestConfirm({message: "Delete this drawing?", onConfirm: () => controller.overlays.remove(id)})` (verify the exact removal method name on OverlayManager — `remove(id)` per `App.tsx:2846`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/mobile/MobileDrawBar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("klinecharts", async (orig) => ({
  ...(await orig<object>()),
  getSupportedOverlays: () => ["segment", "rect", "horizontalStraightLine"],
}));

import MobileDrawBar from "./MobileDrawBar";
import { mobileChartCtx } from "./mobileChartState";

describe("MobileDrawBar", () => {
  const addDrawing = vi.fn();
  beforeEach(() => {
    addDrawing.mockClear();
    mobileChartCtx.set({
      chart: {},
      controller: {
        overlays: { addDrawing, getSelectedDrawingId: () => null },
        focusChart: vi.fn(),
      },
    } as never);
  });

  it("arms a tool through OverlayManager.addDrawing", async () => {
    render(<MobileDrawBar />);
    await userEvent.click(screen.getByRole("button", { name: "Draw" }));
    await userEvent.click(screen.getByRole("button", { name: "Trend line" }));
    expect(addDrawing).toHaveBeenCalledWith("segment");
  });

  it("hides tools klinecharts does not support", async () => {
    render(<MobileDrawBar />);
    await userEvent.click(screen.getByRole("button", { name: "Draw" }));
    expect(screen.queryByRole("button", { name: "Fib retracement" })).toBeNull();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** per Interfaces. FAB CSS: `position: absolute; right: 12px; bottom: 12px; z-index: 50;` inside `.m-body`; strip: full-width horizontal `overflow-x: auto` bar above the FAB.
- [ ] **Step 4: PASS; full suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileDrawBar.tsx src/mobile/MobileDrawBar.test.tsx src/mobile/MobileChartView.tsx src/mobile/mobile.css
git commit -m "feat(mobile): touch drawing tool strip with magnet toggle"
```

---

### Task 9: Indicators sheet (`MobileIndicatorsSheet`)

**Files:**
- Create: `src/mobile/MobileIndicatorsSheet.tsx`
- Modify: `src/mobile/MobileChartView.tsx` (wire the top-bar Indicators button), `src/mobile/mobile.css`
- Test: `src/mobile/MobileIndicatorsSheet.test.tsx`

**Interfaces:**
- Consumes: `mobileChartCtx`, `mobileSymbol`, `mobilePeriod`; `Sheet`; from `../lib/indicators`: `addIndicatorInstance`, `removeIndicatorById`, `isSubPaneIndicator`, `isInternalIndicator`, `isMintedInstanceId`; `getSupportedIndicators` from `klinecharts`; `indicatorInfo` from `../lib/indicatorMeta`; `saveIndicators` from `../lib/persist` (check export path — `persist/artifacts.ts:262` re-exported?); `EQUITY_INDICATOR` from `../lib/backtest`; `indicatorSettingsRequest` from `../lib/signals`.
- Produces: `MobileIndicatorsSheet({ onClose }: { onClose: () => void })`:
  - **Active list**: `controller.indicators.value` rows — label via `indicatorInfo(inst.type).title`, buttons **Settings** (`indicatorSettingsRequest.set({ paneId, name: inst.id, ... })` — match the desktop payload shape from wherever the legend fires it; grep `indicatorSettingsRequest.set` for a caller to copy) and **Remove**:

```ts
removeIndicatorById(chart, controller.scope, inst.id);
const next = controller.indicators.value.filter((i) => i.id !== inst.id);
controller.indicators.set(next);
saveIndicators(controller.scope, next);
```

  - **Add picker**: type list built exactly like `Toolbar.tsx:239-247` (filter `isMintedInstanceId`, `EQUITY_INDICATOR`, `"SLOPE_ACCEL"`, `"PIVOT_BARS_SINCE"`, `isInternalIndicator`) with a text filter; tapping a type runs the `addIndicator` flow from `Toolbar.tsx:280-296` (addIndicatorInstance → expand sub-panes if needed → mirror `controller.indicators` → `saveIndicators`; skip the AVWAP anchor-mode special case only if `avwapAnchorMode` isn't reachable — it is on the controller, so keep it).

- [ ] **Step 1: Write the failing test** — mock `../lib/indicators` (`addIndicatorInstance` returns `{id: "EMA1", type: "EMA"}`, `removeIndicatorById` a spy) and `klinecharts.getSupportedIndicators` → `["EMA", "RSI"]`; seed `mobileChartCtx` with a controller stub whose `indicators` is a real `Signal([])` and `scope: "mobile"`. Assert: tapping "EMA" calls `addIndicatorInstance` and the signal now holds the instance; with a pre-seeded instance, tapping Remove calls `removeIndicatorById` and empties the signal.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; full suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileIndicatorsSheet.tsx src/mobile/MobileIndicatorsSheet.test.tsx src/mobile/MobileChartView.tsx src/mobile/mobile.css
git commit -m "feat(mobile): indicators sheet (list, add, remove, settings)"
```

---

### Task 10: Alerts tab (`MobileAlertsView`)

**Files:**
- Create: `src/mobile/MobileAlertsView.tsx`
- Modify: `src/mobile/MobileApp.tsx`
- Test: `src/mobile/MobileAlertsView.test.tsx`

**Interfaces:**
- Consumes: from `../lib/alertsApi`: `loadAllAlerts`, `deleteStoredAlert`, `loadTriggered`, `CONDITION_LABELS`, types; `alertsChanged`, `bumpAlerts`, `alertGlobalEditRequest`, `alertModalRequest`, `requestConfirm` from `../lib/signals`; `fetchQuote` from `../lib/trading`; `mobileSymbol` from Task 6; `Sheet`.
- Produces: `MobileAlertsView()` with an Active/History segmented switch.
  - **Active**: rows from `loadAllAlerts(...)` (read its signature at `alertsApi.ts:282` — it takes broker; enumerate epics the way `AlertsSidebar.tsx` does — grep its `loadAllAlerts`/`loadAlerts` usage and copy). Row shows epic, `CONDITION_LABELS[condition]`, level, message. Tap → `alertGlobalEditRequest.set({ epic, savedId: a.id, precision })` (read the exact payload type at `signals.ts:56` and match; precision from the symbol if known, else 2 — copy how `AlertsSidebar` supplies it). Delete button → `requestConfirm` → `deleteStoredAlert(epic, id, broker)` + `bumpAlerts()`. Re-read the list on `alertsChanged`.
  - **History**: `loadTriggered()` rows newest-first: time (locale string), epic, price, message; when the payload carries a snapshot image URL render `<img>` (read `TriggeredAlert` at `alertsApi.ts:108` for the field — if none exists, render text-only and note it).
  - **Create**: a + button → if `mobileSymbol` set, fetch its quote (`fetchQuote`) and `alertModalRequest.set({ price: mid ?? 0 })`; Task 7's host renders the modal.
- [ ] **Step 1: Write the failing test** — mock `../lib/alertsApi` (`loadAllAlerts` returns two alerts across epics, `loadTriggered` returns one firing) and assert rows render; tapping delete fires `requestConfirm` (assert `confirmRequest.value` non-null); confirm-callback calls `deleteStoredAlert` and `bumpAlerts`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileAlertsView.tsx src/mobile/MobileAlertsView.test.tsx src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): alerts tab (active list, history, create/edit/delete)"
```

---

### Task 11: Positions tab (`MobilePositionsView`)

**Files:**
- Create: `src/mobile/MobilePositionsView.tsx`
- Modify: `src/mobile/MobileApp.tsx`
- Test: `src/mobile/MobilePositionsView.test.tsx`

**Interfaces:**
- Consumes: from `../lib/trading`: `subscribeTrades`, `refreshTrades`, `getTradesAccount`, `fetchAccountSummary`, `closePosition`, `cancelWorkingOrder`, `tradeLabel`, `isRealMoneyAccount`, types `TradeView`, `AccountSummary` (read `closePosition` at `trading.ts:589` and `cancelWorkingOrder` at `:773` for exact signatures before wiring); `requestConfirm` from `../lib/signals`; `Sheet`.
- Produces: `MobilePositionsView()`:
  - Header strip: account key + `AccountSummary` figures (balance / available / P&L) from `fetchAccountSummary(getTradesAccount())`; null summary → show "Paper account".
  - List: `subscribeTrades` rows — `tradeLabel(kind, side)`, epic, quantity, price level, stop/TP, uPnL colored ±. Tap row → detail `Sheet` with the same fields plus **Close position** / **Cancel order** button → `requestConfirm({message, onConfirm})` → `closePosition(...)` / `cancelWorkingOrder(...)` then `refreshTrades()`.
  - Real-money accounts: include `confirm: true`-style guards exactly as the desktop `PositionsPanel` does for close (grep `closePosition(` callers and copy the argument shape).
- [ ] **Step 1: Write the failing test** — mock `../lib/trading` (subscribeTrades immediately calls back with one position + one order; fetchAccountSummary resolves a summary; closePosition/cancelWorkingOrder spies) → rows render; tapping Close routes through `requestConfirm` and the confirm callback calls `closePosition`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobilePositionsView.tsx src/mobile/MobilePositionsView.test.tsx src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): positions tab (account summary, close/cancel)"
```

---

### Task 12: Trade tab (`MobileTradeView`)

**Files:**
- Create: `src/mobile/MobileTradeView.tsx`
- Modify: `src/mobile/MobileApp.tsx`, `src/mobile/mobile.css`
- Test: `src/mobile/MobileTradeView.test.tsx`

**Interfaces:**
- Consumes: desktop `OrderTicket` (props per `App.tsx:2732-2740`: `epic`, `account`, `precision`, `instrumentType`, `trading`, `accountSummary`, `replaying`); `mobileSymbol`; `getTradesAccount`, `fetchAccountSummary`, `isDataOnlyBroker`, `brokerOf` from `../lib/trading`; `loadSettings` from `../theme` (for `settings.trading`); `draftOrderSignal` from `../lib/signals` (OrderTicket already consumes the staged draft — verify by reading `OrderTicket.tsx`'s use of `draftOrderSignal`; if it does, no extra wiring beyond mounting).
- Produces: `MobileTradeView()` — renders `OrderTicket` full-width for `mobileSymbol` when set and the broker is tradeable (`!isDataOnlyBroker(brokerOf(getTradesAccount()))`); otherwise an explanatory empty state ("Pick a market on the Chart tab"). `accountSummary` fetched like Task 11. `replaying={false}`.
- CSS: make `.m-app .order-ticket` (or whatever OrderTicket's root class is — read the component) fill width with 16px padding.
- [ ] **Step 1: Write the failing test** — mock `../OrderTicket` → `<div data-testid="ticket" data-epic={p.epic} />`; with `mobileSymbol` set, ticket renders with the epic; with it null, the empty state shows.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileTradeView.tsx src/mobile/MobileTradeView.test.tsx src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): trade tab hosting the order ticket"
```

---

### Task 13: PWA — manifest, meta tags, app-shell cache, offline banner

**Files:**
- Create: `public/manifest.webmanifest`, `public/icons/icon-192.png`, `public/icons/icon-512.png` (generate from `public/favicon.svg` — `npx --yes sharp-cli` is NOT available (no new deps); instead use macOS `qlmanage`/`sips` or Python: `cd frontend && python3 -c "..."` with stdlib only won't rasterize SVG — simplest allowed path: render the SVG in Chrome via existing Playwright devDependency: write a tiny `scripts/gen-icons.mjs` using `playwright` (already a devDependency) that screenshots the SVG at 192/512 and saves PNGs; delete nothing).
- Modify: `index.html`, `public/alert-sw.js`, `src/mobile/MobileApp.tsx` (register SW + offline banner).
- Test: `src/lib/mobileBoot.test.ts` untouched; new `public/alert-sw.js` logic is exercised manually (service workers don't run under jsdom) — keep the SW diff minimal and reviewed.

**Steps:**

- [ ] **Step 1: Manifest**

```json
{
  "name": "Auto Trader",
  "short_name": "AutoTrader",
  "start_url": "/?m=1",
  "display": "standalone",
  "background_color": "#111318",
  "theme_color": "#111318",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

(Match `background_color`/`theme_color` to the dark theme's actual `--bg` value from `index.css`.)

- [ ] **Step 2: index.html** — add inside `<head>`:

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#111318" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

(The viewport line REPLACES the existing one.)

- [ ] **Step 3: Icons** — `scripts/gen-icons.mjs` with Playwright chromium: open a data-URL page containing the favicon SVG sized 512×512, screenshot to `public/icons/icon-512.png`, again at 192. Run it once, commit the PNGs AND the script.

- [ ] **Step 4: alert-sw.js app-shell cache** — append (keeping ALL existing push/notificationclick handlers untouched):

```js
// --- App-shell cache (mobile PWA; spec 2026-09-07-mobile-companion-design.md).
// Network-first for navigations with a cached fallback, cache-first for hashed
// /assets/ files. This SW must remain the ONLY root-scope SW (push lives here).
const SHELL_CACHE = "shell-v1";
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
```

- [ ] **Step 5: Register + offline banner** — in `MobileApp.tsx`'s bootstrap effect: `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/alert-sw.js").catch(() => {});` (same path `pushClient.ts:48` uses — read it and reuse its registration helper if one is exported). Add an offline banner: subscribe to `window` `online`/`offline` events; when offline render `<div className="m-offline">Offline — reconnecting…</div>` at the top of `.m-app`.

- [ ] **Step 6: Verify** — `npm run build` succeeds; `npx vitest run` green. Manual: `npm run dev`, open Chrome DevTools device mode at `http://localhost:5173/?m=1`, check manifest in Application tab, toggle offline and see the banner.

- [ ] **Step 7: Commit**

```bash
git add public/manifest.webmanifest public/icons/icon-192.png public/icons/icon-512.png scripts/gen-icons.mjs index.html public/alert-sw.js src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): PWA manifest, icons, app-shell cache, offline banner"
```

---

### Task 14: Notifications/settings sheet

**Files:**
- Create: `src/mobile/MobileSettingsSheet.tsx`
- Modify: `src/mobile/MobileApp.tsx` (a ⚙ button on the tab bar's far right opens it), `src/mobile/mobile.css`
- Test: `src/mobile/MobileSettingsSheet.test.tsx`

**Interfaces:**
- Consumes: `pushSupported`, `isSubscribed`, `subscribePush`, `unsubscribePush` from `../lib/pushClient`; `Sheet`; `loadSettings`, `saveSettings`, `applyThemeToDocument` from `../theme`.
- Produces: `MobileSettingsSheet({ onClose })`:
  - **Notifications**: if `pushSupported()`, a toggle reflecting `isSubscribed()` calling `subscribePush()`/`unsubscribePush()`; on iOS Safari NOT installed (`!window.matchMedia("(display-mode: standalone)").matches` and `navigator.userAgent` contains "iPhone|iPad"), show the hint: "On iOS, install this app to your home screen (Share → Add to Home Screen) to enable notifications."
  - **Theme**: light/dark/system selector writing through `saveSettings` + `applyThemeToDocument` (read how `Settings.tsx`/`AppearanceMenu.tsx` persist the theme field and copy the exact field name/values).
  - **Switch to desktop**: a button setting `localStorage["auto-trader.mobileBoot"]="0"` then `location.assign("/?m=0")`.
- [ ] **Step 1: Write the failing test** — mock `../lib/pushClient` (`pushSupported`→true, `isSubscribed`→resolves false, `subscribePush` spy): toggle renders unchecked, clicking calls `subscribePush`. Desktop-switch button sets the storage key (assert via `localStorage.getItem`; mock `location.assign` by `vi.stubGlobal`).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; suite green.**
- [ ] **Step 5: Commit**

```bash
git add src/mobile/MobileSettingsSheet.tsx src/mobile/MobileSettingsSheet.test.tsx src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): settings sheet (push, theme, switch to desktop)"
```

---

### Task 15: Final verification

**Files:** none new.

- [ ] **Step 1:** `cd frontend && npx vitest run` — everything green (existing + new).
- [ ] **Step 2:** `npx eslint src/mobile src/lib/mobileBoot.ts src/lib/mobileScope.ts src/chart/compactChrome.ts` — clean.
- [ ] **Step 3:** `npm run build` — succeeds.
- [ ] **Step 4:** Manual smoke via Chrome device emulation at `http://localhost:5173/?m=1` (dev server may already be running — check before starting another): chart loads on last-viewed market; period + symbol switch; add an indicator; arm a trend line and place it with two taps; create an alert; positions tab lists the paper book; trade tab shows the ticket; `?m=0` returns to desktop and desktop looks unchanged.
- [ ] **Step 5:** Report results honestly — anything not verified stays listed as unverified.
