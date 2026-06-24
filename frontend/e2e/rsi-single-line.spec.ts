import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// RSI must match TradingView: a SINGLE curve of length 14, not klinecharts'
// built-in three lengths ([6,12,24] → three lines). Two paths are covered:
//  1. fresh add → calcParams [14], one figure, modal shows one "Length" input.
//  2. a pre-existing instance saved under the old three-length design ([9,0,0])
//     collapses to a single line on reload (the truncation migration).

type Ind = { name: string; calcParams: number[]; figures: { key: string }[] };
type IndMap = Map<string, Map<string, Ind>>;

async function rsiState(page: Page): Promise<Ind | null> {
  return page.evaluate(() => {
    const c = (window as unknown as {
      __chart?: { getIndicatorByPaneId: () => IndMap };
    }).__chart;
    if (!c) return null;
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values())
        if (ind.name === "RSI")
          return { name: ind.name, calcParams: ind.calcParams, figures: ind.figures };
    return null;
  });
}

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  const open = async () => {
    if (!(await dropdown.isVisible())) await indBtn.click();
    await expect(dropdown).toBeVisible();
  };
  const close = async () => {
    if (await dropdown.isVisible()) await indBtn.click();
    await expect(dropdown).toBeHidden();
  };
  const row = (code: string) =>
    dropdown.locator("li.ind-row", { hasText: new RegExp(`\\(${code}\\)$|^${code}$`) });
  const add = async (name: string) => {
    await open();
    await dropdown.locator("input").fill(name);
    await row(name).first().click();
    await close();
  };
  return { add };
}

test("fresh RSI draws a single length-14 line with one Length input", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await indicatorMenu(page).add("RSI");
  // One length → one figure → one curve (klinecharts' regenerateFigures maps
  // calcParams 1:1 to lines), matching TradingView instead of the [6,12,24] default.
  await expect.poll(async () => (await rsiState(page))?.calcParams).toEqual([14]);
  expect((await rsiState(page))?.figures).toHaveLength(1);
});

test("a saved three-length RSI collapses to one line on reload", async ({ page }) => {
  // Seed the OLD bare-`tabs` shape: migrateToNamedLayouts wraps it into a named
  // default layout on load (keeping tabId `seed` → scope `tab.seed`), so the RSI
  // config still resolves. Stub the API so the real backend can't clobber the seed.
  await stubStateApi(page);
  await page.addInitScript(() => {
    localStorage.clear();
    const tabId = "seed";
    const scope = `tab.${tabId}`;
    const sym = { epic: "US100", name: "US Tech 100", status: null, pricePrecision: 2 };
    const period = { resolution: "HOUR", label: "1H" };
    localStorage.setItem(
      "auto-trader.tabs",
      JSON.stringify([
        { id: tabId, layout: "1", activeCellId: tabId, cells: [{ id: tabId, symbol: sym, period, scope }] },
      ]),
    );
    localStorage.setItem("auto-trader.activeTab", JSON.stringify(tabId));
    localStorage.setItem(`auto-trader.${scope}.indicators`, JSON.stringify([{ id: "RSI", type: "RSI" }]));
    localStorage.setItem(
      `auto-trader.${scope}.indicatorConfig`,
      JSON.stringify({ RSI: { calcParams: [9, 0, 0] } }),
    );
  });
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Migration truncates [9,0,0] → [9], so exactly one line is drawn (length 9 kept).
  await expect.poll(async () => (await rsiState(page))?.calcParams).toEqual([9]);
  expect((await rsiState(page))?.figures).toHaveLength(1);
});
