# Mobile View Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mobile shell a chart-only mode in portrait and a landscape mode that rotates the real viewport, so the chart is not paying 12% of its height (23% in landscape) to app chrome.

**Architecture:** One pure state module (`mobileViewMode.ts`) owns two flags and drives the browser through an injected adapter, so the Fullscreen and Screen Orientation APIs (absent in jsdom, refusable on real devices) are testable and never load-bearing. `MobileApp` and `MobileChartView` subscribe and drop their chrome. Nothing rotates with CSS.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react + jsdom, the app's own `Signal` class (`lib/signals.ts`).

**Spec:** `docs/superpowers/specs/2026-09-11-mobile-chart-tools-design.md` (this plan implements Phase 1 only)

## Global Constraints

- Typecheck with `npx tsc -b` from `frontend/`. `npx tsc --noEmit` checks NOTHING here: the root `tsconfig.json` is a solution file with only `references`. `tsc -b` has a large pre-existing backlog, so the bar is zero errors *in the files you touched*.
- Run only the test files you touched: `npx vitest run <paths>`. Never the whole suite.
- No em dashes (`—`) or double hyphens (`--`) in UI copy. Split the sentence instead.
- Tooltips use the shared `Tooltip` / `InfoTip` components, never a native `title=`.
- Mobile tests open with `// @vitest-environment jsdom` and call `installMemStorage()` from `../lib/testMemStorage` before touching persistence.
- Every browser call added here is best-effort. A rejected promise is caught and ignored, and the resulting UI state must still be coherent.

---

### Task 1: The view-mode state machine

A pure module: two flags, an injected browser adapter, and the rules tying them together. No React, no DOM classes yet.

**Files:**
- Create: `frontend/src/mobile/mobileViewMode.ts`
- Test: `frontend/src/mobile/mobileViewMode.test.ts`

**Interfaces:**
- Consumes: `Signal` from `../lib/signals`; `load`, `saveLocal` from `../lib/persist/core`.
- Produces:
  - `interface ViewMode { chromeHidden: boolean; landscape: boolean }`
  - `const mobileViewMode: Signal<ViewMode>`
  - `interface ScreenAdapter { requestFullscreen(): Promise<void>; exitFullscreen(): Promise<void>; isFullscreen(): boolean; lockLandscape(): Promise<void>; unlockOrientation(): void; onFullscreenChange(fn: () => void): () => void }`
  - `function setScreenAdapter(a: ScreenAdapter): void`
  - `function setChromeHidden(on: boolean): Promise<void>`
  - `function setLandscape(on: boolean): Promise<void>`
  - `function initViewMode(): () => void`
  - `const MOBILE_CHROME_KEY = "auto-trader.mobileChromeHidden"`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/mobile/mobileViewMode.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import {
  MOBILE_CHROME_KEY,
  mobileViewMode,
  setChromeHidden,
  setLandscape,
  setScreenAdapter,
  initViewMode,
  type ScreenAdapter,
} from "./mobileViewMode";

installMemStorage();

// A fake browser. jsdom implements neither the Fullscreen nor the Screen
// Orientation API, and on a real device either call can be refused, so the
// adapter is the seam that makes both the happy and the refused path testable.
function fakeScreen(over: Partial<ScreenAdapter> = {}) {
  const calls: string[] = [];
  let full = false;
  let onChange: (() => void) | null = null;
  const a: ScreenAdapter & { calls: string[]; fire(): void } = {
    calls,
    async requestFullscreen() {
      calls.push("requestFullscreen");
      full = true;
    },
    async exitFullscreen() {
      calls.push("exitFullscreen");
      full = false;
    },
    isFullscreen: () => full,
    async lockLandscape() {
      calls.push("lockLandscape");
    },
    unlockOrientation() {
      calls.push("unlockOrientation");
    },
    onFullscreenChange(fn) {
      onChange = fn;
      return () => {
        onChange = null;
      };
    },
    fire() {
      onChange?.();
    },
    ...over,
  };
  setScreenAdapter(a);
  return a;
}

beforeEach(() => {
  localStorage.clear();
  mobileViewMode.set({ chromeHidden: false, landscape: false });
});
afterEach(() => vi.restoreAllMocks());

describe("mobileViewMode chrome-only", () => {
  it("hides and restores the chrome without touching the browser", async () => {
    const screen = fakeScreen();
    await setChromeHidden(true);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    await setChromeHidden(false);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    // Portrait chart-only is pure layout: no full screen, no orientation lock.
    expect(screen.calls).toEqual([]);
  });

  it("persists the chrome preference", async () => {
    fakeScreen();
    await setChromeHidden(true);
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).toBe("true");
  });
});

