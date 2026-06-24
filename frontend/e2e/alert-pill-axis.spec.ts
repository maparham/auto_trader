import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

type ChartLike = {
  getDataList: () => Array<{ close: number }>;
  getSize: (pane: string, pos: string) => { width: number } | null;
};

async function waitForChart(page: import("@playwright/test").Page) {
  await page.waitForSelector(".chart-wrap", { timeout: 15000 });
  await page.waitForFunction(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    return (c?.getDataList().length ?? 0) > 0;
  }, { timeout: 20000 });
}

async function getMainW(page: import("@playwright/test").Page): Promise<number> {
  const w = await page.evaluate(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    return c?.getSize("candle_pane", "main")?.width ?? 0;
  });
  return w;
}

async function seedAlert(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    const lastClose = c?.getDataList().slice(-1)[0]?.close ?? 19000;
    // The seeded default layout opens one US100 chart whose primary scope is
    // `tab.t1` (see helpers.seedSingleChartDefault). Alerts are namespaced per
    // cell scope + epic: `auto-trader.tab.t1.alerts.US100`.
    localStorage.setItem(
      "auto-trader.tab.t1.alerts.US100",
      JSON.stringify([{ level: lastClose, condition: "crossing", trigger: "every", message: "" }]),
    );
  });
}

test.describe("alert pill on price axis", () => {
  test.beforeEach(async ({ page }) => {
    await seedSingleChartDefault(page);
    await stubStateApi(page);
  });

  test("pill is hidden when cursor is on price axis", async ({ page }) => {
    await page.goto("http://localhost:5173");
    await waitForChart(page);

    // Seed alert and reload so klinecharts rehydrates it.
    await seedAlert(page);
    await page.reload();
    await waitForChart(page);
    await page.waitForTimeout(1500); // let rehydrate() run

    // Alert-tag (axis label) must exist.
    const alertTag = page.locator(".alert-tag").first();
    await expect(alertTag).toBeVisible({ timeout: 8000 });

    const mainW = await getMainW(page);
    expect(mainW).toBeGreaterThan(0);

    const wrap = page.locator(".chart-wrap");
    const wrapBox = (await wrap.boundingBox())!;
    const tagBox = (await alertTag.boundingBox())!;
    const lineY = tagBox.y + tagBox.height / 2;
    const midX = wrapBox.x + mainW / 2;
    const axisX = wrapBox.x + mainW + 25; // well into the price-axis column

    // Hover the line so the pill appears.
    await page.mouse.move(midX, lineY);
    await page.waitForTimeout(600);

    // Pill must be visible before we move to the axis (sanity check that the
    // test is actually exercising something meaningful).
    const pills = page.locator(".alert-pill");
    await expect(pills.first()).toBeVisible({ timeout: 3000 });

    // Move to the axis strip.
    await page.mouse.move(axisX, lineY);
    await page.waitForTimeout(300);

    // No pill must be visible on the axis.
    const count = await pills.count();
    for (let i = 0; i < count; i++) {
      await expect(pills.nth(i)).not.toBeVisible();
    }
    // count === 0 also passes (filter removed it from DOM).
  });

  test("pill reappears after moving back from axis to chart", async ({ page }) => {
    await page.goto("http://localhost:5173");
    await waitForChart(page);
    await seedAlert(page);
    await page.reload();
    await waitForChart(page);
    await page.waitForTimeout(1500);

    const alertTag = page.locator(".alert-tag").first();
    await expect(alertTag).toBeVisible({ timeout: 8000 });

    const mainW = await getMainW(page);
    const wrap = page.locator(".chart-wrap");
    const wrapBox = (await wrap.boundingBox())!;
    const tagBox = (await alertTag.boundingBox())!;
    const lineY = tagBox.y + tagBox.height / 2;
    const midX = wrapBox.x + mainW / 2;
    const axisX = wrapBox.x + mainW + 25;

    // Hover line → axis → back to line.
    await page.mouse.move(midX, lineY);
    await page.waitForTimeout(600);
    await page.mouse.move(axisX, lineY);
    await page.waitForTimeout(300);
    await page.mouse.move(midX, lineY);
    await page.waitForTimeout(600);

    // Pill should be back.
    const pills = page.locator(".alert-pill");
    await expect(pills.first()).toBeVisible({ timeout: 3000 });
  });
});
