import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, seedTwoChartTabs, stubStateApi } from "./helpers";

// When the lead cell's market is closed (closed:true from /api/market/{epic},
// derived server-side from the instrument's opening hours), the tab shows a
// crescent-moon badge and the chart's price label reads "closed" in place of the
// candle countdown. The chart fetches that meta on load and polls it — here we
// stub the endpoint so the test is hermetic.

test("a closed market badges its tab", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/market/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ epic: "US100", pricePrecision: 2, closed: true, nextOpen: "2026-06-26T22:00:00+00:00" }),
    }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // The badge rides in the tab's corner; it only appears once the fetched meta
  // resolves to closed:true, so poll rather than assert immediately.
  await expect(page.locator(".tab .tab-closed-badge")).toBeVisible();
});

test("the price label reads \"closed\" instead of a countdown", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/market/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ epic: "US100", pricePrecision: 2, closed: true, nextOpen: "2026-06-26T22:00:00+00:00" }),
    }),
  );
  // Feed a little candle history so the chart has a last price to anchor the
  // price label on (the countdown/"closed" chip rides on that pill). Hourly bars
  // ending now; values are arbitrary but valid.
  await page.route("**/api/candles**", (r) => {
    const hour = 3600;
    const now = Math.floor(Date.now() / 1000);
    const start = now - now % hour;
    const candles = Array.from({ length: 50 }, (_, i) => {
      const time = start - (49 - i) * hour;
      return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
    });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(candles) });
  });
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // The price pill's chip shows "closed" in place of the candle timer.
  await expect(page.locator(".price-tag .pt-cd")).toHaveText("closed");
});

test("a backgrounded tab's closed market still badges (App-level epic poll)", async ({
  page,
}) => {
  // The whole point of sourcing the badge from an App-level per-epic poll rather
  // than the active tab's mounted ChartCore: tab 2 (OIL_CRUDE) is NOT active and
  // its ChartCore never mounts, yet its closed market must still badge. The active
  // tab (US100) is open and must stay un-badged.
  await seedTwoChartTabs(page, "US100", "OIL_CRUDE");
  await stubStateApi(page);
  await page.route("**/api/market/**", (r) => {
    const closed = r.request().url().includes("OIL_CRUDE");
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        epic: closed ? "OIL_CRUDE" : "US100",
        pricePrecision: 2,
        closed,
        nextOpen: closed ? "2026-06-26T22:00:00+00:00" : null,
      }),
    });
  });
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // The background tab (t2, OIL_CRUDE) shows the moon; the active tab (t1) doesn't.
  const tabs = page.locator(".tab");
  await expect(tabs.nth(1).locator(".tab-closed-badge")).toBeVisible();
  await expect(tabs.nth(0).locator(".tab-closed-badge")).toHaveCount(0);
});

test("a tradeable market shows no closed badge", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/market/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ epic: "US100", pricePrecision: 2, closed: false, nextOpen: null }),
    }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Give the fetch a beat to land, then confirm the badge never appeared.
  await expect(page.locator(".tab .tab-symbol")).toBeVisible();
  await expect(page.locator(".tab .tab-closed-badge")).toHaveCount(0);
});
