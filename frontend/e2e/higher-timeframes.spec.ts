import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Higher-timeframe intervals (derived/aggregated): the toolbar interval dropdown
// gains Weeks (2W/3W/6W), Months (1M/2M/3M) and Years (1Y) groups. These live in
// the grouped dropdown only (like the seconds group), not the quick-bar. Selecting
// one re-fetches /api/candles with the derived resolution token (e.g. MONTH) and
// marks it active via the toolbar's "extra-period" chip.
//
// NOTE: ChartRangeBar also has "1M"/"3M" buttons — those are visible-RANGE presets,
// not intervals. This spec deliberately targets the .interval-dropdown.

function candleStub() {
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const base = now - (now % DAY);
  // 400 daily bars so the backend would have >1yr of base data to fold; the stub
  // just needs the chart to initialise with data on the MONTH re-fetch.
  const candles = Array.from({ length: 400 }, (_, i) => {
    const time = base - (399 - i) * DAY;
    return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  });
  return JSON.stringify(candles);
}

async function waitForChart(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
}

test("interval dropdown exposes Months/Weeks/Years and selecting 1M activates it", async ({
  page,
}) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: candleStub() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForChart(page);

  // Open the toolbar interval dropdown (the caret button, title="Chart interval").
  await page.locator(".interval-toggle").first().click();
  const dropdown = page.locator(".interval-dropdown");
  await expect(dropdown).toBeVisible();

  // New groups are present.
  await expect(dropdown.getByText("Weeks", { exact: true })).toBeVisible();
  await expect(dropdown.getByText("Months", { exact: true })).toBeVisible();
  await expect(dropdown.getByText("Years", { exact: true })).toBeVisible();
  // All seven derived labels are listed.
  for (const label of ["2W", "3W", "6W", "1M", "2M", "3M", "1Y"]) {
    await expect(dropdown.locator("li", { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  }

  // Capture the resolution the chart asks for after picking 1M.
  let requestedRes: string | null = null;
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname.endsWith("/api/candles") && u.searchParams.get("resolution") === "MONTH") {
      requestedRes = "MONTH";
    }
  });

  // Pick 1M from the Months group.
  await dropdown.locator("li", { hasText: /^1M$/ }).click();
  await expect(dropdown).toHaveCount(0); // dropdown closes on select

  // The chart re-fetched with resolution=MONTH, and the active-interval chip shows 1M.
  await expect.poll(() => requestedRes, { timeout: 5000 }).toBe("MONTH");
  await expect(page.locator(".periods .extra-period")).toHaveText(/1M/);

  // Chart canvas still present after the switch.
  await expect(page.locator(".chart-wrap canvas").first()).toBeVisible();
});
