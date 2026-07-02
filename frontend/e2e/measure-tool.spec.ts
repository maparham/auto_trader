import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The Measure ruler is a TRANSIENT overlay: it renders while you drag, freezes on
// release, and is never persisted. These checks cover the observable contract —
// the toolbar toggle, the one-shot arm, Esc disarm, and that nothing leaks into the
// persisted drawing store — without reaching into the canvas (the box/pill are
// canvas figures; their look is confirmed separately by eye).
test("measure ruler: arm, one-shot disarm, transient, no persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  const canvas = page.locator(".chart canvas").first();
  await canvas.waitFor();

  const ruler = page.locator(".measure-toggle");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Count of persisted drawings for the active tab — must stay 0 the whole time.
  const drawingCount = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.includes(".drawings."));
      return key ? (JSON.parse(localStorage.getItem(key) || "[]") as unknown[]).length : 0;
    });

  // Arm via the ruler button → highlighted.
  await ruler.click();
  await expect(ruler).toHaveClass(/\bon\b/);

  // Drag a measurement. The armed press is one-shot: the ruler disarms after.
  await page.mouse.move(cx - 80, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 40, { steps: 8 });
  await page.mouse.up();
  await expect(ruler).not.toHaveClass(/\bon\b/);
  // Transient: the measurement never reaches the persisted drawing store.
  await expect.poll(drawingCount).toBe(0);

  // Shift+drag measures without ever arming the button.
  await page.keyboard.down("Shift");
  await page.mouse.move(cx - 60, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(ruler).not.toHaveClass(/\bon\b/);
  await expect.poll(drawingCount).toBe(0);

  // Esc while armed disarms without drawing anything.
  await ruler.click();
  await expect(ruler).toHaveClass(/\bon\b/);
  await page.locator(".chart-wrap").first().focus();
  await page.keyboard.press("Escape");
  await expect(ruler).not.toHaveClass(/\bon\b/);
  await expect.poll(drawingCount).toBe(0);

  // A plain click afterwards clears any frozen measurement without error.
  await page.mouse.click(cx, cy);
  await expect.poll(drawingCount).toBe(0);

  expect(errors).toEqual([]);
});
