import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Chart snapshots: instant camera-save of the focused cell's state (indicators +
// drawings + visible range), browsed in a gallery, and restored into a fresh
// one-cell tab. Covers the full loop: save -> mutate source chart -> restore ->
// new tab has the saved indicator back + a one-shot pendingRange that gets
// consumed once ChartCore positions the window on it.

type IndMap = Map<string, Map<string, { name: string }>>;

// Wait until the currently-focused chart (window.__chart) has candles loaded.
async function waitForChartData(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as { __chart?: { getDataList(): unknown[] } })
            .__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
}

// Active indicator TYPE names on the focused chart (mirrors symbol-template.spec.ts).
async function activeTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: { getIndicatorByPaneId: () => IndMap } })
      .__chart;
    if (!c) return [];
    const out: string[] = [];
    for (const pane of c.getIndicatorByPaneId().values())
      for (const ind of pane.values()) out.push(ind.name);
    return out;
  });
}

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  const open = async () => {
    if (!(await dropdown.isVisible())) await indBtn.click();
    await expect(dropdown).toBeVisible();
  };
  const close = async () => {
    if (await dropdown.isVisible()) await indBtn.click();
    await expect(dropdown).toBeHidden();
  };
  const row = (code: string) =>
    dropdown.locator("li.ind-row", {
      hasText: new RegExp(`\\(${code}\\)$|^${code}$`),
    });
  const add = async (name: string) => {
    await open();
    await dropdown.locator("input").fill(name);
    await row(name).first().click();
    await close();
  };
  return { add };
}

// Remove an indicator via its chart-legend row (the dropdown only adds — removal
// lives on the legend row's trash icon, revealed on hover).
async function removeIndicatorViaLegend(page: Page, shortName: string) {
  const legendRow = page.locator(".chart-legend .cl-row.cl-ind", { hasText: shortName }).first();
  await legendRow.hover();
  await legendRow.locator('button.cl-icon[title="Remove"]').click();
}

test("snapshot: save, restore into new tab with state + marker + range", async ({
  page,
}) => {
  await stubStateApi(page);
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForChartData(page);

  // --- 1. Add an indicator on the source chart. ---
  const m = indicatorMenu(page);
  await m.add("EMA");
  await expect.poll(() => activeTypes(page)).toContain("EMA");

  // --- 2. Save a snapshot (instant camera-save, no dialog — confirmed by the
  // snackbar anchored under the split control). ---
  const saveBtn = page.locator(".snap-save");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const snackbar = page.locator(".snackbar");
  await expect(snackbar).toContainText("Snapshot saved");
  await snackbar.locator(".snackbar-close").click(); // dismiss so it can't overlap later clicks

  // --- 3. Remove the indicator from the source chart, so restoring proves the
  // indicator came FROM the snapshot, not merely still being present live. ---
  await removeIndicatorViaLegend(page, "EMA");
  await expect.poll(() => activeTypes(page)).not.toContain("EMA");

  // --- 4. Open the gallery and restore the snapshot. ---
  await page.click(".snap-gallery");
  const gallery = page.locator(".snapshot-gallery");
  await expect(gallery).toBeVisible();
  const card = gallery.locator(".snap-card").first();
  await expect(card).toBeVisible();
  await card.locator("button", { hasText: "Restore" }).click();
  await expect(gallery).toBeHidden();

  // --- 5. A second tab now exists and is the active/selected one. Only the
  // active tab's cell mounts a ChartCore (tabs are not all mounted at once —
  // __charts is a per-CELL registry for split layouts within a single tab, not
  // a cross-tab one), so __chart itself becomes the new tab's chart once it
  // mounts; wait for its data. ---
  await expect(page.locator(".tab-bar [role=tab]")).toHaveCount(2);
  await expect(page.locator(".tab-bar [role=tab][aria-selected=true]")).toHaveCount(1);
  await waitForChartData(page);

  // The restored chart has the EMA back (state restored from the snapshot blob).
  await expect.poll(() => activeTypes(page)).toContain("EMA");

  // --- 6. Marker meta exists in the new tab's (broker-scope-less, tab-scoped) key
  // — proof the restore path parked a snapshotMarker (ChartCore renders it off this
  // same meta, see ChartCore.tsx's markerMeta effect) — and its one-shot
  // pendingRange is consumed once ChartCore positions the window on it. ---
  await page.waitForFunction(() => {
    const metaKey = Object.keys(localStorage).find((k) =>
      /^auto-trader\.tab\.[^.]+\.snapshotMeta$/.test(k),
    );
    if (!metaKey) return false;
    const meta = JSON.parse(localStorage.getItem(metaKey)!);
    return meta && meta.snapshotId && meta.pendingRange === undefined;
  });

  // --- 7. A restored tab is a READ-ONLY study copy: banner announces it, and all
  // mutating chrome is gone (snapshot control, Template + Indicators menus, alert
  // bell, backtest, draw sidebar); the symbol chip is disabled. ---
  const banner = page.locator(".snapshot-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Read-only");
  await expect(page.locator(".snap-split")).toBeHidden();
  await expect(page.locator(".tmpl-menu button")).toBeHidden();
  await expect(page.locator(".menu button", { hasText: "Indicators" })).toBeHidden();
  await expect(page.locator(".toolbar button.sym")).toBeDisabled();
  await expect(page.locator(".draw-sidebar")).toBeHidden();

  // --- 8. Unlock graduates the tab into a normal editable chart: banner gone,
  // chrome back, meta deleted. The saved snapshot itself stays in the gallery. ---
  await banner.locator("button", { hasText: "Unlock" }).click();
  await page.locator(".confirm-modal button", { hasText: "Unlock" }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator(".snap-split")).toBeVisible();
  await expect(page.locator(".tmpl-menu button", { hasText: "Template" })).toBeVisible();
  await expect(page.locator(".toolbar button.sym")).toBeEnabled();
  await page.waitForFunction(
    () => !Object.keys(localStorage).some((k) => /^auto-trader\.tab\.[^.]+\.snapshotMeta$/.test(k)),
  );

  // --- 9. Controls also behave on the original (never-snapshot) tab. ---
  await page.locator(".tab-bar [role=tab]").first().click();
  await expect(page.locator(".snap-split")).toBeVisible();
  await expect(page.locator(".tmpl-menu button", { hasText: "Template" })).toBeVisible();
});
