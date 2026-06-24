import type { Page } from "@playwright/test";

// Since named layouts landed, the app opens BLANK when there's no default layout
// (see App.resolveStartup). Most specs assume one chart is already open on first
// load, so they seed a single-tab default layout into localStorage before the app
// boots — the equivalent of a returning user whose default is "one US100 1H chart".
//
// Guarded by a sessionStorage flag so the seed runs ONCE (before the first load);
// a reload must NOT re-seed, or it would wipe the persistence the spec is testing.
//
// Pass a tabId so the spec can address the primary cell's scope (`tab.<tabId>`).
export async function seedSingleChartDefault(page: Page, tabId = "t1"): Promise<void> {
  await page.addInitScript((id: string) => {
    if (sessionStorage.getItem("__seeded")) return;
    localStorage.clear();
    const symbol = { epic: "US100", name: "US Tech 100", status: null, pricePrecision: 2 };
    const period = { resolution: "HOUR", label: "1H" };
    const ws = {
      tabs: [
        {
          id,
          layout: "1",
          activeCellId: `${id}-c0`,
          cells: [{ id: `${id}-c0`, symbol, period, scope: `tab.${id}` }],
        },
      ],
      activeTabId: id,
    };
    localStorage.setItem("auto-trader.layouts", JSON.stringify([{ id: "L0", name: "Default" }]));
    localStorage.setItem("auto-trader.layout.L0", JSON.stringify(ws));
    localStorage.setItem("auto-trader.defaultLayoutId", JSON.stringify("L0"));
    localStorage.setItem("auto-trader.activeLayoutId", JSON.stringify("L0"));
    sessionStorage.setItem("__seeded", "1");
  }, tabId);
}

// Stub the backend state API so a spec runs hermetically (no real backend, no
// cross-test bleed): GET returns an empty snapshot (so seeded localStorage wins),
// PUT/DELETE succeed silently. Use in specs that don't exercise sync itself.
export async function stubStateApi(page: Page): Promise<void> {
  await page.route("**/api/state", (r) => r.fulfill({ status: 200, body: "{}" }));
  await page.route("**/api/state/**", (r) => r.fulfill({ status: 204, body: "" }));
}
