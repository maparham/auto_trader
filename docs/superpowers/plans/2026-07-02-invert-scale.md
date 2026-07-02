# Invert Chart Scale (Option+I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TradingView-style invert scale — Option+I (Alt+I) flips the focused chart's price axis upside down; a toolbar "I" button next to A / L shows and toggles the same state. Session-only, candle pane only.

**Architecture:** A new per-cell `invertScale` Signal on `ChartController` is the single source of truth (same pattern as `autoScale`). ChartCore subscribes and applies `chart.setStyles({ yAxis: { reverse } })` — klinecharts 9.8.12 natively supports `yAxis.reverse` and applies it to the candle pane only, and its coordinate conversion honors it so drawings/alert lines/custom overlays flip for free. The keyboard shortcut lives in ChartCore's existing per-cell `onKeyDown`; a tiny pure predicate `isInvertShortcut` handles the macOS dead-key quirk (Option+I gives `e.key === "Dead"`, so match `e.code === "KeyI"`).

**Tech Stack:** React 19, klinecharts 9.8.12, vitest (unit), Playwright (e2e).

## Global Constraints

- Session-only: inversion is NEVER persisted (no localStorage writes, no persist.ts changes).
- Shortcut acts on the focused cell only (per-cell handler, not a window listener).
- No backward-compat/migration code.
- Working dir for all commands: `/Users/mahmoudparham/auto_trader/frontend`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016dn6dShwmmchyBm1wmrmSB`

---

### Task 1: Shortcut predicate + controller signal

**Files:**
- Create: `frontend/src/lib/invertShortcut.ts`
- Test: `frontend/src/lib/invertShortcut.test.ts`
- Modify: `frontend/src/lib/chartController.ts` (add signal after `autoScale`, ~line 44)

**Interfaces:**
- Produces: `isInvertShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): boolean` — Task 2 imports it from `./lib/invertShortcut`.
- Produces: `ChartController.invertScale: Signal<boolean>` (initial `false`) — Tasks 2 and 3 read/set/subscribe it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/invertShortcut.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isInvertShortcut } from "./invertShortcut";

const ev = (over: Partial<Parameters<typeof isInvertShortcut>[0]> = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "KeyI",
  ...over,
});

describe("isInvertShortcut", () => {
  it("matches plain Alt/Option + I by physical key code", () => {
    expect(isInvertShortcut(ev())).toBe(true);
  });
  it("matches on code so the macOS dead-key (key='Dead') still works", () => {
    // e.key is irrelevant by design — the predicate never reads it.
    expect(isInvertShortcut(ev({ code: "KeyI" }))).toBe(true);
  });
  it("rejects other keys", () => {
    expect(isInvertShortcut(ev({ code: "KeyL" }))).toBe(false);
  });
  it("rejects when Alt is not held", () => {
    expect(isInvertShortcut(ev({ altKey: false }))).toBe(false);
  });
  it("rejects extra modifiers (Ctrl / Cmd / Shift chords are other shortcuts)", () => {
    expect(isInvertShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isInvertShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isInvertShortcut(ev({ shiftKey: true }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run test:unit -- src/lib/invertShortcut.test.ts`
