import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// The user-defined sub-pane order must be changeable via the legend "more" menu and
// must survive a reload. Backend stubbed empty so hydrate doesn't overwrite storage.

type IndMap = Map<string, Map<string, { name: string }>>;

// The top-to-bottom order of sub-pane indicator names (skip the candle pane).
async function subPaneNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: { getIndicatorByPaneId: () => IndMap } }).__chart;
    if (!c) return [];
    const out: string[] = [];
    for (const [paneId, inds] of c.getIndicatorByPaneId())
      if (paneId !== "candle_pane") for (const ind of inds.values()) out.push(ind.name);
    return out;
  });
}

async function waitForData(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
        return c ? c.getDataList().length : 0;
      }),
    { timeout: 20000 })
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

// Open the "more" (⋯) menu for the sub-pane legend row whose text starts with `name`.
async function openMoreMenu(page: Page, name: string) {
  const row = page.locator(".sub-pane-legend .cl-row", { hasText: name }).first();
  await row.hover();
  await row.locator('button[title="More"]').click();
}

// Click the ↑ or ↓ arrow on the sub-pane legend row whose text starts with `name`.
async function clickArrow(page: Page, name: string, dir: "up" | "down") {
  const row = page.locator(".sub-pane-legend .cl-row", { hasText: name }).first();
  await row.hover();
  await row.locator(`button.sp-move-${dir}`).click();
}

test("reorder sub-panes via the more-menu and persist across reload", async ({ page }) => {
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
  await m.add("VOL");
  await m.add("RSI");
  await m.add("MACD");

  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI", "MACD"]);

  // Move RSI down one → VOL, MACD, RSI
  await openMoreMenu(page, "RSI");
  await page.locator(".ctxmenu .ctx-item", { hasText: "Move down" }).click();
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);

  // Reload → order persists
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);
});

test("reorder sub-panes with the ↑/↓ arrow buttons", async ({ page }) => {
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
  await m.add("VOL");
  await m.add("RSI");
  await m.add("MACD");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI", "MACD"]);

  // MACD up one → VOL, MACD, RSI
  await clickArrow(page, "MACD", "up");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);

  // The top pane has no ↑ arrow; the bottom pane has no ↓ arrow.
  const volRow = page.locator(".sub-pane-legend .cl-row", { hasText: "VOL" }).first();
  await volRow.hover();
  await expect(volRow.locator("button.sp-move-up")).toHaveCount(0);
  const rsiRow = page.locator(".sub-pane-legend .cl-row", { hasText: "RSI" }).first();
  await rsiRow.hover();
  await expect(rsiRow.locator("button.sp-move-down")).toHaveCount(0);
});

test("reorder sub-panes by dragging the legend handle", async ({ page }) => {
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
  await m.add("VOL");
  await m.add("RSI");
  await m.add("MACD");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI", "MACD"]);

  // Drag VOL's handle down to land BETWEEN RSI and MACD → RSI, VOL, MACD. With a
  // 2-pane drag the destination clamps to the last slot either way, masking an
  // off-by-one in the remove-then-reinsert math; spanning one sibling discriminates:
  // the buggy path (counting the moving pane's own bound) would wrongly land VOL
  // after MACD (["RSI", "MACD", "VOL"]) instead of between RSI and MACD.
  const volHandle = page
    .locator(".sub-pane-legend", { hasText: "VOL" })
    .locator(".sp-drag-handle");
  const macdCard = page.locator(".sub-pane-legend", { hasText: "MACD" });
  const from = await volHandle.boundingBox();
  const to = await macdCard.boundingBox();
  if (!from || !to) throw new Error("missing boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y - 5, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => subPaneNames(page)).toEqual(["RSI", "VOL", "MACD"]);
});

// Rendering regressions the model-order tests can't catch: the ↑/↓ arrows must be
// STROKED line icons (not filled — the legend's .cl-icon-svg svg forces fill, which
// turns an open arrow path into a faint filled wedge), and the drag grip must be
// visible WITHOUT hovering (it was opacity:0 until hover, so users couldn't find or
// grab it — "nothing happens").
test("reorder controls render correctly: stroked arrows + always-visible grip", async ({
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
  await m.add("VOL");
  await m.add("RSI");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI"]);

  // The grip is visible at rest — no hover needed (opacity 1, not 0).
  const handleOpacity = await page.evaluate(() => {
    const h = document.querySelector(".sub-pane-legend .sp-drag-handle");
    return h ? getComputedStyle(h).opacity : null;
  });
  expect(handleOpacity).toBe("1");

  // The move arrows are stroked, not filled — otherwise the arrow renders as a filled
  // blob with no stem. Grab any ↑ arrow (the bottom pane, RSI, has one — top pane VOL
  // has no ↑ since it's index 0); the selector isn't card-scoped, so it finds it.
  const arrow = await page.evaluate(() => {
    const svg = document.querySelector(".sub-pane-legend .sp-move-up svg path");
    if (!svg) return null;
    const cs = getComputedStyle(svg);
    return { fill: cs.fill, stroke: cs.stroke };
  });
  expect(arrow).not.toBeNull();
  expect(arrow!.fill).toBe("none");
  expect(arrow!.stroke).not.toBe("none");
});
