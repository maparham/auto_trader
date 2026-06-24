import { test, expect } from "@playwright/test";
import { stubStateApi } from "./helpers";

// Upgrade path: a pre-tabs install stored its layout under un-namespaced keys.
// On first load those must migrate into the first tab's namespace so existing
// users don't lose their drawings / indicators. With named layouts, the bare
// `tabs` workspace is ALSO wrapped into a named default layout (see
// migrateToNamedLayouts), and the bare `tabs`/`activeTab` keys are retired.
test("legacy un-namespaced layout migrates into a named default layout", async ({ page }) => {
  await stubStateApi(page); // empty backend → seeded localStorage wins
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__seeded")) {
      localStorage.clear();
      // Seed legacy keys (no `.tab.<id>.` prefix), as old builds wrote them.
      localStorage.setItem("auto-trader.symbol", JSON.stringify({
        epic: "US100", name: "US Tech 100", status: null, pricePrecision: 2,
      }));
      localStorage.setItem("auto-trader.period", JSON.stringify({
        resolution: "HOUR", label: "1H",
      }));
      localStorage.setItem("auto-trader.indicators", JSON.stringify(["MA"]));
      localStorage.setItem(
        "auto-trader.drawings.US100",
        JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 100 }] }]),
      );
      sessionStorage.setItem("__seeded", "1");
    }
  });
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  // One tab restored from the migrated default layout.
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);

  const state = await page.evaluate(() => {
    const layouts = JSON.parse(localStorage.getItem("auto-trader.layouts") || "[]");
    const defId = JSON.parse(localStorage.getItem("auto-trader.defaultLayoutId") || "null");
    const activeLayoutId = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
    const body = layouts[0]
      ? JSON.parse(localStorage.getItem(`auto-trader.layout.${layouts[0].id}`) || "null")
      : null;
    // The migrated layout's single tab reuses its primary scope for content.
    const tabId = body?.tabs?.[0]?.id;
    const ind = tabId && localStorage.getItem(`auto-trader.tab.${tabId}.indicators`);
    const draw = tabId && localStorage.getItem(`auto-trader.tab.${tabId}.drawings.US100`);
    return {
      layoutCount: layouts.length,
      defId,
      activeLayoutId,
      indicators: ind ? JSON.parse(ind) : null,
      drawings: draw ? JSON.parse(draw) : null,
      // Bare keys retired.
      bareTabs: localStorage.getItem("auto-trader.tabs"),
      bareActiveTab: localStorage.getItem("auto-trader.activeTab"),
      legacyIndicators: localStorage.getItem("auto-trader.indicators"),
      legacyDrawings: localStorage.getItem("auto-trader.drawings.US100"),
    };
  });

  // Bare `tabs` became exactly one named default layout, adopted as active here.
  expect(state.layoutCount).toBe(1);
  expect(state.defId).not.toBeNull();
  expect(state.activeLayoutId).toBe(state.defId);
  // The legacy per-tab layout content survived under the migrated tab's scope…
  expect(state.indicators).toEqual(["MA"]);
  expect(state.drawings).toHaveLength(1);
  // …and the originals (both un-namespaced AND the bare tabs keys) are gone.
  expect(state.legacyIndicators).toBeNull();
  expect(state.legacyDrawings).toBeNull();
  expect(state.bareTabs).toBeNull();
  expect(state.bareActiveTab).toBeNull();
});
