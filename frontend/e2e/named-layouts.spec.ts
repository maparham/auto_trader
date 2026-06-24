import { test, expect, type Page } from "@playwright/test";

// Named workspace layouts: a layout = the whole tab set saved under a name. The
// list of layouts + the default sync across instances (backend-mirrored); the
// ACTIVE layout is device-local. No default ⇒ the app opens blank.

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

test("fresh user with no default opens blank, with the layout manager available", async ({ page }) => {
  await statefulBackend(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(0);
  await expect(page.locator(".empty-workspace")).toBeVisible();
  await expect(page.locator(".layout-mgr")).toBeVisible();
  await expect(page.locator(".layout-mgr-name")).toHaveText("Untitled");
});

test("save current as a named layout, set default, reload applies it", async ({ page }) => {
  await statefulBackend(page);
  // Clear ONCE so the reload keeps the device-local activeLayoutId.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__s")) { localStorage.clear(); sessionStorage.setItem("__s", "1"); }
  });
  await page.goto("/");
  await page.locator(".empty-workspace").waitFor();

  // Start a chart from the blank state, then dismiss the symbol-search modal.
  await page.locator(".empty-workspace button").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);

  // Save it as a named layout.
  await page.locator(".layout-mgr > button").click();
  await page.locator(".layout-mgr-foot li", { hasText: "Save current as" }).click();
  await page.locator(".layout-mgr-saveas input").fill("My Workspace");
  await page.locator(".layout-mgr-saveas button").click();
  await expect(page.locator(".layout-mgr-name")).toHaveText("My Workspace");

  // Set it as the default (★ on its row).
  await page.locator(".layout-mgr > button").click();
  await page.locator(".layout-mgr-menu li", { hasText: "My Workspace" }).locator(".act").first().click();
  await page.keyboard.press("Escape");

  // Reload → the default applies; the workspace and name are restored.
  await page.reload();
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".layout-mgr-name")).toHaveText("My Workspace");
});

test("a second device shows the synced default even with empty local storage", async ({ page }) => {
  // Backend already holds a layout + default (as if saved on another device).
  await statefulBackend(page, {
    "auto-trader.layouts": [{ id: "L1", name: "Shared" }],
    "auto-trader.defaultLayoutId": "L1",
    "auto-trader.layout.L1": {
      tabs: [
        {
          id: "t1",
          layout: "1",
          activeCellId: "t1-c0",
          cells: [
            {
              id: "t1-c0",
              symbol: { epic: "US100", name: "US Tech 100", status: null, pricePrecision: 2 },
              period: { resolution: "HOUR", label: "1H" },
              scope: "tab.t1",
            },
          ],
        },
      ],
      activeTabId: "t1",
    },
  });
  await page.addInitScript(() => localStorage.clear()); // brand-new device
  await page.goto("/");
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".layout-mgr-name")).toHaveText("Shared");
});
