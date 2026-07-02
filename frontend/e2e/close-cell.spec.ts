import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Closing one cell of a 2×2: the ✕ corner button asks for confirmation; cancel
// keeps all four cells, confirm removes exactly that cell and downgrades the
// layout kind to three columns ("3"), preserving the order of the survivors.
test("close button removes a cell and downgrades the layout", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Grid (2×2)" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(4);

  // Active tab state (cell ids + layout kind) from persisted storage. No named
  // layout is active here — seedSingleChartDefault's flat keys are pruned by the
  // per-broker migration, so the app runs on the broker-scoped SCRATCH workspace
  // (`auto-trader.b.<broker>.scratch`) — same read pattern as detach-cell.spec.ts.
  const tabState = () =>
    page.evaluate(() => {
      const k = Object.keys(localStorage).find((key) => /^auto-trader\.b\.[^.]+\.scratch$/.test(key));
      const ws = k ? JSON.parse(localStorage.getItem(k) || "null") : null;
      const tabs = ws?.tabs ?? [];
      const active = ws?.activeTabId || tabs[0]?.id || "";
      const t = tabs.find((tt: { id: string }) => tt.id === active);
      return { ids: t.cells.map((c: { id: string }) => c.id) as string[], layout: t.layout as string };
    });
  const before = await tabState();
  expect(before.ids).toHaveLength(4);

  // Corner controls reveal on cell hover. Close cell #1 (top-right of the 2×2).
  const closeBtn = (i: number) =>
    page.locator(".chart-cell").nth(i).locator(".chart-cell-close");
  await page.locator(".chart-cell").nth(1).hover();
  await closeBtn(1).click();

  // Cancel: nothing changes.
  await page.locator(".confirm-modal button.ghost").click();
  await expect(page.locator(".chart-cell")).toHaveCount(4);

  // Confirm: the cell is gone, layout downgrades to three columns, order kept.
  await page.locator(".chart-cell").nth(1).hover();
  await closeBtn(1).click();
  await page.locator(".confirm-modal button.confirm-danger").click();
  await expect(page.locator(".chart-cell")).toHaveCount(3);
  await expect.poll(async () => (await tabState()).layout).toBe("3");
  const after = await tabState();
  expect(after.ids).toEqual([before.ids[0], before.ids[2], before.ids[3]]);
});
