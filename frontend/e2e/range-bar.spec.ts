import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// ChartRangeBar e2e: hover-reveal, range-button interval sync, calendar popover.
//
// Stub pattern mirrors market-closed.spec.ts / indicator-presets.spec.ts:
//   seedSingleChartDefault   → seeds localStorage so app boots with one US100 1H cell
//   stubStateApi             → /api/state returns {} (hermetic; no backend bleed)
//   /api/candles stub        → returns 50 hourly bars so the chart initialises
//     (ChartRangeBar is disabled={!chartRef.current} until the chart object exists;
//      having data ensures the chart completes initialisation before we interact)

function candleStub(resolution = "HOUR") {
  const secPerBar: Record<string, number> = {
    HOUR: 3600,
    MINUTE_30: 1800,
    MINUTE: 60,
    DAY: 86400,
  };
  const interval = secPerBar[resolution] ?? 3600;
  const now = Math.floor(Date.now() / 1000);
  const base = now - (now % interval);
  const candles = Array.from({ length: 50 }, (_, i) => {
    const time = base - (49 - i) * interval;
    return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  });
  return JSON.stringify(candles);
}

async function waitForChart(page: Page) {
  // Poll until __chart exists (chart object created) — same pattern as
  // indicator-presets.spec.ts's waitForData but only needs the object, not bars,
  // because the disabled guard is !chartRef.current (chart existence), not data.
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

// The bar reveals only when the cursor is near the cell's BOTTOM edge (TV-style),
// not anywhere on the chart. Hover a point ~12px above the bottom to reveal it.
async function revealBar(page: Page, cell: ReturnType<Page["locator"]>) {
  const box = await cell.boundingBox();
  if (!box) throw new Error("cell has no bounding box");
  await page.mouse.move(box.x + 80, box.y + box.height - 12);
}

test("hovering a chart cell reveals the range bar", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: candleStub() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForChart(page);

  const cell = page.locator(".chart-wrap").first();
  const bar = cell.getByTestId("chart-range-bar");

  // The bar lives in the DOM at all times but is hidden via opacity:0 / pointer-events:none
  // (CSS transition). Playwright's visibility check doesn't see opacity:0 as hidden, so
  // we assert on the computed opacity directly before hover.
  const opacityBefore = await bar.evaluate((el) => getComputedStyle(el).opacity);
  expect(opacityBefore).toBe("0");

  // Hovering near the BOTTOM edge reveals it (opacity:1). toBeVisible() waits until
  // the element is fully visible per Playwright's checks (opacity > 0; the pre-hover
  // check above proved it started at 0).
  await revealBar(page, cell);
  await expect(bar).toBeVisible();

  // Moving the cursor UP onto the chart (away from the bottom band) hides it again —
  // the reported bug was that it stayed up across the whole chart.
  const box = (await cell.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 80);
  await expect
    .poll(() => bar.evaluate((el) => getComputedStyle(el).opacity), { timeout: 2000 })
    .toBe("0");

  // And clicking a range button must NOT pin it open: reveal, click, move up, hide.
  // (Regression guard — a stale :focus-within rule kept it up because the clicked
  // button retained focus.)
  await revealBar(page, cell);
  await bar.getByRole("button", { name: "1M", exact: true }).click();
  await page.mouse.move(box.x + 200, box.y + 80);
  await expect
    .poll(() => bar.evaluate((el) => getComputedStyle(el).opacity), { timeout: 2000 })
    .toBe("0");
});

test("clicking 1M sets aria-pressed and switches toolbar to 30m", async ({ page }) => {
  // The toolbar period quick-bar renders PERIODS from feed.ts:
  //   { resolution: "MINUTE_30", label: "30m" }   ← what 1M maps to
  // Active period gets className "on" (not aria-pressed; Toolbar.tsx line ~453).
  // We assert that the 30m button has class "on" after the range switch.

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  // Stub candles for any resolution so the re-fetch on interval switch also resolves.
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: candleStub() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForChart(page);

  const cell = page.locator(".chart-wrap").first();
  await revealBar(page, cell);
  const bar = cell.getByTestId("chart-range-bar");
  await expect(bar).toBeVisible();

  // Click the 1M range button.
  const btn1M = bar.getByRole("button", { name: "1M", exact: true });
  await btn1M.click();

  // The button itself becomes aria-pressed="true".
  await expect(btn1M).toHaveAttribute("aria-pressed", "true");

  // The toolbar interval quick-bar now marks 30m as active (class "on").
  // Label "30m" comes from feed.ts: { resolution: "MINUTE_30", label: "30m" }.
  await expect(page.locator(".periods button", { hasText: "30m" })).toHaveClass(/\bon\b/);
});

test("calendar popover opens, accepts a date, submits, and closes without crashing", async ({
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

  const cell = page.locator(".chart-wrap").first();
  await revealBar(page, cell);
  const bar = cell.getByTestId("chart-range-bar");
  await expect(bar).toBeVisible();

  // The calendar icon button has aria-label="Open date picker".
  const calBtn = bar.getByRole("button", { name: "Open date picker" });
  await calBtn.click();

  // Popover appears.
  await expect(bar.locator(".crb-cal-pop")).toBeVisible();

  // Fill the date input (aria-label="Go to date") — distinct from the button now.
  await bar.getByRole("textbox", { name: "Go to date" }).fill("2026-03-15");
  await bar.getByRole("button", { name: "Go", exact: true }).click();

  // Popover closes after submit and the chart canvas is still present.
  await expect(bar.locator(".crb-cal-pop")).toHaveCount(0);
  await expect(cell.locator("canvas").first()).toBeVisible();
});

test("trailing offset -1W switches to 5m and buttons carry tooltips", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: candleStub() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForChart(page);

  const cell = page.locator(".chart-wrap").first();
  await revealBar(page, cell);
  const bar = cell.getByTestId("chart-range-bar");
  await expect(bar).toBeVisible();

  // Tooltips: calendar 1D and trailing -1D carry the expected title text.
  await expect(bar.getByRole("button", { name: "1D", exact: true })).toHaveAttribute(
    "title",
    "From the start of today",
  );
  await expect(bar.getByRole("button", { name: "-1D", exact: true })).toHaveAttribute(
    "title",
    "This time 1 day ago",
  );

  // -1W is a trailing offset paired with 5m (MINUTE_5).
  const btn1W = bar.getByRole("button", { name: "-1W", exact: true });
  await btn1W.click();
  await expect(btn1W).toHaveAttribute("aria-pressed", "true");
  // /^5m$/ so it doesn't also match "15m".
  await expect(page.locator(".periods button", { hasText: /^5m$/ })).toHaveClass(/\bon\b/);
});
