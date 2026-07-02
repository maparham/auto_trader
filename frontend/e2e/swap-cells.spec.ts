import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Two-columns layout: the ↔ button on the shared border swaps the two cells'
// positions (identity travels with the cell — the persisted cells array order
// flips, nothing is purged), and the resize strip on that border still drags.
test("border swap button exchanges adjacent cells", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // Active tab state (cell ids) from persisted storage. No named layout is
  // active here — seedSingleChartDefault's flat keys are pruned by the
  // per-broker migration, so the app runs on the broker-scoped SCRATCH
  // workspace (`auto-trader.b.<broker>.scratch`) — same read pattern as
  // close-cell.spec.ts.
  const cellIds = () =>
    page.evaluate(() => {
      const k = Object.keys(localStorage).find((key) => /^auto-trader\.b\.[^.]+\.scratch$/.test(key));
      const ws = k ? JSON.parse(localStorage.getItem(k) || "null") : null;
      const tabs = ws?.tabs ?? [];
      const active = ws?.activeTabId || tabs[0]?.id || "";
      const t = tabs.find((tt: { id: string }) => tt.id === active);
      return t.cells.map((c: { id: string }) => c.id) as string[];
    });
  const before = await cellIds();
  expect(before).toHaveLength(2);

  // One ↔ button on the single vertical border. It reveals on hover but is
  // clickable regardless (opacity doesn't gate actionability).
  const swap = page.locator(".cell-swap.cols");
  await expect(swap).toHaveCount(1);
  await swap.click();

  await expect.poll(cellIds).toEqual([before[1], before[0]]);
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // A second click swaps back.
  await swap.click();
  await expect.poll(cellIds).toEqual(before);

  // The resize strip underneath still drags (swap button must not eat it).
  const w0 = (await page.locator(".chart-cell").first().boundingBox())!.width;
  const strip = page.locator(".cell-resize-strip.cols");
  const box = (await strip.boundingBox())!;
  // Grab the strip AWAY from its center (the swap button covers the center).
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 40, { steps: 5 });
  await page.mouse.up();
  expect((await page.locator(".chart-cell").first().boundingBox())!.width).toBeGreaterThan(w0 + 80);
});

// 2×2 grid has both a vertical (cols) and horizontal (rows) border, each with
// its own pair of swap buttons. Hovering one border's strip must reveal only
// that border's buttons — a general-sibling `~` selector would leak the
// reveal across the other axis too (the regression this test guards).
test("hovering one border's strip reveals only that border's swap buttons", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Grid (2×2)" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(4);
  await expect(page.locator(".cell-swap")).toHaveCount(4);

  const colsButtons = page.locator(".cell-swap.cols");
  const rowsButtons = page.locator(".cell-swap.rows");
  await expect(colsButtons).toHaveCount(2);
  await expect(rowsButtons).toHaveCount(2);

  // Hover the vertical strip away from its center (the swap button sits there).
  const strip = page.locator(".cell-resize-strip.cols");
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15);

  // Cols buttons reveal; rows buttons stay hidden (mind the 0.1s transition).
  await expect(colsButtons.first()).toHaveCSS("opacity", "1");
  await expect(colsButtons.last()).toHaveCSS("opacity", "1");
  await expect(rowsButtons.first()).toHaveCSS("opacity", "0");
  await expect(rowsButtons.last()).toHaveCSS("opacity", "0");
});