Expected: FAIL — cannot resolve `./invertShortcut`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/invertShortcut.ts`:

```ts
// TradingView's "invert scale" shortcut is Alt+I (Option+I on Mac). On macOS,
// Option+I is a DEAD KEY (circumflex accent): e.key comes through as "Dead",
// never "i" — so the match uses the physical e.code instead. Plain Alt only:
// Ctrl/Cmd/Shift chords belong to other shortcuts.
export function isInvertShortcut(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyI";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run test:unit -- src/lib/invertShortcut.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the signal to ChartController**

In `frontend/src/lib/chartController.ts`, directly after the `autoScale` declaration (line 44), add:

```ts
  // TradingView-style "invert scale" (Alt/Option+I + toolbar "I" button): flips
  // the candle-pane price axis via yAxis.reverse. Session-only — never persisted.
  readonly invertScale = new Signal<boolean>(false);
```

- [ ] **Step 6: Verify types compile and full unit suite passes**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run build && npm --prefix /Users/mahmoudparham/auto_trader/frontend run test:unit`
Expected: build OK, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/mahmoudparham/auto_trader add frontend/src/lib/invertShortcut.ts frontend/src/lib/invertShortcut.test.ts frontend/src/lib/chartController.ts
git -C /Users/mahmoudparham/auto_trader commit -m "feat(chart): invertScale signal + Option+I shortcut predicate"
```

---

### Task 2: ChartCore — apply the signal to the chart + bind the shortcut

**Files:**
- Modify: `frontend/src/ChartCore.tsx`
  - destructure block ~line 518-529
  - an effect near the other signal effects (~line 1066 area)
  - `onKeyDown` handler at ~line 4110

**Interfaces:**
- Consumes: `isInvertShortcut` from `./lib/invertShortcut`; `controller.invertScale` from Task 1.
- Produces: pressing Option+I on a focused cell toggles the signal; any change to the signal (from here or the toolbar) re-styles the chart.

- [ ] **Step 1: Import the predicate**

In `frontend/src/ChartCore.tsx`, alongside the other `./lib/` imports at the top of the file:

```ts
import { isInvertShortcut } from "./lib/invertShortcut";
```

- [ ] **Step 2: Destructure the signal**

In the `const { ... } = controller;` block (~line 518), add `invertScale` after `autoScale`:

```ts
  const {
    overlays,
    avwapAnchorMode,
    autoScale,
    invertScale,
    scalePriceOnly,
    measureArmed,
    selectedIndicator,
    legendHovered,
    legendHoverName,
    curveHover,
    indicatorRemoved,
  } = controller;
```

- [ ] **Step 3: Apply signal changes to the chart**

Near the `scalePriceOnly.subscribe` effect (~line 1066), add:

```ts
  // Invert scale (Alt/Option+I or the toolbar "I" button): push the flip onto the
  // live chart. Candle pane only — klinecharts' YAxisImp.isReverse() ignores
  // yAxis.reverse for sub-panes. Session-only, so no initial apply is needed
  // (the signal is always false at mount) — just react to later flips. Theme
  // changes deep-merge styles via klineStyles() (which never sets reverse), so
  // an active inversion survives them.
  useEffect(
    () =>
      invertScale.subscribe((reverse) => {
        chartRef.current?.setStyles({ yAxis: { reverse } });
      }),
    [invertScale],
  );
```

- [ ] **Step 4: Bind the shortcut in onKeyDown**

In the `onKeyDown` handler (~line 4135), after the Delete/Backspace branch and BEFORE `const mod = e.ctrlKey || e.metaKey;`, add:

```ts
        // Alt/Option+I: TV-style invert scale (flip the price axis upside down).
        if (isInvertShortcut(e)) {
          invertScale.set(!invertScale.value);
          e.preventDefault();
          return;
        }
```

- [ ] **Step 5: Verify build + lint**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run build && npm --prefix /Users/mahmoudparham/auto_trader/frontend run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git -C /Users/mahmoudparham/auto_trader add frontend/src/ChartCore.tsx
git -C /Users/mahmoudparham/auto_trader commit -m "feat(chart): Option+I inverts the focused chart's price scale"
```

---

### Task 3: Toolbar "I" toggle button

**Files:**
- Modify: `frontend/src/Toolbar.tsx` (state ~line 151-156; button block ~line 567-583)

**Interfaces:**
- Consumes: `controller.invertScale` (Task 1). `controller` is already a prop and may be null (blank workspace) — mirror the existing `auto` handling exactly.

- [ ] **Step 1: Mirror the signal into toolbar state**

In `frontend/src/Toolbar.tsx`, directly after the `auto` state + subscription (lines 151-156), add:

```ts
  // "I" invert-scale mode (mirrors the focused cell's signal; on = highlighted).
  const [inverted, setInverted] = useState(controller?.invertScale.value ?? false);
  useEffect(() => {
    if (!controller) return;
    setInverted(controller.invertScale.value);
    return controller.invertScale.subscribe(setInverted);
  }, [controller]);
```

- [ ] **Step 2: Add the button**

In the price-scale block, after the `L` button (line 582) inside `<div className="scale">`, add:

```tsx
        <button
          title="Invert scale (Option+I)"
          className={inverted ? "on" : ""}
          onClick={() => controller?.invertScale.set(!controller.invertScale.value)}
        >
          I
        </button>
```

Also update the block comment above the div: `{/* Price-scale A / L / I (auto-fit, logarithmic, invert) */}`.

- [ ] **Step 3: Verify build + lint**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run build && npm --prefix /Users/mahmoudparham/auto_trader/frontend run lint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git -C /Users/mahmoudparham/auto_trader add frontend/src/Toolbar.tsx
git -C /Users/mahmoudparham/auto_trader commit -m "feat(toolbar): invert-scale toggle button next to A/L"
```

---

### Task 4: Playwright e2e

**Files:**
- Create: `frontend/e2e/invert-scale.spec.ts`

**Interfaces:**
- Consumes: `seedSingleChartDefault`, `stubStateApi` from `./helpers`; the `window.__chart` handle ChartCore exposes; the Task 2 shortcut and Task 3 button.

- [ ] **Step 1: Write the e2e test**

Create `frontend/e2e/invert-scale.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// TV-style invert scale: Option/Alt+I flips the candle-pane price axis (rising
// prices draw downward), the toolbar "I" button lights up and toggles the same
// state, and a second Alt+I restores the normal axis. Session-only by design —
// nothing is persisted, so no storage assertions here.

// 400 hourly bars, close rising 100 -> 499 (open=close, tight high/low band).
function trendCandles(): string {
  const base = Date.UTC(2024, 0, 1);
  const rows = Array.from({ length: 400 }, (_, i) => {
    const close = 100 + i;
    return {
      timestamp: base + i * 3600_000,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000,
    };
  });
  return JSON.stringify(rows);
}

type Chart = {
  getSize: (paneId: string, position: string) => { width: number; height: number } | null;
  convertFromPixel: (
    points: Array<{ y: number }>,
    opts: { paneId: string },
  ) => Array<{ value: number }>;
};

// Price at the pane's top pixel minus price at its bottom pixel: positive on a
// normal axis (top = high), negative once the scale is inverted (top = low).
function topMinusBottom(page: Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: Chart }).__chart;
    if (!c) return null;
    const size = c.getSize("candle_pane", "main");
    if (!size) return null;
    const top = c.convertFromPixel([{ y: 1 }], { paneId: "candle_pane" })[0]?.value;
    const bot = c.convertFromPixel([{ y: size.height - 1 }], { paneId: "candle_pane" })[0]?.value;
    if (top == null || bot == null) return null;
    return top - bot;
  });
}

test("Option+I inverts the price scale; the toolbar I button mirrors and toggles it", async ({
  page,
}) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: trendCandles() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  // Candles loaded: the visible span is a real number.
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);

  const invertBtn = page.locator(".scale button", { hasText: /^I$/ });
  await expect(invertBtn).not.toHaveClass(/\bon\b/);

  // Focus the cell (the shortcut is per-cell), then Alt+I. Playwright's "KeyI"
  // targets the physical key — same reason the app matches e.code (macOS
  // Option+I is a dead key).
  await page.locator(".chart-wrap").first().click();
  await page.keyboard.press("Alt+KeyI");

  // Inverted: the top of the pane now reads the LOW price; the button lights up.
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeLessThan(0);
  await expect(invertBtn).toHaveClass(/\bon\b/);

  // Second Alt+I restores the normal axis.
  await page.keyboard.press("Alt+KeyI");
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);
  await expect(invertBtn).not.toHaveClass(/\bon\b/);

  // The toolbar button drives the same state.
  await invertBtn.click();
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeLessThan(0);
  await expect(invertBtn).toHaveClass(/\bon\b/);
  await invertBtn.click();
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);
  await expect(invertBtn).not.toHaveClass(/\bon\b/);
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx playwright test e2e/invert-scale.spec.ts`
Expected: 1 passed. (If it fails on the keypress: verify with `--headed` that the chart wrap has focus after the click; the click must land on the chart canvas area, not a legend card.)

- [ ] **Step 3: Run the full unit suite once more**

Run: `npm --prefix /Users/mahmoudparham/auto_trader/frontend run test:unit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/mahmoudparham/auto_trader add frontend/e2e/invert-scale.spec.ts
git -C /Users/mahmoudparham/auto_trader commit -m "test(e2e): Option+I invert scale + toolbar toggle"
```
