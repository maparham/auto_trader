// End-to-end verification of editable/selectable/copyable drawings.
// Run against the live dev server (HMR). Covers: select, right-click menu, settings
// modal (style + extend + coordinates + visibility), keyboard delete, copy/paste,
// clone-drag, and persistence across reload.
import { chromium } from "playwright";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("ERR " + e.message));
const pass = [], fail = [];
const check = (name, ok) => (ok ? pass : fail).push(name);

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("drawings.")).forEach((k) => localStorage.removeItem(k)));

const cnt = () =>
  page.evaluate(() => {
    let n = 0;
    Object.keys(localStorage).filter((k) => k.includes("drawings.")).forEach((k) => {
      try { n += (JSON.parse(localStorage[k]) || []).length; } catch {}
    });
    return n;
  });

async function drawSegment() {
  const geo = await page.evaluate(() => {
    const c = window.__chart, dl = c.getDataList(), vr = c.getVisibleRange();
    const lo = vr.realFrom ?? vr.from, hi = vr.realTo ?? vr.to;
    const a = dl[Math.floor(lo + (hi - lo) * 0.3)], b = dl[Math.floor(lo + (hi - lo) * 0.6)];
    const p0 = c.convertToPixel({ timestamp: a.timestamp, value: a.high }, { paneId: "candle_pane", absolute: true });
    const p1 = c.convertToPixel({ timestamp: b.timestamp, value: b.low }, { paneId: "candle_pane", absolute: true });
    const r = document.querySelector(".chart-wrap").getBoundingClientRect();
    return { p0, p1, rl: r.left, rt: r.top };
  });
  await page.getByText("Draw", { exact: false }).first().click();
  await page.waitForTimeout(250);
  await page.getByText("Segment", { exact: true }).click();
  await page.waitForTimeout(250);
  const x0 = geo.rl + geo.p0.x, y0 = geo.rt + geo.p0.y, x1 = geo.rl + geo.p1.x, y1 = geo.rt + geo.p1.y;
  await page.mouse.click(x0, y0); await page.waitForTimeout(150);
  await page.mouse.click(x1, y1); await page.waitForTimeout(400);
  return { mx: (x0 + x1) / 2, my: (y0 + y1) / 2, rl: geo.rl, rt: geo.rt };
}

// 1) Right-click a drawing -> overlay context menu (not Paste indicator).
let g = await drawSegment();
await page.mouse.move(g.mx, g.my); await page.waitForTimeout(200);
await page.mouse.click(g.mx, g.my, { button: "right" }); await page.waitForTimeout(300);
let menu = await page.evaluate(() => document.querySelector(".ctxmenu")?.innerText.replace(/\n/g, "|") || "");
check("right-click shows overlay menu (Settings/Clone/Copy/order/Lock/Delete)",
  /Settings/.test(menu) && /Clone/.test(menu) && /Copy/.test(menu) && /Delete/.test(menu) && !/Paste indicator/.test(menu));
await page.keyboard.press("Escape"); await page.waitForTimeout(150);

// 2) Settings modal opens with 4 tabs.
await page.mouse.click(g.mx, g.my, { button: "right" }); await page.waitForTimeout(250);
await page.getByText("Settings", { exact: true }).click(); await page.waitForTimeout(350);
let tabs = await page.evaluate(() => [...document.querySelectorAll(".ind-tab")].map((t) => t.textContent).join(","));
check("modal has Style,Text,Coordinates,Visibility tabs", tabs === "Style,Text,Coordinates,Visibility");

// 3) Style: change width -> persists.
await page.evaluate(() => { const s = document.querySelector(".modal.ind-settings select"); s.value = "3"; s.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForTimeout(250);
let sz = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.includes("drawings."))[1])[0]?.styles?.line?.size);
check("style width edit persists (=3)", sz === 3);

// 4) Extend: segment -> straightLine.
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".modal.ind-settings .ind-row")].find((r) => r.querySelector("label")?.textContent === "Extend");
  const sel = row.querySelector("select"); sel.value = "both"; sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(350);
let nm = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.includes("drawings."))[1])[0]?.name);
check("extend=both converts segment->straightLine", nm === "straightLine");

