import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Drag the border between two side-by-side cells: widths change, persist
// across reload, and reset when the layout kind changes.
test("dragging the cell border resizes and persists", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  const w = async (i: number) =>
    (await page.locator(".chart-cell").nth(i).boundingBox())!.width;
  const before0 = await w(0);

  // Drag the vertical strip 120px to the right.
  const strip = page.locator(".cell-resize-strip.cols");
  await expect(strip).toHaveCount(1);
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  const after0 = await w(0);
  expect(after0).toBeGreaterThan(before0 + 80);

  // Persists across reload.
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  expect(await w(0)).toBeGreaterThan(before0 + 80);

  // Changing the layout kind resets to equal split.
  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two rows" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  const h0 = (await page.locator(".chart-cell").nth(0).boundingBox())!.height;
  const h1 = (await page.locator(".chart-cell").nth(1).boundingBox())!.height;
  expect(Math.abs(h0 - h1)).toBeLessThan(4);
});

// Double-clicking a resize strip resets its two adjacent tracks to an equal
// split, instantly and persisted through the same onSizes path as a drag.
test("double-clicking the cell border resets it to an equal split", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  const w = async (i: number) =>
    (await page.locator(".chart-cell").nth(i).boundingBox())!.width;
  const before0 = await w(0);

  // Drag the vertical strip 120px to the right — fractions change.
  const strip = page.locator(".cell-resize-strip.cols");
  await expect(strip).toHaveCount(1);
  let box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  const dragged0 = await w(0);
  expect(dragged0).toBeGreaterThan(before0 + 80);

  // Double-click the same strip — resets to equal split.
  box = (await strip.boundingBox())!;
  await strip.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  const reset0 = await w(0);
  const reset1 = await w(1);
  expect(Math.abs(reset0 - reset1)).toBeLessThan(4);
});
