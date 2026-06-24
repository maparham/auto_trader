import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__chart, null, { timeout: 15000 });
await page.waitForTimeout(800);

// Gear should sit in the bottom-right corner.
const fab = await page.$(".gear-fab");
const box = await fab.boundingBox();
const vp = page.viewportSize();
console.log("gear box:", box, "viewport:", vp);
console.log("from right edge:", vp.width - (box.x + box.width), "from bottom:", vp.height - (box.y + box.height));

await page.screenshot({ path: "scripts/gear-corner.png" });

// Open via the gear and confirm the modal appears.
await fab.click();
const modalOpen = await page.waitForSelector(".tz-select", { timeout: 3000 }).then(() => true).catch(() => false);
console.log("gear opens settings:", modalOpen);
await page.keyboard.press("Escape");

// Context menu Settings item: right-click empty chart area.
await page.mouse.click(640, 400, { button: "right" });
await page.waitForTimeout(200);
const ctxItems = await page.$$eval(".ctx-item-label", (els) => els.map((e) => e.textContent.trim()));
console.log("context menu items:", ctxItems);
const hasSettings = ctxItems.includes("Settings");
await page.screenshot({ path: "scripts/gear-context.png" });

console.log("errors:", errors.length ? errors : "none");
const ok = modalOpen && hasSettings && errors.length === 0;
console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
