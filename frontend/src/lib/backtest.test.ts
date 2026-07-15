// @vitest-environment jsdom
import { test, expect } from "vitest";
import { overlayEndTs } from "./backtest";

const bars1m = Array.from({ length: 61 }, (_, i) => ({ timestamp: 3_600_000 + i * 60_000 }));

test("overlayEndTs rounds up to the close of the hit minute candle", () => {
  // hit at minute 50 (03:50); its close boundary is minute 51.
  const exitExact = 3_600_000 + 50 * 60_000;
  const end = overlayEndTs(exitExact, bars1m, 60_000, 3_600_000);
  expect(end).toBe(3_600_000 + 51 * 60_000);
});

test("overlayEndTs floors at one bar for a first-minute exit", () => {
  const end = overlayEndTs(3_600_000, bars1m, 60_000, 3_600_000);
  expect(end).toBe(3_600_000 + 60_000); // entryTs + barMs
});

test("overlayEndTs collapses one coarse candle when display == run bar", () => {
  const bars1h = [{ timestamp: 3_600_000 }, { timestamp: 7_200_000 }];
  const exitExact = 3_600_000 + 50 * 60_000; // inside the single 1h bar
  const end = overlayEndTs(exitExact, bars1h, 3_600_000, 3_600_000);
  expect(end).toBe(7_200_000); // that bar's close boundary
});

test("overlayEndTs falls back to max(floor, exact) with no bars", () => {
  const exitExact = 3_600_000 + 50 * 60_000;
  expect(overlayEndTs(exitExact, [], 60_000, 3_600_000)).toBe(exitExact);
});
