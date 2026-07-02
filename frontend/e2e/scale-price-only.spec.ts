import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// "Scale price chart only" (TradingView-style): with the toggle ON (the default),
// the candle-pane price axis fits the candle OHLC only, so an overlay indicator
// whose values fall outside the visible band no longer expands the axis (candles
// keep their height). With it OFF, the axis expands to include the overlay.
//
// The setup makes the divergence deterministic: a steep linear uptrend, plus a
// long-period MA. Over the most-recent (visible) window the MA lags far BELOW the
// latest closes, so including it pulls the axis minimum down substantially.

// 400 hourly bars, close rising 100 -> 499 (open=close, tight high/low band).
function trendCandles(): string {
  const base = Date.UTC(2024, 0, 1);
  const rows = Array.from({ length: 400 }, (_, i) => {
    const close = 100 + i;
    return {
      timestamp: base + i * 3600_000,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000,
    };
  });
  return JSON.stringify(rows);
}

type Chart = {
  getSize: (paneId: string, position: string) => { width: number; height: number } | null;
  convertFromPixel: (
    points: Array<{ y: number }>,
    opts: { paneId: string },
  ) => Array<{ value: number }>;
  getIndicatorByPaneId: () => Map<string, Map<string, { name: string }>>;
  overrideIndicator: (o: { name: string; calcParams: number[] }) => void;
};

function win(page: Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: Chart }).__chart;
    if (!c) return null;
    const size = c.getSize("candle_pane", "main");
    if (!size) return null;
    // Visible price span = price at pane top minus price at pane bottom.
    const top = c.convertFromPixel([{ y: 1 }], { paneId: "candle_pane" })[0]?.value;
    const bot = c.convertFromPixel([{ y: size.height - 1 }], { paneId: "candle_pane" })[0]?.value;
    return { top, bot, span: Math.abs(top - bot), height: size.height, width: size.width };
  });
}

// Force the long MA period so it lags well below the latest closes in view.
async function stretchMA(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = (window as unknown as { __chart?: Chart }).__chart;
    if (!c) return;
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values())
        if (ind.name === "MA") c.overrideIndicator({ name: "MA", calcParams: [300] });
  });
}

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  return {
    add: async (name: string) => {
      if (!(await dropdown.isVisible())) await indBtn.click();
      await expect(dropdown).toBeVisible();
      await dropdown.locator("input").fill(name);
      await dropdown
        .locator("li.ind-row", { hasText: new RegExp(`\\(${name}\\)$|^${name}$`) })
        .first()
        .click();
      await indBtn.click();
      await expect(dropdown).toBeHidden();
    },
  };
}

// Right-click the price-axis column to open its context menu; return the toggle item.
async function openAxisMenu(page: Page, width: number, height: number) {
  const box = await page.locator(".chart-wrap").first().boundingBox();
  await page.mouse.click(box!.x + width + 15, box!.y + height / 2, { button: "right" });
  const item = page.locator(".ctxmenu .ctx-item", { hasText: "Scale price chart only" });
  await expect(item).toBeVisible();
  return item;
}

async function setup(page: Page) {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: trendCandles() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  // Wait for candles to load into the chart.
  await expect.poll(async () => (await win(page))?.span ?? 0).toBeGreaterThan(0);
}

test("overlay outside the view does not shrink candles while the toggle is on", async ({
  page,
}) => {
  await setup(page);

  const before = await win(page);
  await indicatorMenu(page).add("MA");
  await stretchMA(page);
  await expect.poll(() => page.evaluate(() => {
    const c = (window as unknown as { __chart?: Chart }).__chart;
    for (const pane of c!.getIndicatorByPaneId().values())
      for (const ind of pane.values()) if (ind.name === "MA") return true;
    return false;
  })).toBe(true);

  // Toggle ON (default): the candle span is essentially unchanged by adding the MA.
  const withMA = await win(page);
  expect(Math.abs(withMA!.span - before!.span)).toBeLessThan(before!.span * 0.25);

  // The default-on state shows a checkmark icon in the menu.
  const item = await openAxisMenu(page, withMA!.width, withMA!.height);
  await expect(item.locator(".ctx-item-icon")).toHaveCount(1);
  // Flip it OFF.
  await item.click();

  // With the toggle OFF, the axis expands to include the low-lying MA: span grows.
  await expect
    .poll(async () => (await win(page))?.span ?? 0)
    .toBeGreaterThan(withMA!.span * 1.5);

  // The OFF choice is persisted per cell (key: auto-trader.<scope>.scalePriceOnly).
  const stored = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.endsWith(".scalePriceOnly"));
    return k ? localStorage.getItem(k) : null;
  });
  expect(stored).toBe("false");
});

test("the toggle persists across reload", async ({ page }) => {
  await setup(page);
  const s = await win(page);

  // Turn it OFF and reload.
  await (await openAxisMenu(page, s!.width, s!.height)).click();
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await expect.poll(async () => (await win(page))?.span ?? 0).toBeGreaterThan(0);

  // After reload the menu reflects OFF: no checkmark icon.
  const s2 = await win(page);
  const item = await openAxisMenu(page, s2!.width, s2!.height);
  await expect(item.locator(".ctx-item-icon")).toHaveCount(0);
});

test("right-clicking a sub-pane axis does not open the candle-only menu", async ({
  page,
}) => {
  await setup(page);
  // Add RSI -> its own sub-pane below the candle pane, so the candle pane shrinks.
  await indicatorMenu(page).add("RSI");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = (window as unknown as { __chart?: Chart }).__chart;
        for (const pane of c!.getIndicatorByPaneId().values())
          for (const ind of pane.values()) if (ind.name === "RSI") return true;
        return false;
      }),
    )
    .toBe(true);

  const s = await win(page); // s.height is now the (smaller) candle-pane height
  const box = await page.locator(".chart-wrap").first().boundingBox();
  // Right-click the y-axis column BELOW the candle pane (i.e. the RSI pane's axis).
  await page.mouse.click(box!.x + s!.width + 15, box!.y + s!.height + 25, {
    button: "right",
  });
  // The candle-only toggle must NOT appear over a sub-pane's axis.
  await expect(
    page.locator(".ctxmenu .ctx-item", { hasText: "Scale price chart only" }),
  ).toHaveCount(0);

  // Sanity: it DOES still appear over the candle pane's own axis strip.
  await openAxisMenu(page, s!.width, s!.height);
});