describe("mobileViewMode landscape", () => {
  it("goes full screen first, then locks, because Android Chrome requires that order", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    expect(screen.calls).toEqual(["requestFullscreen", "lockLandscape"]);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: true });
  });

  it("still hides the chrome when full screen is refused", async () => {
    const screen = fakeScreen({
      requestFullscreen: async () => {
        throw new Error("denied");
      },
    });
    await setLandscape(true);
    // The lock is still attempted: refusing full screen does not mean the
    // platform refuses the lock, and a failure there is equally survivable.
    expect(screen.calls).toContain("lockLandscape");
    expect(mobileViewMode.value.chromeHidden).toBe(true);
  });

  it("still hides the chrome when the orientation lock is refused (iOS Safari)", async () => {
    fakeScreen({
      lockLandscape: async () => {
        throw new Error("not supported");
      },
    });
    await setLandscape(true);
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: true });
  });

  it("unlocks before leaving full screen on the way out", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    screen.calls.length = 0;
    await setLandscape(false);
    expect(screen.calls).toEqual(["unlockOrientation", "exitFullscreen"]);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
  });

  it("does not persist landscape: full screen cannot be restored without a gesture", async () => {
    fakeScreen();
    await setLandscape(true);
    expect(localStorage.getItem(MOBILE_CHROME_KEY)).not.toBe("true");
  });

  it("restoring the chrome also leaves landscape, since landscape implies it", async () => {
    const screen = fakeScreen();
    await setLandscape(true);
    screen.calls.length = 0;
    await setChromeHidden(false);
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    expect(screen.calls).toEqual(["unlockOrientation", "exitFullscreen"]);
  });
});

