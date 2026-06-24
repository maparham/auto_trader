import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// Global per-indicator presets (TradingView "Defaults"): saving a type's default
// must seed freshly-ADDED instances of that type, without touching existing ones.
//
// Backend is stubbed empty (hydrateFromBackend overwrites localStorage with the
// shared workspace otherwise — see symbol-template.spec.ts).

type IndMap = Map<string, Map<string, { name: string; calcParams: unknown[] }>>;

// calcParams of every EMA-type instance on the focused chart (id starts with "EMA").
async function emaCalcParams(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const c = (window as unknown as {
      __chart?: { getIndicatorByPaneId: () => IndMap };
    }).__chart;
    if (!c) return [];
    const out: number[][] = [];
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values())
        if (ind.name.startsWith("EMA")) out.push((ind.calcParams as number[]).map(Number));
    return out;
  });
}

async function waitForData(page: Page) {
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

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  return {
    add: async (code: string) => {
      if (!(await dropdown.isVisible())) await indBtn.click();
      await dropdown.locator("input").fill(code);
      await dropdown
        .locator("li.ind-row", { hasText: new RegExp(`\\(${code}\\)$|^${code}$`) })
        .first()
        .click();
      if (await dropdown.isVisible()) await indBtn.click();
    },
  };
}

test("saving an indicator default seeds freshly-added instances of that type", async ({
  page,
}) => {
  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  const m = indicatorMenu(page);

  // Add the first EMA — defaults to length 9 (BASE_TEMPLATES).
  await m.add("EMA");
  await expect.poll(() => emaCalcParams(page)).toEqual([[9]]);

  // Open its settings via the legend gear. The action icons reveal on hover; the row
  // + gear are in the DOM regardless, so hover the row then force-click the gear
  // (the chart canvas would otherwise intercept a normal pointer event).
  const emaRow = page.locator(".cl-row.cl-ind", { hasText: "EMA" }).first();
  await emaRow.hover({ force: true });
  await emaRow.locator('.cl-icon[title="Settings"]').click({ force: true });
  await expect(page.locator(".modal.ind-settings")).toBeVisible();

  // Change Length 9 -> 21 (Inputs tab, MA panel's first Length input).
  const lengthInput = page.locator(".modal.ind-settings .ind-row", { hasText: "Length" })
    .first()
    .locator('input[type="number"]');
  await lengthInput.fill("21");
  await lengthInput.blur();

  // Defaults -> Save as default, then close.
  await page.locator(".ind-def-menu button", { hasText: "Defaults" }).click();
  await page.locator(".ind-def-dropdown li", { hasText: "Save as default" }).click();
  await page.locator(".modal.ind-settings button", { hasText: "Ok" }).click();
  await expect(page.locator(".modal.ind-settings")).toBeHidden();

  // The existing EMA is now length 21; persisted to its own config.
  await expect.poll(() => emaCalcParams(page)).toEqual([[21]]);

  // Add a SECOND EMA — it must seed from the saved default (21), not the baseline (9).
  await m.add("EMA");
  await expect.poll(() => emaCalcParams(page).then((p) => p.map((x) => x[0]).sort((a, b) => a - b))).toEqual([
    21, 21,
  ]);
});
