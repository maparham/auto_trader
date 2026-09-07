// One-off PWA icon generator (Task 13: mobile PWA manifest icons).
// No new deps: rasterizes public/favicon.svg via the Playwright chromium
// devDependency already used by the backend's chart-snapshot feature. Run
// with `node scripts/gen-icons.mjs` from `frontend/`; writes
// public/icons/icon-192.png and public/icons/icon-512.png.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const svg = readFileSync(path.join(root, "public/favicon.svg"), "utf8");
const outDir = path.join(root, "public/icons");
mkdirSync(outDir, { recursive: true });

const sizes = [192, 512];

const html = (size) => `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html,body { margin:0; padding:0; background:#101418; }
  .wrap { width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center; }
  svg { width:${Math.round(size * 0.7)}px; height:${Math.round(size * 0.7)}px; }
</style></head>
<body><div class="wrap">${svg}</div></body></html>`;

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(html(size));
    const outPath = path.join(outDir, `icon-${size}.png`);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`wrote ${outPath}`);
  }
} finally {
  await browser.close();
}
