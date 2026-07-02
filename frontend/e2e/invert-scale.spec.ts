import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// TV-style invert scale: Option/Alt+I flips the candle-pane price axis (rising
// prices draw downward), the toolbar "I" button lights up and toggles the same
// state, and a second Alt+I restores the normal axis. Session-only by design —
// nothing is persisted, so no storage assertions here.

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
};

// Price at the pane's top pixel minus price at its bottom pixel: positive on a
// normal axis (top = high), negative once the scale is inverted (top = low).
function topMinusBottom(page: Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: Chart }).__chart;
    if (!c) return null;
    const size = c.getSize("candle_pane", "main");
    if (!size) return null;
    const top = c.convertFromPixel([{ y: 1 }], { paneId: "candle_pane" })[0]?.value;
    const bot = c.convertFromPixel([{ y: size.height - 1 }], { paneId: "candle_pane" })[0]?.value;
    if (top == null || bot == null) return null;
    return top - bot;
  });
}

test("Option+I inverts the price scale; the toolbar I button mirrors and toggles it", async ({
  page,
}) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/candles**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: trendCandles() }),
  );
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  // Candles loaded: the visible span is a real number.
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);

  const invertBtn = page.locator(".scale button", { hasText: /^I$/ });
  await expect(invertBtn).not.toHaveClass(/\bon\b/);

  // Focus the cell (the shortcut is per-cell), then Alt+I. Playwright's "KeyI"
  // targets the physical key — same reason the app matches e.code (macOS
  // Option+I is a dead key).
  await page.locator(".chart-wrap").first().click();
  await page.keyboard.press("Alt+KeyI");

  // Inverted: the top of the pane now reads the LOW price; the button lights up.
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeLessThan(0);
  await expect(invertBtn).toHaveClass(/\bon\b/);

  // Second Alt+I restores the normal axis.
  await page.keyboard.press("Alt+KeyI");
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);
  await expect(invertBtn).not.toHaveClass(/\bon\b/);

  // The toolbar button drives the same state.
  await invertBtn.click();
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeLessThan(0);
  await expect(invertBtn).toHaveClass(/\bon\b/);
  await invertBtn.click();
  await expect.poll(async () => (await topMinusBottom(page)) ?? 0).toBeGreaterThan(0);
  await expect(invertBtn).not.toHaveClass(/\bon\b/);
});
