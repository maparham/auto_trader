// Rendering gate for custom-overlay text + midpoint marker. Proves the overridden
// trend-line overlays actually PAINT each figure (not just store extendData), for
// ALL THREE geometries (segment/rayLine/straightLine — all overridden globally with
// hand-replicated geometry, so all need pixel coverage). Text and marker are tested
// in ISOLATION (text-only, then marker-only) so a change can't be one masking the
// other. A pure-state check can't catch a silently-non-rendering createPointFigures.
import { chromium } from "playwright";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("ERR " + e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

const results = [];
const check = (name, ok) => results.push({ name, ok });

// Create one line of `name` and return the midpoint screen pixel. Clears overlays first.
async function makeLine(name) {
  return page.evaluate((nm) => {
    const c = window.__chart;
    (c.getOverlays?.() ?? []).forEach((o) => c.removeOverlay(o.id));
    Object.keys(localStorage).filter((k) => k.includes("drawings.")).forEach((k) => localStorage.removeItem(k));
    const dl = c.getDataList(), vr = c.getVisibleRange();
    const lo = vr.realFrom ?? vr.from, hi = vr.realTo ?? vr.to;
    const a = dl[Math.floor(lo + (hi - lo) * 0.35)], b = dl[Math.floor(lo + (hi - lo) * 0.55)];
    const id = c.createOverlay({
      name: nm,
      points: [
        { timestamp: a.timestamp, value: a.high },
        { timestamp: b.timestamp, value: b.low },
      ],
    });
    const p0 = c.convertToPixel({ timestamp: a.timestamp, value: a.high }, { paneId: "candle_pane", absolute: true });
    const p1 = c.convertToPixel({ timestamp: b.timestamp, value: b.low }, { paneId: "candle_pane", absolute: true });
    const r = document.querySelector(".chart-wrap").getBoundingClientRect();
    window.__probeId = id;
    return { mx: (p0.x + p1.x) / 2 + r.left, my: (p0.y + p1.y) / 2 + r.top };
  }, name);
}

async function setExtra(extra) {
  await page.evaluate((e) => window.__chart.overrideOverlay({ id: window.__probeId, extendData: e }), extra);
  await page.waitForTimeout(350);
}

// Did the clip box change between two states? Box is placed by `where`: "above" for
// the text label (mid.y - 8, bottom-aligned), "at" for the midpoint marker.
async function clip(geo, where) {
  const box = where === "above"
    ? { x: Math.round(geo.mx - 55), y: Math.round(geo.my - 30), width: 110, height: 24 }
    : { x: Math.round(geo.mx - 10), y: Math.round(geo.my - 10), width: 20, height: 20 };
  return page.screenshot({ clip: box });
}

for (const name of ["segment", "rayLine", "straightLine"]) {
  const geo = await makeLine(name);
  await page.waitForTimeout(250);

  // Text-only: label box above midpoint must change; marker box should NOT (no marker).
  const beforeText = await clip(geo, "above");
  await setExtra({ text: "RENDER-TEST", showMiddle: false });
  const afterText = await clip(geo, "above");
  check(`${name}: text figure paints`, Buffer.compare(beforeText, afterText) !== 0);

  // Marker-only: reset to nothing, then marker box at midpoint must change.
  await setExtra({ text: "", showMiddle: false });
  const beforeMark = await clip(geo, "at");
  await setExtra({ text: "", showMiddle: true });
  const afterMark = await clip(geo, "at");
  check(`${name}: midpoint marker paints`, Buffer.compare(beforeMark, afterMark) !== 0);
}

const fails = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? "PASS" : "FAIL"}: ${r.name}`));
console.log("errors:", errors.length ? errors : "none");
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
