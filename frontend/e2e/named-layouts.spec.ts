import { test, expect, type Page } from "@playwright/test";

// Named workspace layouts: a layout = the whole tab set saved under a name. The
// list of layouts + the default sync across instances (backend-mirrored); the
// ACTIVE layout is per browser tab. A brand-new broker (no layouts at all) opens
// on a default chart; one that HAS layouts but no default opens blank.
//
// Workspace roots are per broker (`auto-trader.b.<broker>.*`); a fresh browser
// resolves to capital, so every seeded key below carries that prefix.
const ROOT = "auto-trader.b.capital";
const cell = (tabId: string, epic: string, resolution: string, label: string) => ({
  id: `${tabId}-c0`,
  symbol: { epic, name: epic, status: null, pricePrecision: 2 },
  period: { resolution, label },
  scope: `tab.${tabId}`,
});
const oneCellTab = (id: string, epic: string, resolution = "HOUR", label = "1H") => ({
  id,
  layout: "1",
  activeCellId: `${id}-c0`,
  cells: [cell(id, epic, resolution, label)],
});

// A backend stub that actually retains PUT/DELETE so cross-load persistence works
// (the simple {} stub used elsewhere is fine when localStorage carries the state,
// but the "new device" case needs the backend to hand back what was stored).
async function statefulBackend(page: Page, seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(store) }),
  );
  await page.route("**/api/state/**", (r) => {
    const url = new URL(r.request().url());
    const key = decodeURIComponent(url.pathname.split("/api/state/")[1]);
    if (r.request().method() === "PUT") store[key] = JSON.parse(r.request().postData()!).value;
    if (r.request().method() === "DELETE") delete store[key];
    return r.fulfill({ status: 204, body: "" });
  });
  return store;
}

test("a brand-new user opens on a default chart, with the layout manager available", async ({ page }) => {
  await statefulBackend(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".empty-workspace")).toHaveCount(0);
  await expect(page.locator(".layout-mgr")).toBeVisible();
  await expect(page.locator(".layout-mgr-label")).toHaveText("Untitled");
});

test("saved layouts but no default opens blank, with the layout manager available", async ({ page }) => {
  // Seed localStorage AND the backend with the same index (a snapshot that
  // lacked these keys would prune them on hydrate). No default, no active.
  const index = [{ id: "L1", name: "Mine" }];
  const body = { tabs: [oneCellTab("t1", "US100")], activeTabId: "t1" };
  await statefulBackend(page, {
    [`${ROOT}.layouts`]: index,
    [`${ROOT}.layout.L1`]: body,
  });
  await page.addInitScript(
    ([root, idx, b]: [string, unknown, unknown]) => {
      localStorage.clear();
      localStorage.setItem(`${root}.layouts`, JSON.stringify(idx));
      localStorage.setItem(`${root}.layout.L1`, JSON.stringify(b));
    },
    [ROOT, index, body] as [string, unknown, unknown],
  );
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".empty-workspace")).toBeVisible();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(0);
  await expect(page.locator(".layout-mgr")).toBeVisible();
  await expect(page.locator(".layout-mgr-label")).toHaveText("Untitled");
});

test("save current as a named layout, set default, reload applies it", async ({ page }) => {
  await statefulBackend(page);
  // Clear ONCE so the reload keeps this tab's active layout id.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__s")) { localStorage.clear(); sessionStorage.setItem("__s", "1"); }
  });
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  // A brand-new user starts on the default chart (unsaved: "Untitled").
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".layout-mgr-label")).toHaveText("Untitled");

  // Save it as a named layout ("Make a copy…" names the current workspace).
  await page.locator(".layout-mgr-name-btn").click();
  await page.locator(".layout-mgr-menu .layout-mgr-action", { hasText: "Make a copy" }).click();
  await page.locator(".layout-mgr-saveas input").fill("My Workspace");
  await page.locator(".layout-mgr-saveas button").click();
  await expect(page.locator(".layout-mgr-label")).toHaveText("My Workspace");
  await expect(page.locator(".layout-mgr-star")).toHaveCount(0);

  // Set it as the default (star on its row).
  await page.locator(".layout-mgr-name-btn").click();
  await page
    .locator(".layout-mgr-list li", { hasText: "My Workspace" })
    .locator(".act-star")
    .click();
  await expect(page.locator(".layout-mgr-star")).toBeVisible();
  await page.locator(".layout-mgr-name-btn").click(); // close the menu

  // Reload: the layout applies with its name, and it is still the default.
  await page.reload();
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".layout-mgr-label")).toHaveText("My Workspace");
  await expect(page.locator(".layout-mgr-star")).toBeVisible();
});

test("a second device shows the synced default even with empty local storage", async ({ page }) => {
  // Backend already holds a layout + default (as if saved on another device).
  // Two tabs, so it can't be mistaken for the one-tab brand-new default.
  await statefulBackend(page, {
    [`${ROOT}.layouts`]: [{ id: "L1", name: "Shared" }],
    [`${ROOT}.defaultLayoutId`]: "L1",
    [`${ROOT}.layout.L1`]: {
      tabs: [oneCellTab("t1", "US100"), oneCellTab("t2", "OIL_CRUDE", "DAY", "1D")],
      activeTabId: "t1",
    },
  });
  await page.addInitScript(() => localStorage.clear()); // brand-new device
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await expect(page.locator(".tab-bar .tab .tab-period")).toHaveText(["1H", "1D"]);
  await expect(page.locator(".layout-mgr-label")).toHaveText("Shared");
});
