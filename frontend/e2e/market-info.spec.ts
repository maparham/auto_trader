import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Curated market-info popover, opened from the legend's ⓘ button. The details
// endpoint is stubbed (values modeled on real OIL_CRUDE data) and the browser
// timezone is pinned to UTC so the local-hours conversion is deterministic.
test.use({ timezoneId: "UTC" });

const DETAILS = {
  instrument: {
    epic: "US100",
    name: "US Tech 100",
    type: "INDICES",
    currency: "USD",
    lotSize: 1,
    guaranteedStopAllowed: true,
    marginFactor: 5,
    marginFactorUnit: "PERCENTAGE",
    openingHours: {
      mon: ["00:00 - 21:00", "22:00 - 00:00"],
      tue: ["00:00 - 21:00", "22:00 - 00:00"],
      wed: ["00:00 - 21:00", "22:00 - 00:00"],
      thu: ["00:00 - 21:00", "22:00 - 00:00"],
      fri: ["00:00 - 17:00"],
      sat: [],
      sun: ["22:00 - 00:00"],
      zone: "UTC",
    },
    overnightFee: {
      longRate: -0.01096,
      shortRate: -0.01096,
      swapChargeTimestamp: 1783026000000, // 21:00 UTC
      swapChargeInterval: 1440,
    },
  },
  dealingRules: {
    minDealSize: { value: 1, unit: "POINTS" },
    maxDealSize: { value: 125000, unit: "POINTS" },
  },
  snapshot: {
    marketStatus: "TRADEABLE",
    bid: 68.425,
    offer: 68.457,
    high: 68.758,
    low: 66.998,
    decimalPlacesFactor: 3,
    percentageChange: 0.02,
  },
};

test("legend ⓘ opens the curated popover; Esc and outside click dismiss", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/market/**/details**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DETAILS),
    }),
  );

  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".cl-info").click();
  const pop = page.locator(".mi-popover");
  await expect(pop).toBeVisible();

  // Header: name + epic.
  await expect(pop.locator(".mi-name")).toHaveText("US Tech 100");
  await expect(pop.locator(".mi-epic")).toHaveText("US100");

  // Day range bar.
  await expect(pop.locator(".mi-range-low")).toContainText("66.998");
  await expect(pop.locator(".mi-range-high")).toContainText("68.758");
  await expect(pop.locator(".mi-range-pill")).toHaveText("68.425");

  // Trading hours, grouped, in the (pinned-UTC) local zone.
  const hours = pop.locator(".mi-hours-row");
  await expect(hours.nth(0)).toContainText("Mon – Thu");
  await expect(hours.nth(0)).toContainText("00:00 – 21:00, 22:00 – 00:00");
  await expect(hours.nth(1)).toContainText("Fri");
  await expect(hours.nth(2)).toContainText("closed");

  // Trading info rows (formatted, not raw).
  await expect(pop).toContainText("USD");
  await expect(pop).toContainText("-0.011%"); // funding, 3 decimals
  await expect(pop).toContainText("21:00"); // swap charge time
  await expect(pop).toContainText("5.00%"); // margin
  await expect(pop).toContainText("20:1"); // leverage
  await expect(pop).toContainText("0.032"); // spread at 3 decimals

  // Raw section is collapsed by default, expands on click.
  await expect(pop.locator(".instrument-section")).toHaveCount(0);
  await pop.locator(".mi-alldetails-toggle").click();
  await expect(pop).toContainText("Guaranteed Stop Allowed");
  await expect(pop).toContainText("Max Deal Size");

  // Esc dismisses.
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  // Reopen, outside click dismisses (clicking the ⓘ again must not count as outside).
  await page.locator(".cl-info").click();
  await expect(page.locator(".mi-popover")).toBeVisible();
  await page.mouse.click(600, 400); // chart area, far from the popover
  await expect(page.locator(".mi-popover")).toHaveCount(0);
});
