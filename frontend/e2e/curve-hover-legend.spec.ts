import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Hovering an indicator's CURVE highlights its legend card (the inverse of the
// existing legend-row → curve highlight). Verified end-to-end: add an EMA, find a
// pixel on its line via the live chart, dispatch a real mousemove there, and assert
// the EMA legend row gains `cl-curve-hover`; moving off the chart clears it.

type Pt = { key: string; result: Array<Record<string, number | undefined>> };
type IndMap = Map<string, Map<string, Pt & { name: string; figures: { key: string }[]; visible?: boolean }>>;

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  const add = async (name: string) => {
    if (!(await dropdown.isVisible())) await indBtn.click();
    await expect(dropdown).toBeVisible();
    await dropdown.locator("input").fill(name);
    await dropdown
      .locator("li.ind-row", { hasText: new RegExp(`\\(${name}\\)$|^${name}$`) })
      .first()
      .click();
    await indBtn.click();
    await expect(dropdown).toBeHidden();
  };
  return { add };
}

// A viewport pixel sitting on the EMA line, computed the same way buildLineCache
// does: take two consecutive finite EMA points, convert to absolute pixels, and
// return the midpoint of the segment (offset by the chart container's page origin).
async function emaLinePixel(page: Page): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(() => {
    const c = (window as unknown as {
      __chart?: {
        getIndicatorByPaneId: () => IndMap;
        getDataList: () => Array<{ timestamp: number }>;
        getVisibleRange: () => { from: number; to: number };
        convertToPixel: (
          v: Array<{ timestamp: number; value: number }>,
          o: { paneId: string; absolute: boolean },
        ) => Array<{ x: number; y: number }>;
      };
    }).__chart;
    if (!c) return null;
    const dl = c.getDataList();
    const vr = c.getVisibleRange();
    for (const [paneId, inds] of c.getIndicatorByPaneId())
      for (const ind of inds.values()) {
        if (ind.name !== "EMA") continue;
        const key = ind.figures[0].key;
        // Collect finite points across the visible range, then take a consecutive
        // pair near the MIDDLE — away from the left edge where the legend card and
        // y-axis warmup gaps sit, so the hovered pixel is unobstructed chart area.
        const pts: Array<{ timestamp: number; value: number }> = [];
        for (let i = vr.from; i < Math.min(vr.to, dl.length); i++) {
          const v = ind.result[i]?.[key];
          const k = dl[i];
          if (k && typeof v === "number" && Number.isFinite(v))
            pts.push({ timestamp: k.timestamp, value: v });
        }
        if (pts.length < 2) return null;
        const m = Math.floor(pts.length / 2);
        const px = c.convertToPixel([pts[m - 1], pts[m]], { paneId, absolute: true });
        return { x: (px[0].x + px[1].x) / 2, y: (px[0].y + px[1].y) / 2 };
      }
    return null;
  });
  if (!pt) throw new Error("could not locate an EMA line pixel");
  // convertToPixel(absolute) is relative to the chart container, which fills the
  // .chart-wrap and shares its page origin; add that to get viewport pixels.
  const origin = await page.locator(".chart-wrap").first().boundingBox();
  if (!origin) throw new Error("no chart container box");
  return { x: origin.x + pt.x, y: origin.y + pt.y };
}

test("hovering an indicator curve highlights its legend card and shows it selected", async ({
  page,
}) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await indicatorMenu(page).add("EMA");

  const emaRow = page.locator(".cl-ind", { hasText: "EMA" }).first();
  await expect(emaRow).toBeVisible();
  await expect(emaRow).not.toHaveClass(/cl-curve-hover/);

  // Wait until the EMA result has at least two finite points to hover.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const c = (window as unknown as { __chart?: { getIndicatorByPaneId: () => IndMap } }).__chart;
        if (!c) return 0;
        for (const inds of c.getIndicatorByPaneId().values())
          for (const ind of inds.values())
            if (ind.name === "EMA")
              return ind.result.filter((r) => {
                const v = r?.[ind.figures[0].key];
                return typeof v === "number" && Number.isFinite(v);
              }).length;
        return 0;
      }),
    )
    .toBeGreaterThan(2);

  // Count non-transparent pixels on the selection overlay canvas — the curve's
  // selected-mode handles (hollow dots) are painted there, so a hovered curve takes
  // it from blank to non-blank.
  const overlayPaintedPixels = () =>
    page.locator('[data-testid="selection-overlay"]').first().evaluate((el) => {
      const cv = el as HTMLCanvasElement;
      const g = cv.getContext("2d");
      if (!g || cv.width === 0) return 0;
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
      return n;
    });

  expect(await overlayPaintedPixels()).toBe(0); // nothing selected/hovered yet

  const { x, y } = await emaLinePixel(page);
  // Nudge across a few nearby pixels: the segment midpoint should be on the line,
  // but sub-pixel rounding / line thickness means a tiny sweep reliably lands a hit.
  for (let dy = -2; dy <= 2; dy++) {
    await page.mouse.move(x, y + dy);
    if (await emaRow.evaluate((e) => e.classList.contains("cl-curve-hover"))) break;
  }

  // Legend card highlighted AND the curve painted in selected mode (handles).
  await expect(emaRow).toHaveClass(/cl-curve-hover/);
  await expect.poll(overlayPaintedPixels).toBeGreaterThan(0);

  // Move the cursor far off the chart: both the highlight and the handles clear.
  await page.mouse.move(2, 2);
  await expect(emaRow).not.toHaveClass(/cl-curve-hover/);
  await expect.poll(overlayPaintedPixels).toBe(0);
});
