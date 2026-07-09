import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// Per-symbol templates: saving a cell's layout (indicators + drawings) for a symbol
// and opening a NEW tab on that SAME symbol must auto-apply the saved layout. This
// is the primary scenario behind the feature ("my NAS100 setup follows NAS100").
//
// A new tab opens on the DEFAULT symbol (App.addTab) — the same symbol the first
// tab starts on — so we can verify auto-apply without driving the symbol-search
// modal: save on tab 1, open tab 2 (same default symbol), assert the layout appears.

type IndMap = Map<string, Map<string, { name: string }>>;

// Active indicator TYPE names on the focused chart, read from klinecharts directly
// (the menu shows no active-state). Mirrors tab-indicators.spec.ts.
async function activeTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const c = (window as unknown as {
      __chart?: { getIndicatorByPaneId: () => IndMap };
    }).__chart;
    if (!c) return [];
    const out: string[] = [];
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values()) out.push(ind.name);
    return out;
  });
}

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  const open = async () => {
    if (!(await dropdown.isVisible())) await indBtn.click();
    await expect(dropdown).toBeVisible();
  };
  const close = async () => {
    if (await dropdown.isVisible()) await indBtn.click();
    await expect(dropdown).toBeHidden();
  };
  const row = (code: string) =>
    dropdown.locator("li.ind-row", {
      hasText: new RegExp(`\\(${code}\\)$|^${code}$`),
    });
  const add = async (name: string) => {
    await open();
    await dropdown.locator("input").fill(name);
    await row(name).first().click();
    await close();
  };
  return { add };
}

// Wait until the focused chart has loaded candles (drawings/indicators need data).
async function waitForData(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as {
            __chart?: { getDataList(): unknown[] };
          }).__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
}

// Drawing count for the FOCUSED tab's primary cell scope, from storage.
//
// NOTE: this test seeds via seedSingleChartDefault (bare `auto-trader.layout.*`
// keys), but persist.ts's per-broker workspace isolation (see its header comment)
// means resolveStartup() no longer reads those — workspace roots are broker-scoped
// (`auto-trader.b.<broker>.*`). With no per-broker layout/default present, the app
// falls back to its own default single-chart workspace and persists live edits to
// the device-local per-broker SCRATCH key. Read the active tab from there instead
// of the legacy (now-pruned) `activeLayoutId`/`layout.<id>` keys — same fix already
// applied in detach-cell.spec.ts's readActiveScratchTab.
async function focusedDrawingCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const k = Object.keys(localStorage).find((key) => /^auto-trader\.b\.[^.]+\.scratch$/.test(key));
    const body = k ? JSON.parse(localStorage.getItem(k) || "null") : null;
    const tabs = body?.tabs ?? [];
    const active = body?.activeTabId || tabs[0]?.id || "";
    const tab = tabs.find((t: { id: string }) => t.id === active);
    // After a reload the workspace may not be re-persisted yet — signal "not ready"
    // with -1 so the caller's expect.poll keeps waiting instead of throwing.
    if (!tab) return -1;
    const cell = tab.cells.find((c: { id: string }) => c.id === tab.activeCellId);
    if (!cell) return -1;
    const epic = cell.symbol.epic;
    const raw = localStorage.getItem(`auto-trader.${cell.scope}.drawings.${epic}`);
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  });
}

// Indicator TYPE names stored in the (per-broker) symbol template, read from storage.
// Empty array when no template exists yet.
async function templateIndicatorTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const k = Object.keys(localStorage).find((key) =>
      /^auto-trader\.b\.[^.]+\.template\./.test(key),
    );
    if (!k) return [];
    const t = JSON.parse(localStorage.getItem(k) || "null");
    return (t?.indicators ?? []).map((i: { type: string }) => i.type);
  });
}

// Auto-save is a global app setting (Settings → General). The engine reads it live
// from the `auto-trader.settings` blob on each debounced save, so flipping the
// stored flag directly is enough to gate the next auto-save — no UI needed.
async function setAutoSave(page: Page, on: boolean) {
  await page.evaluate((val) => {
    const KEY = "auto-trader.settings";
    const cur = JSON.parse(localStorage.getItem(KEY) || "{}");
    localStorage.setItem(KEY, JSON.stringify({ ...cur, autoSaveTemplates: val }));
  }, on);
}

