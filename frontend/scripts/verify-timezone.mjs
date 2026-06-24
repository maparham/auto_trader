import { chromium } from "playwright";

const url = "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// 1) Load, wait for chart, read default (browser) timezone.
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__chart, null, { timeout: 15000 });
const defaultTz = await page.evaluate(() => window.__chart.getTimezone());
console.log("default timezone:", defaultTz);

// 2) Set Tokyo via the Settings UI path (localStorage settings), reload.
await page.evaluate(() => {
  const cur = JSON.parse(localStorage.getItem("auto-trader.settings") || "{}");
  cur.timezone = "Asia/Tokyo";
  localStorage.setItem("auto-trader.settings", JSON.stringify(cur));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__chart, null, { timeout: 15000 });
const tokyoTz = await page.evaluate(() => window.__chart.getTimezone());
console.log("after Asia/Tokyo:", tokyoTz);

// 3) Live change (no reload): open Settings, pick New York from the dropdown.
await page.click(".gear-fab");
await page.waitForSelector(".tz-select");
await page.selectOption(".tz-select", "America/New_York");
await page.waitForTimeout(300);
const nyTz = await page.evaluate(() => window.__chart.getTimezone());
console.log("after live New York:", nyTz);

await page.screenshot({ path: "scripts/tz-newyork.png" });

const ok = tokyoTz === "Asia/Tokyo" && nyTz === "America/New_York";
console.log("errors:", errors.length ? errors : "none");
console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
