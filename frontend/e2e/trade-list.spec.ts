import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, skipUnlessCapital, stubStateApi } from "./helpers";

// Trade-list panel end-to-end: import a sheet, click a row → the trade's chart
// opens (a fresh tab when nothing shows the symbol) with the trade sketched as
// a tradeBox drawing; a second click REPLACES the box (one at a time). Needs a
// real backend for the daily-candle fetch that shapes the stop — same deal as
// agent-bridge.spec.ts; without one the fetch fails and the box still lands
// (entry/exit-extreme fallback), so the assertions hold either way.

const SHEET = JSON.stringify({
  service: "Smoke",
  sheet: "S1",
  trades: [
    {
      symbol: "MSFT", side: "SHORT",
      entryDate: "08/10/2026", entryPrice: "$507.77",
      exitDate: "08/17/2026", exitPrice: "$485.77",
      pctPL: "4.33%", dollarPL: "$4,400.00",
    },
    {
      symbol: "MSFT", side: "LONG",
      entryDate: "06/01/2026", entryPrice: "$460.00",
      exitDate: "06/22/2026", exitPrice: "$480.00",
      pctPL: "4.35%", dollarPL: "$2,000.00",
    },
    {
      symbol: "AAPL", side: "LONG",
      entryDate: "07/01/2026", entryPrice: "$300.00",
      exitDate: "07/20/2026", exitPrice: "$320.00",
      pctPL: "6.67%", dollarPL: "$2,000.00",
    },
  ],
});

const boxPointer = (page: import("@playwright/test").Page) =>
  page.evaluate(() => localStorage.getItem("auto-trader.tradeListBox"));

test("import a sheet, click rows, get one trade box on the symbol's chart", async ({ page }) => {
  await skipUnlessCapital(page, "its symbol catalogue resolves MSFT");
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Open the panel from the toolbar and import via paste.
  await page.locator(".trade-list-toggle").click();
  await page.locator(".tl-import textarea").fill(SHEET);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  // Every import parks in the review stage first (JSON has no columns to map,
  // but the symbol and degenerate-row checks still run).
  await page.getByRole("button", { name: /^Import 3 trades$/ }).click();
  await expect(page.locator(".tl-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".tl-summary")).toContainText("3 trades");

  // Row 1: no open chart shows MSFT → a NEW tab opens; once its chart mounts
  // and hydrates, the box lands (the pointer is written right after).
  await page.locator(".tl-table tbody tr").nth(0).click();
  await expect(page.locator(".tab-bar")).toContainText("MSFT");
  await expect.poll(() => boxPointer(page), { timeout: 20000 }).toContain('"epic":"MSFT"');
  const ptr1 = JSON.parse((await boxPointer(page))!) as {
    scope: string; epic: string; cellId: string; id: string;
  };

  // The saved drawings for that cell hold exactly one tradeBox, labelled with
  // the trade, its zone spanning entry→exit prices.
  const drawingsKey = `auto-trader.${ptr1.scope}.drawings.${ptr1.epic}`;
  const boxes1 = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k) ?? "[]"),
    drawingsKey,
  ) as Array<{ id: string; name: string; points: Array<{ value: number }>; extendData?: { text?: string } }>;
  const tradeBoxes1 = boxes1.filter((d) => d.name === "tradeBox");
  expect(tradeBoxes1).toHaveLength(1);
  expect(tradeBoxes1[0].id).toBe(ptr1.id);
  expect(tradeBoxes1[0].extendData?.text).toBe("MSFT SHORT 4.33%");
  expect(tradeBoxes1[0].points[0].value).toBeCloseTo(507.77);
  expect(tradeBoxes1[0].points[1].value).toBeCloseTo(485.77);
  // Short: the sketched stop sits ABOVE the entry (past the span's high).
  expect(tradeBoxes1[0].points[2].value).toBeGreaterThan(507.77);

  // Row 2 (same symbol): the chart is reused and the box is REPLACED — new id,
  // still exactly one tradeBox in the saved drawings.
  await page.locator(".tl-table tbody tr").nth(1).click();
  await expect
    .poll(async () => {
      const raw = await boxPointer(page);
      return raw ? (JSON.parse(raw) as { id: string }).id : null;
    }, { timeout: 20000 })
    .not.toBe(ptr1.id);
  const boxes2 = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k) ?? "[]"),
    drawingsKey,
  ) as Array<{ name: string; extendData?: { text?: string } }>;
  const tradeBoxes2 = boxes2.filter((d) => d.name === "tradeBox");
  expect(tradeBoxes2).toHaveLength(1);
  expect(tradeBoxes2[0].extendData?.text).toBe("MSFT LONG 4.35%");

  // Same-tab mode (default ON): AAPL is open nowhere, so instead of a third
  // tab the trade-list tab SWITCHES SYMBOL from MSFT to AAPL.
  const tabCount = await page.locator(".tab-symbol").count();
  await page.locator(".tl-table tbody tr").nth(2).click();
  await expect
    .poll(async () => {
      const raw = await boxPointer(page);
      return raw ? (JSON.parse(raw) as { epic: string }).epic : null;
    }, { timeout: 20000 })
    .toBe("AAPL");
  await expect(page.locator(".tab-symbol")).toHaveCount(tabCount);
  await expect(page.locator(".tab-bar")).toContainText("AAPL");
  await expect(page.locator(".tab-bar")).not.toContainText("MSFT");

  // Library: the import was saved as a named list (sheet label), renameable.
  await page.locator(".tl-back").click();
  await expect(page.locator(".tl-list-name")).toHaveText("Smoke S1");
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator(".tl-rename-input").fill("My smoke trades");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tl-list-name")).toHaveText("My smoke trades");
  // Reopen from the library: same table again.
  await page.locator(".tl-list-open").click();
  await expect(page.locator(".tl-table tbody tr")).toHaveCount(3);
});
