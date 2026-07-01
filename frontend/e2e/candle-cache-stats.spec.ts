import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The cache-stats badge/popover is a debug affordance in the chart legend. Stub
// both stats endpoints so the assertions don't depend on the real cache's warm
// state, mirroring market-closed.spec.ts's page.route stubbing style.
test("cache-stats badge opens a popover with per-series and global stats", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candle-cache/stats?**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        oldest_ts: 1_700_000_000,
        newest_ts: 1_700_864_000, // +10 days
        cached_bar_count: 1440,
        hits: 9,
        misses: 1,
        last_fetch_ts: Date.now() / 1000,
      }),
    }),
  );
  await page.route("**/api/candle-cache/stats/global", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_bars: 50_000,
        total_hits: 900,
        total_misses: 100,
        db_size_bytes: 2_500_000,
      }),
    }),
  );

  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  const badge = page.locator(".cl-cache-corner-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("90%"); // hits=9, misses=1 -> 90% hit rate

  await badge.click();
  const modal = page.locator(".cache-stats-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("This chart");
  await expect(modal).toContainText("Cache overall");
  await expect(modal).toContainText("1440"); // cached bar count
  await expect(modal).toContainText("2.4 MB"); // db size, human-readable
});
