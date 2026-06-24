import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Read the active indicator TYPES on the focused chart from klinecharts directly.
// The menu no longer shows a checkmark/active-state (an indicator can be added any
// number of times; removal is via the legend), so "is X active" is read from the
// chart's live indicator set, not the menu.
type IndMap = Map<string, Map<string, { name: string }>>;
async function activeTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const c = (window as unknown as {
      __chart?: { getIndicatorByPaneId: () => IndMap };
    }).__chart;
    if (!c) return [];
    const out: string[] = [];
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values()) out.push(ind.name);
    return out;
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
  // A row for an indicator CODE. Rows render "Full Name (CODE)" (or bare CODE for
  // uncatalogued ones), so match either the parenthesised code or an exact code.
  const row = (code: string) =>
    dropdown.locator("li.ind-row", {
      hasText: new RegExp(`\\(${code}\\)$|^${code}$`),
    });
  const add = async (name: string) => {
    await open();
    await dropdown.locator("input").fill(name);
    await row(name).first().click();
    await close();
  };
  return { indBtn, dropdown, open, close, row, add };
}

// THE discriminating test: two tabs on the IDENTICAL symbol AND period must keep
// independent indicator sets. (Tests that distinguish tabs by period would pass
// even if this were broken, because a period change already triggers a reload.)
test("tabs on the same symbol+period have independent indicators", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  const m = indicatorMenu(page);

  // Tab 1 (US100·1H): add MA.
  await m.add("MA");
  await expect.poll(() => activeTypes(page)).toContain("MA");

  // Open Tab 2, keep it on the SAME symbol (cancel search) and SAME period (1H).
  await page.locator(".tab-add").click();
  await page.locator(".modal.symsearch .modal-close").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  expect(await page.locator(".tab-bar .tab .tab-period").allTextContents()).toEqual([
    "1H",
    "1H",
  ]);

  // Tab 2 starts with NO indicators (independent layout), then add RSI.
  await expect.poll(() => activeTypes(page)).not.toContain("MA");
  await m.add("RSI");
  await expect.poll(() => activeTypes(page)).toContain("RSI");
  expect(await activeTypes(page)).not.toContain("MA");

  // Switch back to Tab 1: MA present, RSI absent.
  await page.locator(".tab-bar .tab").nth(0).click();
  await expect.poll(() => activeTypes(page)).toContain("MA");
  expect(await activeTypes(page)).not.toContain("RSI");

  // Persist across reload (active = tab 1).
  await page.reload();
  await expect.poll(() => activeTypes(page)).toContain("MA");
  expect(await activeTypes(page)).not.toContain("RSI");
  await page.locator(".tab-bar .tab").nth(1).click();
  await expect.poll(() => activeTypes(page)).toContain("RSI");
  expect(await activeTypes(page)).not.toContain("MA");
});

// Favourite indicators: starring an indicator surfaces it in a "Favorites" section
// at the top of the menu, persists across reload, and the ⓘ shows a description.
test("indicator favourites and info tooltip", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  const m = indicatorMenu(page);
  const section = (label: string) =>
    m.dropdown.locator("li.ind-section", { hasText: new RegExp(`^${label}$`, "i") });

  await m.open();
  // No favourites yet → no Favorites section.
  await expect(section("Favorites")).toHaveCount(0);

  // Star RSI from its All-section row.
  const rsi = m.row("RSI").first();
  await rsi.locator(".ind-star").click();
  await expect(section("Favorites")).toBeVisible();
  // RSI now appears in BOTH the Favorites section and the All list (TV-style).
  await expect(m.dropdown.locator("li.ind-row", { hasText: /\(RSI\)$/ })).toHaveCount(2);
  // Starring does NOT add an instance to the chart.
  expect(await activeTypes(page)).not.toContain("RSI");

  // ⓘ reveals a portaled tooltip with the friendly title + description.
  await rsi.locator(".ind-info").hover();
  const tip = page.locator(".ind-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip.locator(".ind-tooltip-title")).toHaveText("Relative Strength Index");
  await expect(tip.locator(".ind-tooltip-desc")).not.toBeEmpty();
  await m.close();

  // Favourite persists across reload.
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await m.open();
  await expect(section("Favorites")).toBeVisible();
  await expect(m.dropdown.locator("li.ind-row", { hasText: /\(RSI\)$/ })).toHaveCount(2);

  // Un-star from the Favorites row → section disappears.
  const favRsi = m.dropdown
    .locator("li.ind-section", { hasText: /^Favorites$/ })
    .locator("~ li.ind-row", { hasText: /\(RSI\)$/ })
    .first();
  await favRsi.locator(".ind-star").click();
  await expect(section("Favorites")).toHaveCount(0);
});
