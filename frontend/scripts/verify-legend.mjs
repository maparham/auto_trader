// Verifies the DOM <ChartLegend>: crisp DOM rows (not canvas), values track the
// crosshair, and the eye/gear/trash icons work — in both dark and light themes.
import { chromium } from "playwright";

const base = process.argv[2] || "http://localhost:5173/";
const browser = await chromium.launch();
const fails = [];
const log = (m) => console.log(m);

async function run(theme) {
  log(`\n=== THEME: ${theme} ===`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  // Set the theme before the app loads, and clear the (global) persisted indicator
  // set so each theme run starts with a clean legend (no EMA left over from the
  // previous run — the active set is persisted across reloads).
  await page.addInitScript((t) => {
    localStorage.setItem("auto-trader.settings", JSON.stringify({ theme: t }));
    localStorage.removeItem("auto-trader.indicators");
  }, theme);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500);

  const check = (cond, msg) => {
    log(`  ${cond ? "✓" : "✗"} ${msg}`);
    if (!cond) fails.push(`[${theme}] ${msg}`);
  };

  // 1) The legend is real DOM (not canvas). The OHLC row exists with a symbol.
  const legend = page.locator(".chart-legend");
  check(await legend.count() === 1, "DOM .chart-legend present");
  const symText = (await page.locator(".cl-sym").first().textContent())?.trim();
  check(!!symText, `symbol row rendered as DOM text ("${symText}")`);
  const cText = (await page.locator(".cl-ohlc .cl-ohlc-val").last().textContent())?.trim();
  check(/[0-9]/.test(cText || ""), `OHLC values populated ("C ${cText}")`);

  // 2) Add EMA via the Indicators menu; its row appears with a value.
  await page.getByTitle("Indicators, metrics, and strategies").click();
  await page.getByPlaceholder("search indicators…").fill("EMA");
  await page.locator(".dropdown li", { hasText: "EMA" }).first().click();
  await page.keyboard.press("Escape");
  // A freshly-added indicator's legend row appears within ≤1s (the row list is
  // re-derived on the 1s tick — the documented cut, consistent with the selection
  // cache), so wait past that before asserting the row exists.
  const emaRow = page.locator(".cl-ind", { hasText: "EMA" }).first();
  await emaRow.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  check(await emaRow.count() === 1, "EMA indicator row added to DOM legend");
  const emaVal = (await emaRow.locator(".cl-fig-val").first().textContent())?.trim();
  check(/[0-9]/.test(emaVal || ""), `EMA figure value shown ("${emaVal}")`);

  // 2b) The EMA card shrink-wraps its content — its width must be MUCH narrower
  //     than the (wider) OHLC row, not stretched to match it (flex align-start).
  const ohlcW = (await page.locator(".cl-ohlc").boundingBox()).width;
  const emaW = (await emaRow.boundingBox()).width;
  check(emaW < ohlcW - 40, `indicator card shrink-wraps (EMA ${Math.round(emaW)}px < OHLC ${Math.round(ohlcW)}px)`);

  // 2c) Half-pixel-blur guard: each axis pill centers with translateY(-50%), so
  //     its rendered height must be EVEN (odd → text lands on a half-pixel @ dpr 1).
  for (const sel of [".price-tag", ".alert-tag", ".axis-plus"]) {
    const bb = await page.locator(sel).first().boundingBox().catch(() => null);
    if (bb && bb.height > 0) {
      const h = Math.round(bb.height);
      check(h % 2 === 0, `${sel} has an even height (${h}px) for crisp centering`);
    }
  }

  // 2d) The symbol/OHLC strip is hoverable (pointer-events:auto) so it triggers
  //     crosshair-hide like the indicator rows (TV hides the crosshair over the
  //     whole legend).
  const ohlcPE = await page.locator(".cl-ohlc").evaluate((n) => getComputedStyle(n).pointerEvents);
  check(ohlcPE === "auto", `OHLC row is hoverable for crosshair-hide (pointer-events: ${ohlcPE})`);

  // 3) Crosshair tracking: move over an early bar, the C value should change vs
  //    the last-bar value (imperative textContent update on OnCrosshairChange).
  const cValLast = (await page.locator(".cl-ohlc .cl-ohlc-val").last().textContent())?.trim();
  const box = await page.locator(".chart-wrap").boundingBox();
  await page.mouse.move(box.x + 300, box.y + 400);
  await page.waitForTimeout(250);
  await page.mouse.move(box.x + 305, box.y + 400); // nudge to ensure a crosshair event
  await page.waitForTimeout(300);
  const cValHover = (await page.locator(".cl-ohlc .cl-ohlc-val").last().textContent())?.trim();
  check(
    cValLast !== cValHover,
    `C value tracks crosshair (last=${cValLast} → hover=${cValHover})`,
  );

  // 4) Gear icon → opens the settings modal (indicatorSettingsRequest).
  await emaRow.hover();
  await page.waitForTimeout(150);
  await emaRow.getByTitle("Settings").click();
  await page.waitForTimeout(400);
  // The per-indicator settings modal mounts (look for any modal/dialog overlay).
  const modalOpen = await page.locator(".modal, .settings-modal, [role=dialog]").count();
  check(modalOpen > 0, "gear opens the indicator settings modal");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 5) Eye icon → toggles visibility (row gets the cl-hidden class).
  await emaRow.hover();
  await emaRow.getByTitle("Hide").click();
  await page.waitForTimeout(400);
  const hiddenAfter = await page.locator(".cl-ind.cl-hidden", { hasText: "EMA" }).count();
  check(hiddenAfter > 0, "eye toggles indicator hidden (cl-hidden class)");
  // Unhide for cleanliness.
  await emaRow.hover();
  await emaRow.getByTitle("Show").click();
  await page.waitForTimeout(300);

  // 6) Trash icon → removes the row.
  await emaRow.hover();
  await emaRow.getByTitle("Remove").click();
  await page.waitForTimeout(500);
  const emaGone = await page.locator(".cl-ind", { hasText: "EMA" }).count();
  check(emaGone === 0, "trash removes the indicator row");

  await page.screenshot({ path: `/tmp/legend-verify-${theme}.png` });
  check(errors.length === 0, `no console/page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  await page.close();
}

await run("dark");
await run("light");
await browser.close();

if (fails.length) {
  console.log(`\nFAILED (${fails.length}):\n` + fails.map((f) => " - " + f).join("\n"));
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
