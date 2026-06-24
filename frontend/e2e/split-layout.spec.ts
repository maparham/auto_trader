import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Multi-chart split layout: two cells in ONE tab must keep independent drawings,
// addressed by their own per-cell scope. The primary cell reuses `tab.<id>`; the
// added cell uses `tab.<id>.cell.<cellId>` — so two distinct drawing scopes appear
// under the same tab, with independent counts that survive a reload.
test("split layout cells have independent drawings", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Switch the active tab to a two-column layout (2 independent cells).
  await page.locator(".layout-menu button", { hasText: "Layout" }).click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // Wait until BOTH cells' charts are live AND have loaded candles — a horizontal
  // line can only anchor to a price once the cell has data.
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

  // The active tab's cell ids (cells[0] = primary, cells[1] = the added cell).
  const cellIds: string[] = await page.evaluate(() => {
    const __lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
    const __body = __lid ? JSON.parse(localStorage.getItem(`auto-trader.layout.${__lid}`) || "null") : null;
    const tabs = __body?.tabs ?? [];
    const active = __body?.activeTabId ?? "";
    return tabs.find((t: { id: string }) => t.id === active).cells.map((c: { id: string }) => c.id);
  });
  const activeCellId = () =>
    page.evaluate(() => {
      const __lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
      const __body = __lid ? JSON.parse(localStorage.getItem(`auto-trader.layout.${__lid}`) || "null") : null;
      const tabs = __body?.tabs ?? [];
      const active = __body?.activeTabId ?? "";
      return tabs.find((t: { id: string }) => t.id === active).activeCellId as string;
    });

  // Focus cell `i` by clicking its center, and WAIT until the focus actually moved
  // (avoids racing the focus re-render before driving the toolbar).
  const focusCell = async (i: number) => {
    const box = await cellCanvas(i).boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect.poll(activeCellId).toBe(cellIds[i]);
  };

  // Place a horizontal line at the focused cell's center.
  const drawHLineOn = async (i: number) => {
    await focusCell(i);
    const box = await cellCanvas(i).boundingBox();
    await page.locator(".menu button", { hasText: "Draw" }).click();
    await page.locator(".menu .dropdown li", { hasText: "Horizontal line" }).click();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  };

  // Drawing counts keyed by per-cell scope (under any tab), from storage.
  const scopeCounts = () =>
    page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const k of Object.keys(localStorage)) {
        const m = k.match(/^auto-trader\.(tab\..+?)\.drawings\./);
        if (m) out[m[1]] = (JSON.parse(localStorage.getItem(k) || "[]") as unknown[]).length;
      }
      return out;
    });

  await drawHLineOn(0); // 1 line on the primary cell
  await drawHLineOn(1); // 2 lines on the second cell
  await drawHLineOn(1);

  // Two distinct cell scopes, with counts 1 and 2 (fully independent).
  await expect.poll(async () => Object.keys(await scopeCounts()).length).toBe(2);
  expect(Object.values(await scopeCounts()).sort()).toEqual([1, 2]);

  // Survives a reload (per-cell scope is persisted on each cell).
  await page.reload();
  await page.locator(".chart-cell").first().waitFor();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  expect(Object.values(await scopeCounts()).sort()).toEqual([1, 2]);
});
