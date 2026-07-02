import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The TV-style left drawing sidebar: one "Drawing tools" flyout with glyphs
// + stars, favorites zone, last-used arming, and the bulk cluster. Interactive
// draw-to-completion is NOT driven here (headless synthetic-click limitation,
// same as tab-drawings.spec.ts) — arming + state effects are.
test("draw sidebar: flyout, favorites, last-used, bulk buttons", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  const sidebar = page.locator(".draw-sidebar");
  await expect(sidebar).toBeVisible();

  // The old toolbar dropdown is gone.
  await expect(page.locator(".toolbar button", { hasText: "Draw" })).toHaveCount(0);

  // Drawing tools flyout opens; rows show glyph + label; outside click closes.
  const toolFamily = sidebar.locator(".ds-family").first();
  await toolFamily.hover();
  await toolFamily.locator(".ds-caret").click();
  const flyout = sidebar.locator(".ds-flyout");
  await expect(flyout).toBeVisible();
  await expect(flyout.locator(".ds-fly-section")).toHaveText("Drawing tools");
  await expect(flyout.locator(".ds-row")).toHaveCount(8);
  await expect(flyout.locator(".ds-row").first()).toContainText("Trend line");
  await expect(flyout.locator(".ds-row svg").first()).toBeVisible(); // glyph

  // Esc closes an open flyout (without needing chart focus).
  await page.keyboard.press("Escape");
  await expect(flyout).toHaveCount(0);
  await toolFamily.hover();
  await toolFamily.locator(".ds-caret").click();
  await expect(flyout).toBeVisible();

  // Star "Ray" → favorites button appears at the sidebar top and persists.
  const rayRow = flyout.locator(".ds-row", { hasText: "Ray" });
  await rayRow.hover();
  await rayRow.locator(".ind-star").click();
  await expect(sidebar.locator("button[title='Ray (favorite)']")).toBeVisible();
  // The favorites strip collapses/expands via the slim toggle under the tool button.
  const favToggle = sidebar.locator(".ds-fav-toggle");
  await favToggle.click();
  await expect(sidebar.locator("button[title='Ray (favorite)']")).toHaveCount(0);
  await favToggle.click();
  await expect(sidebar.locator("button[title='Ray (favorite)']")).toBeVisible();
  const favs = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes("drawingFavorites"));
    return k ? JSON.parse(localStorage.getItem(k)!) : [];
  });
  expect(favs).toEqual(["rayLine"]);

  // Picking a tool records last-used: the tool button now shows/arms it.
  await rayRow.click(); // arms Ray, closes flyout
  await expect(flyout).toHaveCount(0);
  await page.keyboard.press("Escape"); // cancel the armed draw
  const lastUsed = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes("lastDrawTools"));
    return k ? JSON.parse(localStorage.getItem(k)!) : {};
  });
  expect(lastUsed.tool).toBe("rayLine");
  await expect(toolFamily.locator(".ds-btn")).toHaveAttribute("title", /Ray/);

  // Favorites survive reload.
  await page.reload();
  await page.locator(".chart canvas").first().waitFor();
  await expect(page.locator(".draw-sidebar button[title='Ray (favorite)']")).toBeVisible();

  // Measure + magnet live on the sidebar now.
  await expect(page.locator(".draw-sidebar .measure-toggle")).toBeVisible();
  await expect(page.locator(".draw-sidebar .magnet-toggle")).toBeVisible();

  // Bulk cluster renders enabled with a ready chart.
  await expect(page.locator(".draw-sidebar .ds-eye")).toBeEnabled();
  await expect(page.locator(".draw-sidebar .ds-trash")).toBeEnabled();

  expect(errors).toEqual([]);
});

// TV: Esc cancels an armed/mid-placement drawing tool, same as it already does
// for the measure ruler (measure-tool.spec.ts). The armed tool doesn't render an
// "on" affordance on the sidebar (unlike the measure toggle), so this checks the
// only observable effects: nothing leaks into the persisted drawing store, and a
// second Escape is a harmless no-op.
test("draw sidebar: Esc cancels an armed drawing tool", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  const drawingCount = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.includes(".drawings."));
      return key ? (JSON.parse(localStorage.getItem(key) || "[]") as unknown[]).length : 0;
    });
  await expect.poll(drawingCount).toBe(0);

  const sidebar = page.locator(".draw-sidebar");
  const toolFamily = sidebar.locator(".ds-family").first();
  await toolFamily.hover();
  await toolFamily.locator(".ds-caret").click();
  const flyout = sidebar.locator(".ds-flyout");
  await flyout.locator(".ds-row", { hasText: "Trend line" }).click(); // arms it, closes flyout

  // Clicking a sidebar row doesn't leave focus on .chart-wrap (same caveat as the
  // measure spec), so focus it explicitly before the keypress.
  await page.locator(".chart-wrap").first().focus();
  await page.keyboard.press("Escape");
  await expect.poll(drawingCount).toBe(0);

  // Second Escape: nothing left to cancel — no-op, no console errors.
  await page.keyboard.press("Escape");
  await expect.poll(drawingCount).toBe(0);

  expect(errors).toEqual([]);
});

// TV-style hide menu: the eye button opens a flyout with 4 toggle rows instead
// of being a plain hide-all toggle.
test("draw sidebar: eye menu — hide drawings/indicators/positions/all", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  const sidebar = page.locator(".draw-sidebar");
  const eyeBtn = sidebar.locator(".ds-eye");
  await expect(eyeBtn).toBeVisible();
  // Click opens the flyout with exactly the 4 rows, in order.
  await eyeBtn.click();
  const flyout = sidebar.locator(".ds-flyout", { hasText: "Hide all" });
  await expect(flyout).toBeVisible();
  const rows = flyout.locator(".ds-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Hide drawings");
  await expect(rows.nth(1)).toContainText("Hide indicators");
  await expect(rows.nth(2)).toContainText("Hide positions and orders");
  await expect(rows.nth(3)).toContainText("Hide all");

  // "Hide drawings" toggles: its row shows a check, the eye button turns `on`.
  await rows.nth(0).click();
  await expect(rows.nth(0).locator(".check")).toHaveText("✓");
  await expect(eyeBtn).toHaveClass(/\bon\b/);
  await expect(flyout).toBeVisible(); // row click does not close the menu

  // "Hide all" sets all three (all four rows check).
  await rows.nth(3).click();
  for (let i = 0; i < 4; i++) {
    await expect(rows.nth(i).locator(".check")).toHaveText("✓");
  }

  // "Hide all" again clears everything; eye button un-`on`s.
  await rows.nth(3).click();
  for (let i = 0; i < 4; i++) {
    await expect(rows.nth(i).locator(".check")).toHaveText("");
  }
  await expect(eyeBtn).not.toHaveClass(/\bon\b/);

  expect(errors).toEqual([]);
});
