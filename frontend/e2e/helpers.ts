import type { Page } from "@playwright/test";

// Workspace roots are per broker (`auto-trader.b.<broker>.*`, see persist/core.ts).
// The seeds write the device-local SCRATCH workspace of the broker the app boots
// on (see e2eBroker), which is what the app shows when no named layout is active,
// and which never mirrors to /api/state. An unprefixed key would be ignored and the
// app would boot its own one-tab default with a random tab id.
//
// Guarded by a sessionStorage flag so the seed runs ONCE (before the first load);
// a reload must NOT re-seed, or it would wipe the persistence the spec is testing.
type SeedTab = { id: string; epic: string; name?: string };

// The broker the app boots on is defaultBrokerId(): capital when the backend has
// it (local dev with credentials), else its first data broker (CI has none, so
// dukascopy). Resolve it the same way from the live /api/brokers, and hand back
// that payload for the seed to store as the app's `brokersCache`. Without the
// cache a fresh browser guesses capital, 404s, and falls back onto a different
// workspace than the one seeded.
export type E2EBroker = { root: string; cache: string };

export async function e2eBroker(page: Page): Promise<E2EBroker> {
  const info = (await (await page.request.get("/api/brokers")).json()) as { data: string[] };
  const broker = info.data.includes("capital") ? "capital" : info.data[0];
  return { root: `auto-trader.b.${broker}`, cache: JSON.stringify(info) };
}

async function seedScratchTabs(page: Page, tabs: SeedTab[]): Promise<void> {
  const b = await e2eBroker(page);
  await page.addInitScript(([seed, { root, cache }]: [SeedTab[], E2EBroker]) => {
    if (sessionStorage.getItem("__seeded")) return;
    localStorage.clear();
    localStorage.setItem("brokersCache", cache);
    const period = { resolution: "HOUR", label: "1H" };
    const tab = ({ id, epic, name }: SeedTab) => ({
      id,
      layout: "1",
      activeCellId: `${id}-c0`,
      cells: [
        {
          id: `${id}-c0`,
          symbol: { epic, name: name ?? epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}`,
        },
      ],
    });
    const ws = { tabs: seed.map(tab), activeTabId: seed[0].id };
    localStorage.setItem(`${root}.scratch`, JSON.stringify(ws));
    sessionStorage.setItem("__seeded", "1");
  }, [tabs, b] as [SeedTab[], E2EBroker]);
}

// One US100 1H chart. Pass a tabId so the spec can address the primary cell's
// scope (`tab.<tabId>`).
export async function seedSingleChartDefault(page: Page, tabId = "t1"): Promise<void> {
  await seedScratchTabs(page, [{ id: tabId, epic: "US100", name: "US Tech 100" }]);
}

// TWO tabs (t1, t2), each a single-cell chart on a distinct epic, with the first
// active.
export async function seedTwoChartTabs(
  page: Page,
  epicA = "US100",
  epicB = "OIL_CRUDE",
): Promise<void> {
  await seedScratchTabs(page, [
    { id: "t1", epic: epicA },
    { id: "t2", epic: epicB },
  ]);
}

// Stub the backend state API so a spec runs hermetically (no real backend, no
// cross-test bleed): GET returns an empty snapshot (so seeded localStorage wins),
// PUT/DELETE succeed silently. Use in specs that don't exercise sync itself.
export async function stubStateApi(page: Page): Promise<void> {
  await page.route("**/api/state", (r) => r.fulfill({ status: 200, body: "{}" }));
  await page.route("**/api/state/**", (r) => r.fulfill({ status: 204, body: "" }));
}
