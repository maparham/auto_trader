import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Hovering an alert line must hide the crosshair's HORIZONTAL guide (it would
// otherwise sit right on the dashed alert line and read as noise) while leaving
// the VERTICAL guide alone, and restore the horizontal guide on mouse-leave.

type ChartLike = {
  getDataList: () => Array<{ close: number }>;
  getSize: (pane: string, pos: string) => { width: number } | null;
  getStyles: () => {
    crosshair: { horizontal: { show: boolean }; vertical: { show: boolean } };
  };
};

async function waitForChart(page: import("@playwright/test").Page) {
  await page.waitForSelector(".chart-wrap", { timeout: 15000 });
  await page.waitForFunction(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    return (c?.getDataList().length ?? 0) > 0;
  }, { timeout: 20000 });
}

async function getMainW(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    return c?.getSize("candle_pane", "main")?.width ?? 0;
  });
}

async function crosshairShow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    const cs = c!.getStyles().crosshair;
    return { horizontal: cs.horizontal.show, vertical: cs.vertical.show };
  });
}

async function seedAlert(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const c = (window as unknown as { __chart?: ChartLike }).__chart;
    const lastClose = c?.getDataList().slice(-1)[0]?.close ?? 19000;
    localStorage.setItem(
      "auto-trader.tab.t1.alerts.US100",
      JSON.stringify([{ level: lastClose, condition: "crossing", trigger: "every", message: "" }]),
    );
  });
}

test.describe("crosshair over alert line", () => {
  test.beforeEach(async ({ page }) => {
    await seedSingleChartDefault(page);
    await stubStateApi(page);
  });

  test("horizontal guide hides on hover, vertical stays, both restore on leave", async ({ page }) => {
    await page.goto("http://localhost:5173");
    await waitForChart(page);
    await seedAlert(page);
    await page.reload();
    await waitForChart(page);
    await page.waitForTimeout(1500); // let rehydrate() run

    const alertTag = page.locator(".alert-tag").first();
    await expect(alertTag).toBeVisible({ timeout: 8000 });

    const mainW = await getMainW(page);
    expect(mainW).toBeGreaterThan(0);

    const wrap = page.locator(".chart-wrap");
    const wrapBox = (await wrap.boundingBox())!;
    const tagBox = (await alertTag.boundingBox())!;
    const lineY = tagBox.y + tagBox.height / 2;
    const midX = wrapBox.x + mainW / 2;

    // Baseline: away from the line, both guides enabled.
    await page.mouse.move(midX, wrapBox.y + 30);
    await page.waitForTimeout(300);
    expect(await crosshairShow(page)).toEqual({ horizontal: true, vertical: true });

    // Hover the alert line: horizontal guide hidden, vertical guide kept.
    await page.mouse.move(midX, lineY);
    await page.waitForTimeout(600);
    expect(await crosshairShow(page)).toEqual({ horizontal: false, vertical: true });

    // Leave the line (move up, same column): horizontal guide restored.
    await page.mouse.move(midX, wrapBox.y + 30);
    await page.waitForTimeout(600);
    expect(await crosshairShow(page)).toEqual({ horizontal: true, vertical: true });
  });
});
