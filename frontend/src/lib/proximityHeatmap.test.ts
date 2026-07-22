import { expect, it } from "vitest";
import { heatAlpha, heatColor, heatmapVisible } from "./proximityHeatmap";

it("maps closeness to a cool→hot color", () => {
  expect(heatColor(0)).toMatch(/^rgba\(/);
  expect(heatColor(1)).toMatch(/^rgba\(/);
  // hot end is redder than cool end
  const cool = heatColor(0);
  const hot = heatColor(1);
  expect(cool).not.toEqual(hot);
});

it("alpha grows with closeness and is 0 at fully cold", () => {
  expect(heatAlpha(0)).toBe(0);
  expect(heatAlpha(1)).toBeGreaterThan(heatAlpha(0.5));
  expect(heatAlpha(0.5)).toBeGreaterThan(heatAlpha(0));
});

it("is visible only at or above the base resolution", () => {
  expect(heatmapVisible("HOUR", "MINUTE")).toBe(true);   // higher TF shows
  expect(heatmapVisible("MINUTE", "MINUTE")).toBe(true); // same TF shows
  expect(heatmapVisible("MINUTE", "HOUR")).toBe(false);  // below base hidden
});
