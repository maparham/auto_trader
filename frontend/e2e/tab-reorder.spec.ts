import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Verifies the tab bar sits at the top (above the toolbar) and tabs can be
// reordered by drag-and-drop, with the new order persisting across reload.
test("tab bar is at the top and tabs reorder by drag", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");

  // Tab bar is the first child of .app, before the toolbar (topmost strip).
  const firstChild = page.locator(".app > *").first();
  await expect(firstChild).toHaveClass(/tab-bar/);
  // And it renders above the toolbar.
  const barBox = await page.locator(".tab-bar").boundingBox();
  const toolbarBox = await page.locator(".toolbar").boundingBox();
  expect(barBox!.y).toBeLessThan(toolbarBox!.y);

  // Make a second tab distinguishable: change its interval to 1D.
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await page.locator(".periods button", { hasText: /^1D$/ }).click();

  const periods = () =>
    page.locator(".tab-bar .tab .tab-period").allTextContents();
  // Order before: [1H, 1D].
  expect(await periods()).toEqual(["1H", "1D"]);

  // Drop position within the target decides before vs after that tab.
  const tabs = page.locator(".tab-bar .tab");
  const leftHalf = async (n: number) => {
    const b = (await tabs.nth(n).boundingBox())!;
    return { x: b.width * 0.25, y: b.height / 2 };
  };
  const rightHalf = async (n: number) => {
    const b = (await tabs.nth(n).boundingBox())!;
    return { x: b.width * 0.75, y: b.height / 2 };
  };

  // Drag the second tab (1D) leftward onto the first slot's left half.
  await tabs.nth(1).dragTo(tabs.nth(0), { targetPosition: await leftHalf(0) });
  // Order after: [1D, 1H].
  expect(await periods()).toEqual(["1D", "1H"]);

  // Add a third tab so rightward moves are meaningful. Order now: [1D, 1H, 1W].
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await page.locator(".periods button", { hasText: /^1W$/ }).click();
  expect(await periods()).toEqual(["1D", "1H", "1W"]);

  // Rightward drag onto the LEFT half of 1W → land before it (index-shift case).
  await tabs.nth(0).dragTo(tabs.nth(2), { targetPosition: await leftHalf(2) });
  expect(await periods()).toEqual(["1H", "1D", "1W"]);

  // Drop on the RIGHT half of the LAST tab → land after it. This is the case a
  // pure drop-before scheme can't reach (the reported NVDA-past-US100 bug).
  await tabs.nth(0).dragTo(tabs.nth(2), { targetPosition: await rightHalf(2) });
  expect(await periods()).toEqual(["1D", "1W", "1H"]);

  // Persists across reload.
  await page.reload();
  expect(await page.locator(".tab-bar .tab .tab-period").allTextContents()).toEqual([
    "1D",
    "1W",
    "1H",
  ]);
});
