import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// Global per-drawing defaults (TradingView "Defaults"): saving a drawing type's
// default via the settings modal must (a) persist under
// `auto-trader.drawingDefault.<overlayName>` and (b) seed freshly-DRAWN overlays of
// that same name. We drive the single-click Horizontal line tool (overlay name
// `horizontalStraightLine`) — the same headless-reliable interaction tab-drawings
// uses — because two-click draws (segment) don't finalize under headless synthetic
// input. Backend is stubbed empty so hydrateFromBackend can't overwrite localStorage.

// The persisted drawings array for the (single) chart under test. The app mints a
// fresh tab id at runtime, so rather than resolve it we read the sole `.drawings.`
// key — this spec only ever has one chart open.
async function activeDrawings(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes(".drawings."));
    return key ? (JSON.parse(localStorage.getItem(key) || "[]") as Array<Record<string, unknown>>) : [];
  });
}

test("saving a drawing default persists it and seeds freshly-drawn overlays", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();
  // A drawing placement needs candles loaded (convertFromPixel → a real price), or
  // the click can't resolve to a point and no overlay is created.
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

  // Place a single-click Horizontal line at the canvas center (Lines family flyout).
  const drawHLine = async () => {
    const lines = page.locator(".draw-sidebar .ds-family").first();
    await lines.hover();
    await lines.locator(".ds-caret").click();
    await page.locator(".draw-sidebar .ds-flyout .ds-row", { hasText: "Horizontal line" }).click();
    const box = await page.locator(".chart canvas").first().boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    return box!;
  };

  const box = await drawHLine();
  await expect.poll(() => activeDrawings(page).then((d) => d.length)).toBe(1);

  // Open the drawing's settings modal by double-clicking the line. The dblclick path
  // reads klinecharts' hovered-overlay state, so move onto the line first to trigger
  // its onMouseEnter, then double-click.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.35, cy);
  await page.mouse.move(cx, cy);
  await page.mouse.dblclick(cx, cy);
  await expect(page.locator(".modal.ind-settings")).toBeVisible();

  // Drag the modal to the top by its header so the footer's downward-opening
  // "Defaults" dropdown has room for all its items in the viewport.
  const head = page.locator(".modal.ind-settings .modal-head");
  const hb = (await head.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, 60, { steps: 8 });
  await page.mouse.up();

  // Visibility tab -> turn OFF "Show price label on axis" (a distinctive, observable
  // flag to prove the seed transfers).
  await page.locator(".modal.ind-settings .ind-tab", { hasText: "Visibility" }).click();
  const priceLabel = page
    .locator(".modal.ind-settings .ind-check", { hasText: "Show price label on axis" })
    .locator('input[type="checkbox"]');
  await priceLabel.uncheck();

  // Defaults -> Save as default, then close.
  await page.locator(".ind-def-menu button", { hasText: "Defaults" }).click();
  await page.locator(".ind-def-dropdown li", { hasText: "Save as default" }).click();

  // (a) Persisted under the overlay-name key, with priceLabels captured false.
  const stored = await page.evaluate(() =>
    localStorage.getItem("auto-trader.drawingDefault.horizontalStraightLine"),
  );
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!).priceLabels).toBe(false);

  // Named template path: Defaults -> Save as template… -> name it -> Save. The menu
  // closes after Save-as-default, so reopen it.
  await page.locator(".ind-def-menu button", { hasText: "Defaults" }).click();
  await page.locator(".ind-def-dropdown li", { hasText: "Save as template" }).click();
  const nameInput = page.locator(".ind-def-name input");
  await nameInput.fill("Red");
  await nameInput.press("Enter");
  const presets = await page.evaluate(() =>
    localStorage.getItem("auto-trader.drawingPresets.horizontalStraightLine"),
  );
  expect(presets).not.toBeNull();
  expect(Object.keys(JSON.parse(presets!))).toContain("Red");
  // Reopen the menu — the saved template is listed with a delete affordance.
  await page.locator(".ind-def-menu button", { hasText: "Defaults" }).click();
  await expect(page.locator(".ind-def-preset", { hasText: "Red" })).toBeVisible();

  await page.locator(".modal.ind-settings button", { hasText: "Ok" }).click();
  await expect(page.locator(".modal.ind-settings")).toBeHidden();

  // (b) A second Horizontal line seeds from the default: its persisted extendData
  // carries priceLabels:false (the seeded flag), unlike a plain draw (true/absent).
  await drawHLine();
  await expect.poll(() => activeDrawings(page).then((d) => d.length)).toBe(2);
  const drawings = await activeDrawings(page);
  const seeded = drawings[drawings.length - 1];
  expect((seeded.extendData as { priceLabels?: boolean } | undefined)?.priceLabels).toBe(false);

  expect(errors).toEqual([]);
});
