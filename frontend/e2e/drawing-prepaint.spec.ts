import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// A new tab on a series already loaded this session pre-paints the cached bars
// before its own candle fetch lands, and its stored drawings only rehydrate
// after that fetch. A line placed in between used to show, never save, and
// vanish at the rehydrate. Now the tool waits: it arms once the rehydrate has
// run, and the line placed then is saved.

const storedCount = (page: Page) =>
  page.evaluate(() => {
    const active = sessionStorage.getItem("auto-trader.activeTabId") ?? "";
    const key = Object.keys(localStorage).find((k) => k.startsWith(`auto-trader.tab.${active}.drawings.`));
    return key ? (JSON.parse(localStorage.getItem(key) || "[]") as unknown[]).length : 0;
  });
const hLinesOnChart = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __chart?: { getOverlays(f: object): { name: string }[] } }).__chart;
    return c ? c.getOverlays({}).filter((o) => o.name === "horizontalStraightLine").length : 0;
  });
const barCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart?.getDataList().length ?? 0);

async function pickHLine(page: Page) {
  const lines = page.locator(".draw-sidebar .ds-family").first();
  await lines.hover();
  await lines.locator(".ds-caret").click();
  await page.locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" }).click();
}
async function clickChartCenter(page: Page) {
  const box = await page.locator(".chart canvas").first().boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test("a line drawn while a new tab pre-paints is saved, not lost", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  // Hold US100 candle fetches once `hold` is set, so tab 2 stays in its
  // pre-paint window until the test releases it.
  let hold = false;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/api/candles?**", async (route) => {
    if (hold && route.request().url().includes("US100")) await released;
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => barCount(page), { timeout: 20000 }).toBeGreaterThan(0);

  hold = true;
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  // Tab 2 shows tab 1's cached bars while its own fetch is held.
  await expect.poll(() => barCount(page)).toBeGreaterThan(0);

  // Picking the tool and clicking now places nothing.
  await pickHLine(page);
  await clickChartCenter(page);
  expect(await hLinesOnChart(page)).toBe(0);

  // The fetch lands, the drawings rehydrate, and the picked tool arms: a click
  // then places a line that is saved. How soon it arms depends on load, so
  // click until one lands (a placed line disarms the tool, so only one can).
  release();
  await expect(async () => {
    await clickChartCenter(page);
    await expect.poll(() => storedCount(page), { timeout: 1000 }).toBe(1);
  }).toPass({ timeout: 15000 });
  expect(await hLinesOnChart(page)).toBe(1);

  // It survives a later rehydrate (a reload back onto tab 2).
  hold = false;
  await page.reload();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await page.locator(".tab-bar .tab").nth(1).click();
  await expect.poll(() => barCount(page), { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(() => hLinesOnChart(page)).toBe(1);
  expect(await storedCount(page)).toBe(1);
});
