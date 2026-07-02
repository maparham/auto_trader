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
async function focusedDrawingCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    // The workspace lives in the active layout body now (bare `tabs` was retired).
    const lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
    const body = lid ? JSON.parse(localStorage.getItem(`auto-trader.layout.${lid}`) || "null") : null;
    const tabs = body?.tabs ?? [];
    const active = body?.activeTabId ?? "";
    const tab = tabs.find((t: { id: string }) => t.id === active);
    // After a reload the layout may not be re-persisted yet — signal "not ready"
    // with -1 so the caller's expect.poll keeps waiting instead of throwing.
    if (!tab) return -1;
    const cell = tab.cells.find((c: { id: string }) => c.id === tab.activeCellId);
    if (!cell) return -1;
    const epic = cell.symbol.epic;
    const raw = localStorage.getItem(`auto-trader.${cell.scope}.drawings.${epic}`);
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  });
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

  // --- Save this as the symbol's template. ---
  await page.locator(".menu button", { hasText: "Template" }).click();
  await page.locator(".menu .dropdown li", { hasText: /^Save US100 template$/ }).click();
  // The template is now stored globally under the symbol's epic.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) => k.startsWith("auto-trader.template.")),
      ),
    )
    .toBe(true);

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
