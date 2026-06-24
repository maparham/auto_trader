import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Verifies the multi-tab feature: a tab bar exists, new tabs can be opened,
// switching a tab's symbol is scoped to that tab, and tabs persist across reload.
test("chart tabs: add, switch, scope and persist", async ({ page }) => {
  // App opens blank without a default layout, so seed a one-chart default (once,
  // before first load) and stub the state API so localStorage is the source of truth.
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");

  const bar = page.locator(".tab-bar");
  await expect(bar).toBeVisible();
  // Seeded default → exactly one tab on first load.
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  const firstSymbol = await page.locator(".tab.on .tab-symbol").textContent();

  // First tab defaults to the 1H quick-bar interval.
  await expect(page.locator(".tab-bar .tab").nth(0).locator(".tab-period")).toHaveText("1H");

  // Open a new tab (duplicates the active view) and make it active.
  await page.locator(".tab-add").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await expect(page.locator(".tab.on")).toHaveCount(1);

  // Opening a tab prompts for a symbol; dismiss the modal to keep the default
  // chart and continue (the new tab inherits US100·1H).
  await expect(page.locator(".modal.symsearch")).toBeVisible();
  await page.locator(".modal.symsearch .modal-close").click();
  await expect(page.locator(".modal.symsearch")).toHaveCount(0);

  const tabs = page.locator(".tab-bar .tab");
  const periodBtn = (label: string) =>
    page.locator(".periods button", { hasText: new RegExp(`^${label}$`) });

  // Change ONLY the active (second) tab's interval to 1D.
  await periodBtn("1D").click();
  await expect(tabs.nth(1).locator(".tab-period")).toHaveText("1D");
  // The first tab must be unaffected — settings are per-tab.
  await expect(tabs.nth(0).locator(".tab-period")).toHaveText("1H");

  // Switching back to tab 1 restores its 1H interval (the toolbar reflects it).
  await tabs.nth(0).click();
  await expect(periodBtn("1H")).toHaveClass(/on/);
  await tabs.nth(1).click();
  await expect(periodBtn("1D")).toHaveClass(/on/);

  // Reload: both tabs persist with their DISTINCT intervals, not just the count.
  await page.reload();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await expect(tabs.nth(0).locator(".tab-period")).toHaveText("1H");
  await expect(tabs.nth(1).locator(".tab-period")).toHaveText("1D");

  // Close a tab; count drops, never to zero.
  await tabs.nth(1).hover();
  await tabs.nth(1).locator(".tab-close").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".tab.on .tab-symbol")).toHaveText(firstSymbol ?? "");
});