// 5) Visibility toggle off -> persisted visible=false.
await page.getByText("Visibility", { exact: true }).click(); await page.waitForTimeout(200);
await page.evaluate(() => { const c = document.querySelector('.modal.ind-settings input[type="checkbox"]'); c.click(); });
await page.waitForTimeout(250);
let vis = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.includes("drawings."))[1])[0]?.visible);
check("visibility toggle persists (visible=false)", vis === false);
// turn back on + Ok
await page.evaluate(() => { const c = document.querySelector('.modal.ind-settings input[type="checkbox"]'); c.click(); });
await page.waitForTimeout(150);
await page.getByText("Ok", { exact: true }).click(); await page.waitForTimeout(250);

// 6) Keyboard delete.
let before = await cnt();
await page.mouse.move(g.mx, g.my); await page.waitForTimeout(150);
await page.mouse.click(g.mx, g.my); await page.waitForTimeout(200);
await page.keyboard.press("Delete"); await page.waitForTimeout(400);
let after = await cnt();
check("keyboard Delete removes selected drawing", after === before - 1);

// 7) Copy + paste.
g = await drawSegment();
await page.mouse.move(g.mx, g.my); await page.waitForTimeout(150);
await page.mouse.click(g.mx, g.my); await page.waitForTimeout(200);
before = await cnt();
await page.keyboard.press("Meta+c"); await page.waitForTimeout(250);
await page.keyboard.press("Meta+v"); await page.waitForTimeout(400);
after = await cnt();
check("copy+paste adds one drawing", after === before + 1);

// 8) Clone via Cmd-drag.
before = await cnt();
await page.mouse.move(g.mx, g.my); await page.waitForTimeout(150);
await page.keyboard.down("Meta");
await page.mouse.down(); await page.waitForTimeout(80);
await page.mouse.move(g.mx + 60, g.my + 40, { steps: 5 }); await page.waitForTimeout(80);
await page.mouse.up();
await page.keyboard.up("Meta");
await page.waitForTimeout(400);
after = await cnt();
check("cmd-drag clone adds one drawing", after === before + 1);

// 10) Text label + midpoint marker (custom-overlay feature). Draw a fresh segment,
// open settings, set text + toggle marker via the Text tab, confirm both land on the
// overlay's extendData (the custom createPointFigures reads these — gate-verified).
g = await drawSegment();
await page.mouse.click(g.mx, g.my, { button: "right" }); await page.waitForTimeout(250);
await page.getByText("Settings", { exact: true }).click(); await page.waitForTimeout(300);
await page.getByText("Text", { exact: true }).click(); await page.waitForTimeout(200);
await page.getByPlaceholder("Add text…").fill("LABEL-X"); await page.waitForTimeout(250);
await page.getByText("Show midpoint marker", { exact: true }).click(); await page.waitForTimeout(250);
const extra = await page.evaluate(() => {
  const c = window.__chart;
  // The most-recently created overlay is the one we just edited.
  const ids = c.getOverlays?.() ?? [];
  // Fallback: scan localStorage for the saved extendData.
  let found = null;
  Object.keys(localStorage).filter((k) => k.includes("drawings.")).forEach((k) => {
    try {
      (JSON.parse(localStorage[k]) || []).forEach((d) => {
        if (d?.extendData?.text === "LABEL-X") found = d.extendData;
      });
    } catch {}
  });
  return found;
});
check("text + midpoint marker land on extendData", !!extra && extra.text === "LABEL-X" && extra.showMiddle === true);
// Close the modal.
await page.getByText("Ok", { exact: true }).click().catch(() => {}); await page.waitForTimeout(200);

// 9) Persistence across reload.
let countBefore = await cnt();
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(4500);
let countAfter = await cnt();
check("drawings persist across reload", countAfter === countBefore && countAfter > 0);

// 11) Text/marker survive the reload (extendData rehydrates).
const survived = await page.evaluate(() => {
  let ok = false;
  Object.keys(localStorage).filter((k) => k.includes("drawings.")).forEach((k) => {
    try {
      (JSON.parse(localStorage[k]) || []).forEach((d) => {
        if (d?.extendData?.text === "LABEL-X" && d?.extendData?.showMiddle === true) ok = true;
      });
    } catch {}
  });
  return ok;
});
check("text + marker survive reload", survived);

console.log("PASS:", pass.length, JSON.stringify(pass));
console.log("FAIL:", fail.length, JSON.stringify(fail));
console.log("errors:", errors.length ? errors.join("\n") : "none");
await browser.close();
process.exit(fail.length || errors.length ? 1 : 0);
