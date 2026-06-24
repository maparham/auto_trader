// Headless load check + screenshot. Captures console errors and page errors so a
// runtime mount failure surfaces instead of a blank pass.
import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:5173/";
const out = process.argv[3] || "/tmp/auto-trader.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(4000); // let the datafeed fetch + render

// klinecharts renders into a <canvas>; assert at least one exists and has size.
const canvasInfo = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("canvas")];
  return { count: cs.length, sized: cs.some((c) => c.width > 100 && c.height > 100) };
});

await page.screenshot({ path: out });
await browser.close();

console.log("canvases:", JSON.stringify(canvasInfo));
console.log("errors:", errors.length ? errors.join("\n") : "none");
console.log("screenshot:", out);
process.exit(errors.length || !canvasInfo.sized ? 1 : 0);