test("a saved symbol template auto-applies to a new tab on the same symbol", async ({
  page,
}) => {
  // Isolate from the shared backend workspace: hydrateFromBackend() overwrites
  // localStorage with the backend snapshot on load (and other devs'/runs' tabs
  // accumulate there), which would pollute this test. Stub the state API to an empty
  // workspace so we start from a clean, deterministic single default tab. (The
  // candle/live feeds are left real — the chart still needs data.)
  await page.route("**/api/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  // --- Build a layout on tab 1: add EMA + draw a horizontal line. ---
  const m = indicatorMenu(page);
  await m.add("EMA");
  await expect.poll(() => activeTypes(page)).toContain("EMA");

  const canvas = page.locator(".chart-cell").first().locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  // Tools now live in the left draw sidebar (Lines family flyout).
  const lines = page.locator(".draw-sidebar .ds-family").first();
  await lines.hover();
  await lines.locator(".ds-caret").click();
  await page
    .locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" })
    .click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);

  // --- Auto-save (on by default) writes the symbol's template in the background,
  // ~800ms after the edits settle — no manual Save. Stored per-broker
  // (`auto-trader.b.<broker>.template.<epic>`, see persist.ts's workspace-isolation
  // header). Wait until EMA lands in it. ---
  await expect
    .poll(() => templateIndicatorTypes(page), { timeout: 5000 })
    .toContain("EMA");

  // --- Open a NEW tab (same default symbol) → auto-apply should fire. ---
  await page.locator(".tab-add").click();
  await expect(page.locator(".tab-bar [role=tab]")).toHaveCount(2);
  // A new tab pops the symbol-search modal (TV-style). Dismiss it with Escape so the
  // tab keeps the DEFAULT symbol (same as tab 1) — the case auto-apply targets.
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal.symsearch")).toBeHidden();
  // The new tab's chart becomes the focused __chart; wait for its data, then assert
  // the template layout materialised onto this fresh cell.
  await waitForData(page);
  await expect.poll(() => activeTypes(page)).toContain("EMA");
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);

  // --- The fresh cell now owns the layout (persisted into its own scope), so a
  // reload keeps it and does NOT double-apply (gate sees a non-empty cell). ---
  await page.reload();
  await page.locator(".chart-cell").first().waitFor();
  await waitForData(page);
  await expect.poll(() => activeTypes(page)).toContain("EMA");
  await expect.poll(() => focusedDrawingCount(page)).toBe(1); // not 2
});

test("manual Apply merges into a populated chart — keeps drawings, no duplicate indicators", async ({
  page,
}) => {
  await page.route("**/api/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  // --- Auto-save captures a template containing just EMA (no drawings). Then turn
  // auto-save OFF so the later divergence (RSI + line) does NOT update the template
  // — the merge below must apply an EMA-only, drawing-free template. ---
  const m = indicatorMenu(page);
  await m.add("EMA");
  await expect.poll(() => activeTypes(page)).toContain("EMA");
  await expect
    .poll(() => templateIndicatorTypes(page), { timeout: 5000 })
    .toEqual(["EMA"]);
  await setAutoSave(page, false);

  // --- Change the chart: add RSI and draw a horizontal line. ---
  await m.add("RSI");
  await expect.poll(() => activeTypes(page)).toContain("RSI");
  const canvas = page.locator(".chart-cell").first().locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  const lines = page.locator(".draw-sidebar .ds-family").first();
  await lines.hover();
  await lines.locator(".ds-caret").click();
  await page
    .locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" })
    .click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);

  // Auto-save is off, so the template never picked up RSI or the line.
  await expect.poll(() => templateIndicatorTypes(page)).toEqual(["EMA"]);

  // --- Apply the (drawing-free) template. OLD behavior wiped the drawing and
  // replaced the indicator set; merge must keep BOTH the line and RSI, and must
  // not duplicate the EMA the chart already has. ---
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Apply US100 template$/ }).click();

  await expect.poll(() => focusedDrawingCount(page)).toBe(1); // drawing survived
  await expect
    .poll(async () => (await activeTypes(page)).filter((n) => n.startsWith("EMA")).length)
    .toBe(1); // no duplicate EMA
  await expect.poll(() => activeTypes(page)).toContain("RSI"); // untouched

  // --- Apply again: idempotent, still exactly one EMA and one drawing. ---
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Apply US100 template$/ }).click();
  await expect
    .poll(async () => (await activeTypes(page)).filter((n) => n.startsWith("EMA")).length)
    .toBe(1);
  await expect.poll(() => focusedDrawingCount(page)).toBe(1);
});
