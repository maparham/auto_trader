import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// seedTwoChartTabs (helpers.ts) seeds the pre-per-broker-isolation flat keys
// (`auto-trader.layout.*`), which resolveStartup() no longer reads — workspace
// roots are broker-scoped now (`auto-trader.b.<broker>.*`, see persist.ts). Seed
// the device-local SCRATCH workspace directly under the default broker ("capital",
// per persist.ts's brokerFromActiveAccount fallback) instead, same shape/ids the
// brief's snippet expects (t1/t2).
async function seedTwoTabsScratch(page: Page, epicA = "US100", epicB = "OIL_CRUDE"): Promise<void> {
  await page.addInitScript(
    ([a, b]: [string, string]) => {
      if (sessionStorage.getItem("__seeded")) return;
      localStorage.clear();
      const period = { resolution: "HOUR", label: "1H" };
      const tab = (id: string, epic: string) => ({
        id,
        layout: "1",
        activeCellId: `${id}-c0`,
        cells: [
          {
            id: `${id}-c0`,
            symbol: { epic, name: epic, status: null, pricePrecision: 2 },
            period,
            scope: `tab.${id}`,
          },
        ],
      });
      const ws = { tabs: [tab("t1", a), tab("t2", b)], activeTabId: "t1" };
      localStorage.setItem("auto-trader.b.capital.scratch", JSON.stringify(ws));
      sessionStorage.setItem("__seeded", "1");
    },
    [epicA, epicB] as [string, string],
  );
}

// Detach: a handle next to maximize clones the cell (symbol/period + scope
// content) into a NEW one-cell tab; the original tab/cell is untouched.
test("detach handle opens the cell as a new in-app tab with its drawings", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Split into two columns and wait for both cells' data (copy the poll from
  // split-layout.spec.ts verbatim).
  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const charts = (window as unknown as { __charts?: Map<string, { getDataList(): unknown[] }> })
            .__charts;
          if (!charts || charts.size < 2) return 0;
          return [...charts.values()].filter((c) => c.getDataList().length > 0).length;
        }),
      { timeout: 20000 },
    )
    .toBe(2);

  const cellCanvas = (i: number) =>
    page.locator(".chart-cell").nth(i).locator("canvas").first();

  // No named layout is active in these specs (fresh scratch workspace, per-broker
  // namespaced key `auto-trader.b.<broker>.scratch`) — read the current tab's cells
  // from there rather than the legacy (now-pruned) `activeLayoutId`/`layout.<id>`
  // keys split-layout.spec.ts's older helper reads.
  const readActiveScratchTab = () =>
    page.evaluate(() => {
      const k = Object.keys(localStorage).find((key) => /^auto-trader\.b\.[^.]+\.scratch$/.test(key));
      const ws = k ? JSON.parse(localStorage.getItem(k) || "null") : null;
      const tabs = ws?.tabs ?? [];
      const active = ws?.activeTabId || tabs[0]?.id || "";
      return tabs.find((t: { id: string }) => t.id === active);
    });
  const cellIds: string[] = (await readActiveScratchTab()).cells.map((c: { id: string }) => c.id);
  const activeCellId = async () => (await readActiveScratchTab())?.activeCellId as string;

  const focusCell = async (i: number) => {
    const box = await cellCanvas(i).boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect.poll(activeCellId).toBe(cellIds[i]);
  };

  // Draw a horizontal line on the SECOND cell (focus + draw-sidebar flow from
  // split-layout.spec.ts).
  await focusCell(1);
  const box = await cellCanvas(1).boundingBox();
  const lines = page.locator(".draw-sidebar .ds-family").first();
  await lines.hover();
  await lines.locator(".ds-caret").click();
  await page
    .locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" })
    .click();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  const tabCount = () => page.locator(".tab-bar .tab").count();
  const before = await tabCount();

  // Hover the second cell to reveal its corner controls, then left-click detach.
  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach").click();

  // A new tab exists and is active, showing ONE cell.
  await expect(page.locator(".tab-bar .tab")).toHaveCount(before + 1);
  await expect(page.locator(".chart-cell")).toHaveCount(1);

  // The new tab's primary scope carries the copied drawing (1 drawing key). The
  // source drawing lived on the SECOND (added) cell, whose scope is nested
  // (`tab.<id>.cell.<cellId>.drawings.…`, per split-layout.spec.ts's scopeCounts
  // pattern) — so the count regex must allow dots in the scope segment, not just
  // match the primary-cell-only form.
  const dstCount = await page.evaluate(() => {
    const tabsRaw = Object.keys(localStorage).filter((k) =>
      /^auto-trader\.tab\..+\.drawings\./.test(k));
    return tabsRaw.length;
  });
  expect(dstCount).toBeGreaterThanOrEqual(2); // source cell's + the copy

  // Original tab intact: switch back → still 2 cells.
  await page.locator(".tab-bar .tab").first().click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
});

test("right-clicking the detach handle offers both destinations", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach")
    .click({ button: "right" });
  await expect(page.locator(".ctxmenu .ctx-item", { hasText: "Open in new tab" })).toBeVisible();
  await expect(page.locator(".ctxmenu .ctx-item", { hasText: "Open in new browser tab" })).toBeVisible();
  // Escape dismisses.
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctxmenu")).toHaveCount(0);
});

test("?tab= startup param activates that tab and is stripped from the URL", async ({ page }) => {
  await seedTwoTabsScratch(page);
  await stubStateApi(page);
  await page.goto("/?tab=t2"); // second seeded tab id (seedTwoTabsScratch)
  await page.locator(".tab-bar").waitFor();
  // Second tab is the active one.
  await expect(page.locator(".tab-bar .tab").nth(1)).toHaveClass(/\bon\b/);
  // Param stripped.
  expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
});
