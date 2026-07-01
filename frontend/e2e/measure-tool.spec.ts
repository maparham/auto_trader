import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The Measure ruler is a TRANSIENT overlay drawn by CLICK, like the Draw-menu
// tools: arm it (ruler button or hold Shift), click to set the start, move, click
// to set the end — no dragging. It is never persisted.
//
// This spec covers the parts observable in headless: the toolbar toggle, arm/disarm
// (including Esc), and that arming/cancelling never leaks into the persisted drawing
// store. It does NOT drive a full two-click placement to completion — klinecharts'
// interactive draw finalizes on its synthetic click, which does not fire reliably
// under headless synthetic input (the built-in Draw tools' e2e, tab-drawings, has
// the same limitation). The full click → move → click flow, the frozen readout pill,
// one-shot disarm on completion, and click-away clearing are verified by hand in a
// real browser.
test("measure ruler: toolbar toggle, arm/disarm, Esc, no persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  const ruler = page.locator(".measure-toggle");
  await expect(ruler).toHaveAttribute("title", /Measure/);

  // Nothing is ever persisted by the ruler (transient by design).
  const drawingCount = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.includes(".drawings."));
      return key ? (JSON.parse(localStorage.getItem(key) || "[]") as unknown[]).length : 0;
    });

  // Button arms (highlights) and toggles back off — disarming cancels the in-progress
  // draw, so nothing is left on the chart or in storage.
  await ruler.click();
  await expect(ruler).toHaveClass(/\bon\b/);
  await ruler.click();
  await expect(ruler).not.toHaveClass(/\bon\b/);
  await expect.poll(drawingCount).toBe(0);

  // Esc disarms an armed ruler (TV: Esc cancels the tool).
  await ruler.click();
  await expect(ruler).toHaveClass(/\bon\b/);
  await page.locator(".chart-wrap").first().focus();
  await page.keyboard.press("Escape");
  await expect(ruler).not.toHaveClass(/\bon\b/);
  await expect.poll(drawingCount).toBe(0);

  expect(errors).toEqual([]);
});
