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

// The modern drag look: grabbing a chip lifts a floating clone that follows
// the cursor, blanks the source chip, and slides the other chips apart to
// hold open the insertion gap; dropping commits the order and cleans all of
// it up. Uses manual mouse steps (not dragTo) so we can assert MID-drag.
test("dragging lifts a floating chip and slides a gap open", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");

  // Second, distinguishable tab (1D). Order: [1H, 1D].
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await page.locator(".periods button", { hasText: /^1D$/ }).click();

  const tabs = page.locator(".tab-bar .tab");
  const src = (await tabs.nth(1).boundingBox())!;
  const dst = (await tabs.nth(0).boundingBox())!;

  // Manual HTML5 drag: press on the 1D chip, then move in steps so Chromium
  // starts a native drag, onto the far-left edge of the 1H chip.
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2 - 15, src.y + src.height / 2, { steps: 4 });
  await page.mouse.move(dst.x + dst.width * 0.1, dst.y + dst.height / 2, { steps: 8 });

  // Mid-drag: floating clone exists, source chip is blanked (class), and the
  // hovered chip slid RIGHT to open the gap (non-zero translate matrix).
  await expect(page.locator(".tab-float")).toBeVisible();
  await expect(tabs.nth(1)).toHaveClass(/dragging/);
  await expect(tabs.nth(0)).toHaveCSS("transform", /matrix\(1, 0, 0, 1, [1-9]/);

  // Let the 150ms slide-apart transition settle, then nudge and drop. Without
  // this, Chromium's native drag hit-testing — which re-runs against the
  // CSS-transition-animated chip under a stationary cursor — finds the target
  // has animated out from under the pointer and cancels the drag (fires
  // dragend without ever dispatching "drop") instead of committing it.
  await page.waitForTimeout(200);
  await page.mouse.move(dst.x + dst.width * 0.1 + 1, dst.y + dst.height / 2, { steps: 1 });
  await page.mouse.up();

  // Drop landed: order flipped, clone gone, transforms cleared.
  await expect(page.locator(".tab-float")).toHaveCount(0);
  await expect(page.locator(".tab-bar .tab").first()).not.toHaveCSS(
    "transform",
    /matrix\(1, 0, 0, 1, [1-9]/,
  );
  expect(await page.locator(".tab-bar .tab .tab-period").allTextContents()).toEqual([
    "1D",
    "1H",
  ]);
});
