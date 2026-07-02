import { test, expect, type Page } from "@playwright/test";
import { stubStateApi } from "./helpers";

// Two one-cell tabs in the device-local scratch workspace (per-broker key —
// same seeding approach as detach-cell.spec.ts), plus a drawing on t2's
// primary scope so the test can assert content moves with the merged cell.
async function seedTwoTabs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__seeded")) return;
    localStorage.clear();
    const period = { resolution: "HOUR", label: "1H" };
    const tab = (id: string, epic: string) => ({
      id,
      layout: "1",
      activeCellId: `${id}-c0`,
      cells: [
        {
          id: `${id}-c0`,
          symbol: { epic, name: epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}`,
        },
      ],
    });
    const ws = { tabs: [tab("t1", "US100"), tab("t2", "OIL_CRUDE")], activeTabId: "t1" };
    localStorage.setItem("auto-trader.b.capital.scratch", JSON.stringify(ws));
    localStorage.setItem(
      "auto-trader.tab.t2.drawings.OIL_CRUDE",
      JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 70 }] }]),
    );
    sessionStorage.setItem("__seeded", "1");
  });
}

// t1 = 1 cell, t2 = 2 cells, t3 = 2 cells — exercises the checklist's live
// 4-cell cap: t2 and t3 each fit alone (1+2<=4) but not together (1+2+2>4).
async function seedThreeTabs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__seeded")) return;
    localStorage.clear();
    const period = { resolution: "HOUR", label: "1H" };
    const oneCellTab = (id: string, epic: string) => ({
      id,
      layout: "1",
      activeCellId: `${id}-c0`,
      cells: [
        {
          id: `${id}-c0`,
          symbol: { epic, name: epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}`,
        },
      ],
    });
    const twoCellTab = (id: string, epic: string) => ({
      id,
      layout: "2h",
      activeCellId: `${id}-c0`,
      cells: [
        {
          id: `${id}-c0`,
          symbol: { epic, name: epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}`,
        },
        {
          id: `${id}-c1`,
          symbol: { epic, name: epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}.cell.${id}-c1`,
        },
      ],
    });
    const ws = {
      tabs: [oneCellTab("t1", "US100"), twoCellTab("t2", "OIL_CRUDE"), twoCellTab("t3", "GOLD")],
      activeTabId: "t1",
    };
    localStorage.setItem("auto-trader.b.capital.scratch", JSON.stringify(ws));
    sessionStorage.setItem("__seeded", "1");
  });
}

test("merge checklist disables a row live once the running total would exceed 4 cells", async ({ page }) => {
  await seedThreeTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();

  const t2Row = page.locator(".merge-menu .merge-row", { hasText: "OIL_CRUDE" });
  const t3Row = page.locator(".merge-menu .merge-row", { hasText: "GOLD" });

  // 1. Both fit against the target alone (1+2<=4 each).
  await expect(t2Row).toBeEnabled();
  await expect(t3Row).toBeEnabled();

  // 2. Ticking t2 pushes the running total to 3; adding t3's 2 cells would
  // make 5, so t3 disables live with the exceeds-cap title.
  await t2Row.click();
  await expect(t3Row).toBeDisabled();
  await expect(t3Row).toHaveAttribute("title", "Would exceed 4 charts");

  // 3. Unticking t2 brings the total back to 1 and t3 re-enables.
  await t2Row.click();
  await expect(t3Row).toBeEnabled();
  await expect(t3Row).not.toHaveAttribute("title", "Would exceed 4 charts");

  // 4. Tick t3 only and confirm — t3 (2 cells) merges into t1 (1 cell) for 3
  // total; t2 is untouched and remains its own tab.
  await t3Row.click();
  await page.locator(".merge-menu .merge-confirm").click();

  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
  await expect(page.locator(".chart-cell")).toHaveCount(3);
});

test("context-menu merge collapses t2 into t1 with content, focus and crosshair sync", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();
  await page.locator(".merge-menu .merge-row", { hasText: "OIL_CRUDE" }).click();
  await page.locator(".merge-menu .merge-confirm").click();

  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // Persisted shape: one 2h tab with interval/crosshair/date-range sync on,
  // focused on the merged-in cell; t2's drawing re-scoped under t1 and the old
  // scope purged. Poll — the scratch autosave effect commits asynchronously.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        const t = ws?.tabs?.[0];
        return {
          tabCount: ws?.tabs?.length,
          layout: t?.layout,
          sync: [t?.syncInterval, t?.syncCrosshair, t?.syncTime],
          active: t?.activeCellId,
          moved: localStorage.getItem("auto-trader.tab.t1.cell.t2-c0.drawings.OIL_CRUDE") != null,
          purged: localStorage.getItem("auto-trader.tab.t2.drawings.OIL_CRUDE") == null,
        };
      }),
    )
    .toEqual({
      tabCount: 1,
      layout: "2h",
      sync: [true, true, true],
      active: "t2-c0",
      moved: true,
      purged: true,
    });

  // Round-trip: detach still splits a merged-in cell back out into its own tab.
  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
});

test("dropping a chip on another chip's center merges the two tabs", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  const tabs = page.locator(".tab-bar .tab");
  const b = (await tabs.nth(0).boundingBox())!;
  // Center of the target chip = merge zone (edges still mean reorder — covered
  // by tab-reorder.spec.ts, which this must not break).
  await tabs.nth(1).dragTo(tabs.nth(0), {
    targetPosition: { x: b.width / 2, y: b.height / 2 },
  });

  await expect(tabs).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
});

test("dragging a chip onto the chart merges it into the active tab", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // t1 is active; drag t2's chip onto the chart. Drop on the right half →
  // incoming cell lands after the existing one.
  const grid = page.locator(".chart-grid");
  const g = (await grid.boundingBox())!;
  await page.locator(".tab-bar .tab").nth(1).dragTo(grid, {
    targetPosition: { x: g.width * 0.75, y: g.height / 2 },
  });

  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  // Order: existing t1 cell first (drop was "after").
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        return ws?.tabs?.[0]?.cells?.map((c: { id: string }) => c.id);
      }),
    )
    .toEqual(["t1-c0", "t2-c0"]);
});

test("dragging a chip onto the chart's left half inserts before the existing cell", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // t1 is active; drag t2's chip onto the chart. Drop on the left half →
  // incoming cell lands before the existing one.
  const grid = page.locator(".chart-grid");
  const g = (await grid.boundingBox())!;
  await page.locator(".tab-bar .tab").nth(1).dragTo(grid, {
    targetPosition: { x: g.width * 0.25, y: g.height / 2 },
  });

  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  // Order: incoming t2 cell first (drop was "before").
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        return ws?.tabs?.[0]?.cells?.map((c: { id: string }) => c.id);
      }),
    )
    .toEqual(["t2-c0", "t1-c0"]);
});