describe("mobileViewMode full-screen lifecycle", () => {
  it("clears the mode when full screen goes away underneath it", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setLandscape(true);
    // The Android back gesture or Escape: the browser leaves full screen and
    // never tells us through our own call path.
    (screen as unknown as { isFullscreen: () => boolean }).isFullscreen = () => false;
    screen.fire();
    expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
    stop();
  });

  it("leaves a portrait chart-only session alone when full screen changes", async () => {
    const screen = fakeScreen();
    const stop = initViewMode();
    await setChromeHidden(true);
    screen.fire();
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
    stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/mobile/mobileViewMode.test.ts
```

Expected: FAIL, `Failed to resolve import "./mobileViewMode"`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/mobile/mobileViewMode.ts`:

```ts
// Mobile view modes (spec: 2026-09-11-mobile-chart-tools-design.md, Phase 1).
//
// Two flags. `chromeHidden` drops the top bar and the tab bar, worth about
// 94px of 764 in portrait. `landscape` additionally turns the REAL viewport
// sideways, where that same 94px would otherwise be 23% of the height.
//
// Rotation locks the viewport rather than transforming the shell with CSS: a
// rotated element's getBoundingClientRect() reports its axis-aligned box, which
// would invalidate every `clientX - rect.left` in the chart (27 call sites in
// our code, 2 more inside klinecharts, which we cannot patch).
import { Signal } from "../lib/signals";
import { load, saveLocal } from "../lib/persist/core";

export interface ViewMode {
  chromeHidden: boolean;
  landscape: boolean;
}

/** Only the chrome preference persists. A restored `landscape` would claim a
 *  state the device is not in: full screen cannot be re-entered on load
 *  without a user gesture. */
export const MOBILE_CHROME_KEY = "auto-trader.mobileChromeHidden";

export const mobileViewMode = new Signal<ViewMode>({
  chromeHidden: load<boolean>(MOBILE_CHROME_KEY, false),
  landscape: false,
});

/** The browser calls this module makes, behind a seam. jsdom implements
 *  neither API, and on a device either can be refused, so both the wiring and
 *  the refusal paths are testable only if they are injectable. */
export interface ScreenAdapter {
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  lockLandscape(): Promise<void>;
  unlockOrientation(): void;
  onFullscreenChange(fn: () => void): () => void;
}

const domScreen: ScreenAdapter = {
  requestFullscreen: () => document.documentElement.requestFullscreen(),
  exitFullscreen: () => document.exitFullscreen(),
  isFullscreen: () => document.fullscreenElement != null,
  lockLandscape: async () => {
    // Typed loosely: lock() is absent from lib.dom in some TS versions and
    // absent from Safari at runtime.
    const o = screen.orientation as unknown as { lock?: (s: string) => Promise<void> };
    if (!o?.lock) throw new Error("orientation lock unsupported");
    await o.lock("landscape");
  },
  unlockOrientation: () => {
    const o = screen.orientation as unknown as { unlock?: () => void };
    o?.unlock?.();
  },
  onFullscreenChange: (fn) => {
    document.addEventListener("fullscreenchange", fn);
    return () => document.removeEventListener("fullscreenchange", fn);
  },
};

let adapter: ScreenAdapter = domScreen;

export function setScreenAdapter(a: ScreenAdapter): void {
  adapter = a;
}

/** Every browser call here is best-effort: a refusal must still leave a
 *  coherent mode, never a half-applied one. */
async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    /* refused: the mode applies whatever it achieved */
  }
}

export async function setChromeHidden(on: boolean): Promise<void> {
  // Landscape implies hidden chrome, so restoring the chrome leaves landscape.
  if (!on && mobileViewMode.value.landscape) {
    await setLandscape(false);
    return;
  }
  saveLocal(MOBILE_CHROME_KEY, on);
  mobileViewMode.set({ ...mobileViewMode.value, chromeHidden: on });
}

export async function setLandscape(on: boolean): Promise<void> {
  if (on) {
    // Full screen FIRST: Android Chrome refuses an orientation lock outside it.
    await attempt(() => adapter.requestFullscreen());
    await attempt(() => adapter.lockLandscape());
    mobileViewMode.set({ chromeHidden: true, landscape: true });
    return;
  }
  await attempt(() => adapter.unlockOrientation());
  await attempt(() => adapter.exitFullscreen());
  mobileViewMode.set({ chromeHidden: false, landscape: false });
}

/** Watch for full screen ending outside our control (the Android back gesture,
 *  Escape). Returns an unsubscribe. */
export function initViewMode(): () => void {
  return adapter.onFullscreenChange(() => {
    if (!mobileViewMode.value.landscape) return;
    if (adapter.isFullscreen()) return;
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/mobile/mobileViewMode.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Check the tests bite**

Break the implementation on purpose and confirm the suite catches it. Swap the two calls in `setLandscape` so the lock precedes full screen, re-run, and expect the "goes full screen first" test to fail. Put the order back and confirm green again. A test that does not fail when the behaviour it names is broken is not a test.

- [ ] **Step 6: Typecheck and commit**

```bash
cd frontend && npx tsc -b 2>&1 | grep -E "^src/mobile/mobileViewMode"
git add frontend/src/mobile/mobileViewMode.ts frontend/src/mobile/mobileViewMode.test.ts
git commit -m "feat(mobile): view-mode state machine for chart-only and landscape"
```

Expected from the grep: no output.

---

### Task 2: Drop the chrome

The shell and the chart view stop rendering their furniture when `chromeHidden` is set, and a floating control brings it back. No controls to enter the mode yet: that is Task 3, and keeping them apart means this task is reviewable on its own by driving the signal directly.

**Files:**
- Modify: `frontend/src/mobile/MobileApp.tsx` (the `<nav className="m-tabbar">` block)
- Modify: `frontend/src/mobile/MobileChartView.tsx` (the `.m-chart-topbar` block and `<MobileChartStrip />`)
- Modify: `frontend/src/mobile/mobile.css`
- Test: `frontend/src/mobile/MobileApp.test.tsx`, `frontend/src/mobile/MobileChartView.test.tsx`

**Interfaces:**
- Consumes: `mobileViewMode`, `setChromeHidden` from Task 1.
- Produces: a restore control with `aria-label="Show controls"`, rendered by `MobileChartView` whenever `chromeHidden` is set.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/mobile/MobileChartView.test.tsx`:

```ts
describe("MobileChartView chrome-only mode", () => {
  beforeEach(() => {
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });

  it("drops the top bar and the chart strip when the chrome is hidden", async () => {
    const { container } = render(<MobileChartView />);
    expect(container.querySelector(".m-chart-topbar")).not.toBeNull();
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    expect(container.querySelector(".m-chart-topbar")).toBeNull();
  });

  it("leaves one way back: a restore control", async () => {
    render(<MobileChartView />);
    expect(screen.queryByLabelText("Show controls")).toBeNull();
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    await userEvent.click(screen.getByLabelText("Show controls"));
    expect(mobileViewMode.value.chromeHidden).toBe(false);
  });
});
```

Append to `frontend/src/mobile/MobileApp.test.tsx`:

```ts
describe("MobileApp chrome-only mode", () => {
  beforeEach(() => {
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });

  it("drops the tab bar when the chrome is hidden", async () => {
    const { container } = render(<MobileApp />);
    await waitFor(() => expect(container.querySelector(".m-tabbar")).not.toBeNull());
    await act(async () => {
      mobileViewMode.set({ chromeHidden: true, landscape: false });
    });
    expect(container.querySelector(".m-tabbar")).toBeNull();
  });
});
```

Add `import { mobileViewMode } from "./mobileViewMode";` to both test files, and make sure `act`, `waitFor`, `screen` and `userEvent` are imported (follow whichever of those each file already imports).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/mobile/MobileChartView.test.tsx src/mobile/MobileApp.test.tsx
```

Expected: FAIL. The chart-view tests fail on `expected null not to be null` for the removed nodes, or on the missing "Show controls" label.

- [ ] **Step 3: Implement**

In `MobileChartView.tsx`, subscribe near the other `useSyncExternalStore` calls:

```tsx
const viewMode = useSyncExternalStore(
  (fn) => mobileViewMode.subscribe(fn),
  () => mobileViewMode.value,
);
```

Wrap the top bar and the strip, and add the restore control. (The strip has no
assertion of its own: `MobileChartStrip` renders null without a mirrored
layout, so a "it is gone now" check would pass without the change and prove
nothing. The top bar carries the test.) The control lives inside `.m-chart-body` so it floats over the chart, and it sits top-left because the bottom-right corner is already the drawing FAB's:

```tsx
{!viewMode.chromeHidden && (
  <div className="m-chart-topbar">
    {/* unchanged */}
  </div>
)}
{!viewMode.chromeHidden && <MobileChartStrip />}
<div className="m-chart-body">
  {viewMode.chromeHidden && (
    <button
      className="m-chart-restore"
      aria-label="Show controls"
      onClick={() => void setChromeHidden(false)}
    >
      ⤢
    </button>
  )}
  {/* unchanged */}
</div>
```

Import `mobileViewMode` and `setChromeHidden` from `./mobileViewMode`.

In `MobileApp.tsx`, subscribe the same way and gate the nav:

```tsx
{!viewMode.chromeHidden && (
  <nav className="m-tabbar">
    {/* unchanged */}
  </nav>
)}
```

In `mobile.css`, after the `.m-chart-body` rule:

```css
/* Chart-only mode: the one way back. Top-left, because bottom-right is the
   drawing FAB's corner and the right edge now carries the trade pills. */
.m-chart-restore {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 60;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: var(--panel-bg, rgba(128, 128, 128, 0.35));
  color: var(--text);
  font-size: 15px;
  line-height: 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/mobile/MobileChartView.test.tsx src/mobile/MobileApp.test.tsx
```

Expected: PASS, with every pre-existing test in both files still green.

- [ ] **Step 5: Typecheck and commit**

```bash
cd frontend && npx tsc -b 2>&1 | grep -E "^src/mobile/(MobileApp|MobileChartView)"
git add frontend/src/mobile/MobileApp.tsx frontend/src/mobile/MobileChartView.tsx frontend/src/mobile/mobile.css frontend/src/mobile/MobileApp.test.tsx frontend/src/mobile/MobileChartView.test.tsx
git commit -m "feat(mobile): hide the shell chrome in chart-only mode"
```

Expected from the grep: no output.

---

### Task 3: The controls, and the full-screen lifecycle

Two chips in the top bar to enter the modes, and the `fullscreenchange` subscription wired into the app's lifetime so an Android back gesture out of full screen tears the mode down instead of stranding it.

**Files:**
- Modify: `frontend/src/mobile/MobileChartView.tsx` (top bar)
- Modify: `frontend/src/mobile/MobileApp.tsx` (a mount effect)
- Test: `frontend/src/mobile/MobileChartView.test.tsx`, `frontend/src/mobile/MobileApp.test.tsx`

**Interfaces:**
- Consumes: `setChromeHidden`, `setLandscape`, `initViewMode`, `setScreenAdapter`, `mobileViewMode` from Task 1; the restore control from Task 2.
- Produces: nothing further tasks depend on. This closes Phase 1.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/mobile/MobileChartView.test.tsx`:

```ts
describe("MobileChartView view-mode controls", () => {
  beforeEach(() => {
    mobileViewMode.set({ chromeHidden: false, landscape: false });
  });

  it("hides the chrome from the chart-only control", async () => {
    render(<MobileChartView />);
    // Both chips live inside the `booted` guard, and boot resolves a heartbeat
    // from storage asynchronously, so wait for the chart the way the existing
    // tests in this file do.
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("Chart only"));
    expect(mobileViewMode.value).toEqual({ chromeHidden: true, landscape: false });
  });

  it("enters landscape from the landscape control", async () => {
    const calls: string[] = [];
    setScreenAdapter({
      requestFullscreen: async () => void calls.push("requestFullscreen"),
      exitFullscreen: async () => void calls.push("exitFullscreen"),
      isFullscreen: () => true,
      lockLandscape: async () => void calls.push("lockLandscape"),
      unlockOrientation: () => void calls.push("unlockOrientation"),
      onFullscreenChange: () => () => {},
    });
    render(<MobileChartView />);
    await waitFor(() => expect(screen.getByTestId("chartcore")).toBeTruthy());
    await userEvent.click(screen.getByLabelText("Landscape"));
    expect(calls).toEqual(["requestFullscreen", "lockLandscape"]);
    expect(mobileViewMode.value.landscape).toBe(true);
  });
});
```

Append to `frontend/src/mobile/MobileApp.test.tsx`:

```ts
it("watches for full screen ending outside the app", async () => {
  let onChange: (() => void) | null = null;
  setScreenAdapter({
    requestFullscreen: async () => {},
    exitFullscreen: async () => {},
    isFullscreen: () => false,
    lockLandscape: async () => {},
    unlockOrientation: () => {},
    onFullscreenChange: (fn) => {
      onChange = fn;
      return () => {
        onChange = null;
      };
    },
  });
  render(<MobileApp />);
  await waitFor(() => expect(onChange).not.toBeNull());
  await act(async () => {
    mobileViewMode.set({ chromeHidden: true, landscape: true });
    onChange!();
  });
  expect(mobileViewMode.value).toEqual({ chromeHidden: false, landscape: false });
});
```

Add `setScreenAdapter` to the `./mobileViewMode` imports in both test files.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/mobile/MobileChartView.test.tsx src/mobile/MobileApp.test.tsx
```

Expected: FAIL, `Unable to find a label with the text of: Chart only`, and the `MobileApp` test failing on `expected null not to be null` because nothing subscribed.

- [ ] **Step 3: Implement**

In `MobileChartView.tsx`, add both chips to the top bar after the Indicators chip, inside the same `booted &&` guard the period and indicator chips use:

```tsx
{booted && (
  <button
    className="m-chart-viewmode"
    aria-label="Chart only"
    onClick={() => void setChromeHidden(true)}
  >
    ⤢
  </button>
)}
{booted && (
  <button
    className="m-chart-viewmode"
    aria-label="Landscape"
    onClick={() => void setLandscape(true)}
  >
    ⟳
  </button>
)}
```

Import `setLandscape` alongside the Task 2 imports. `.m-chart-viewmode` needs no CSS of its own: `.m-chart-topbar button` already styles it.

In `MobileApp.tsx`, subscribe for the app's lifetime, next to the existing service-worker effect:

```tsx
useEffect(() => initViewMode(), []);
```

Import `initViewMode` from `./mobileViewMode`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/mobile/MobileChartView.test.tsx src/mobile/MobileApp.test.tsx src/mobile/mobileViewMode.test.ts
```

Expected: PASS across all three files.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd frontend && npx tsc -b 2>&1 | grep -E "^src/mobile/"
npx eslint src/mobile/MobileApp.tsx src/mobile/MobileChartView.tsx src/mobile/mobileViewMode.ts
git add frontend/src/mobile/MobileApp.tsx frontend/src/mobile/MobileChartView.tsx frontend/src/mobile/MobileApp.test.tsx frontend/src/mobile/MobileChartView.test.tsx
git commit -m "feat(mobile): chart-only and landscape controls"
```

Expected: no output from the grep, no errors from eslint.

- [ ] **Step 6: Verify on the device**

None of this can be proved in jsdom, which has neither API. On a connected Android phone:

```bash
adb reverse tcp:5173 tcp:5173 && adb reverse tcp:8000 tcp:8000
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

Both reverses are required. Without the second, the app mounts no chart at all and shows a blank pane, because every `/api` call and the `/ws/state` socket fail.

Check, in order:

1. The chart-only chip hides the top bar, the strip and the tab bar, and the restore control brings them back.
2. The landscape chip rotates the device view and enters full screen.
3. In landscape, the crosshair, a trade-line drag and a pill tap all still land where you touch. This is the point of locking the viewport instead of rotating with CSS, and it is the one thing no unit test covers.
4. The Android back gesture out of full screen returns to portrait with the chrome restored, not to a stranded landscape flag.

---

## What this plan does not cover

Phases 2 to 4 of the spec (the Tools sheet, Template, Measure, Backtest, Replay) each get their own plan. Phase 1 stands alone: it ships a usable improvement and nothing later depends on its internals beyond the `mobileViewMode` signal.
