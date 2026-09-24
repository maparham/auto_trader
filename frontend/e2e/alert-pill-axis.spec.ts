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

// Alerts are backend-owned (`/api/alerts`, read into an in-memory cache by
// hydrateAlerts() at boot); there is no localStorage fallback. Stub the whole
// alerts surface so the spec never reads or writes the real backend's alerts:
// GET returns just the seeded alert (empty until `level` is set), triggered
// history is empty, and every write succeeds without persisting. The seeded row
// is emitted once per broker so it lands on whichever broker the app is on.
// The API is cross-origin (:5173 -> :8000), so a fulfilled response needs its
// own CORS header or the browser drops it and hydrate silently keeps an empty
// cache.
type AlertStub = { level: number | null };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

async function stubAlertsApi(page: import("@playwright/test").Page): Promise<AlertStub> {
  const stub: AlertStub = { level: null };
  await page.route(/\/api\/alerts(\/|\?|$)/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== "GET") return route.fulfill({ status: 200, headers: CORS, json: {} });
    if (path.endsWith("/api/alerts/triggered")) {
      return route.fulfill({ status: 200, headers: CORS, json: { entries: [], seen: 0 } });
    }
    if (stub.level == null) return route.fulfill({ status: 200, headers: CORS, json: { alerts: [] } });
    const brokersRes = await route.fetch({ url: req.url().replace(/\/api\/alerts.*$/, "/api/brokers") });
    const brokers = ((await brokersRes.json()) as { data: string[] }).data;
    const now = Date.now();
    const alerts = brokers.map((broker) => ({
      id: `e2e-alert-${broker}`,
      broker,
      epic: "US100",
      kind: "price_level",
      // Draw across the whole pane (not from created_at, which is after the
      // last bar) so hovering mid-chart hits the line.
      params: { level: stub.level, condition: "crossing", trigger: "every", startAtCreation: false },
      message: "",
      expires_at: null,
      notify: { toast: false, browser: false, sound: false, push: false, telegram: false },
      precision: 2,
      active: 1,
      created_at: now,
      updated_at: now,
    }));
    return route.fulfill({ status: 200, headers: CORS, json: { alerts } });
  });
  return stub;
}

// Seed one alert and let the caller reload so the boot hydrate picks it up.
// NOT at the last close: an unselected alert tag on the live-price row is
// hidden by design (AlertTags: the price pill owns that row). Pick a level a
// third of the way down or up the candle pane, whichever is farther from the
// live price, so the tag shows and hovering mid-chart hits the line.
async function seedAlert(page: import("@playwright/test").Page, stub: AlertStub) {
  stub.level = await page.evaluate(() => {
    type Conv = {
      getSize: (pane: string, pos: string) => { height: number } | null;
      getDataList: () => Array<{ close: number }>;
      convertToPixel: (p: Array<{ value: number }>, f: { paneId: string }) => Array<{ y?: number }>;
      convertFromPixel: (c: Array<{ y: number }>, f: { paneId: string }) => Array<{ value?: number }>;
    };
    const c = (window as unknown as { __chart: Conv }).__chart;
    const h = c.getSize("candle_pane", "main")!.height;
    const lastClose = c.getDataList().slice(-1)[0].close;
    const lastY = c.convertToPixel([{ value: lastClose }], { paneId: "candle_pane" })[0].y ?? h / 2;
    const y = [h * 0.35, h * 0.65].sort((a, b) => Math.abs(b - lastY) - Math.abs(a - lastY))[0];
    return c.convertFromPixel([{ y }], { paneId: "candle_pane" })[0].value!;
  });
}

test.describe("alert pill on price axis", () => {
  let alerts: AlertStub;

  test.beforeEach(async ({ page }) => {
    await seedSingleChartDefault(page);
    await stubStateApi(page);
    alerts = await stubAlertsApi(page);
  });

  test("pill is hidden when cursor is on price axis", async ({ page }) => {
    await page.goto("http://localhost:5173");
    await waitForChart(page);

    // Seed the alert and reload so the boot hydrate + rehydrate pick it up.
    await seedAlert(page, alerts);
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
    await seedAlert(page, alerts);
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
