import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Drawings rehydrate via the `overlays` singleton (a different code path than
// indicators), so they need their own discriminating test: two tabs on the
// IDENTICAL symbol+period must keep independent drawings.
test("tabs on the same symbol+period have independent drawings", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Drawings count for the ACTIVE tab, read from its namespaced storage — the
  // persisted source of truth the per-tab feature is about. Interactive draws
  // persist via onDrawEnd, so this updates right after a line is placed.
  const overlayCount = () =>
    page.evaluate(() => {
      const __lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
      const __body = __lid ? JSON.parse(localStorage.getItem(`auto-trader.layout.${__lid}`) || "null") : null;
      const active = __body?.activeTabId ?? "";
      const key = Object.keys(localStorage).find(
        (k) => k.startsWith(`auto-trader.tab.${active}.drawings.`),
      );
      return key ? (JSON.parse(localStorage.getItem(key) || "[]") as unknown[]).length : 0;
    });

  // Place a single-click drawing (horizontal line) at the canvas center.
  const drawHLine = async () => {
    await page.locator(".menu button", { hasText: "Draw" }).click();
    await page
      .locator(".menu .dropdown li", { hasText: "Horizontal line" })
      .click();
    const box = await page.locator(".chart canvas").first().boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  };

  // Tab 1: draw one line.
  await drawHLine();
  await expect.poll(overlayCount).toBe(1);

  // Tab 2 on the SAME symbol + period.
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  // Tab 2 starts with no drawings (independent layout).
  await expect.poll(overlayCount).toBe(0);

  // Draw two lines on tab 2.
  await drawHLine();
  await drawHLine();
  await expect.poll(overlayCount).toBe(2);

  // Back to tab 1: exactly its one line, not tab 2's two.
  await page.locator(".tab-bar .tab").nth(0).click();
  await expect.poll(overlayCount).toBe(1);

  // Storage is namespaced per tab.
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes(".drawings.")),
  );
  // Two distinct tab namespaces hold drawings.
  expect(new Set(keys.map((k) => k.split(".drawings.")[0])).size).toBe(2);

  // Persists across reload (active = tab 1 -> 1 line; tab 2 -> 2 lines).
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await expect.poll(overlayCount).toBe(1);
  await page.locator(".tab-bar .tab").nth(1).click();
  await expect.poll(overlayCount).toBe(2);
});
