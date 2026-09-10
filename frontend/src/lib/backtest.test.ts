// @vitest-environment jsdom
import { test, expect, describe, it } from "vitest";
import { overlayEndTs, isExprRequest, strategyZoneSpan, liveMarkerGlyph, LIVE_GLYPH_GAP, LIVE_GLYPH_H, LIVE_GLYPH_HALF_W } from "./backtest";
import type { BacktestRequest, ExprBacktestRequest } from "../api";
import { chartColors } from "../theme";

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

// Dispatch guard: runAndRender routes coded → runBacktest, expr → runExprBacktest
// off isExprRequest. Types are erased at runtime, so the fixtures must literally
// omit/set longExit exactly as each request shape does. A coded BacktestRequest
// no longer carries longExit at all (undefined → not an array → runBacktest);
// an ExprBacktestRequest's longExit is ExprRow[] (an array → runExprBacktest).
test("isExprRequest routes a coded request to the coded backtest", () => {
  const coded = {
    epic: "X",
    resolution: "1m",
    candles: [],
    series: {},
    codedStrategy: "foo.py",
    longEnabled: true,
    shortEnabled: true,
    costs: {},
    tradeFromTime: 0,
  } as unknown as BacktestRequest;
  expect(isExprRequest(coded)).toBe(false);
});

test("isExprRequest routes an expr request to the expr backtest", () => {
  const expr = {
    epic: "X",
    resolution: "1m",
    candles: [],
    longEntry: [],
    longExit: [{ expr: "close > open", enabled: true }],
    shortEntry: [],
    shortExit: [],
    longEnabled: true,
    shortEnabled: true,
    costs: {},
    tradeFromTime: 0,
  } as unknown as ExprBacktestRequest;
  expect(isExprRequest(expr)).toBe(true);
});

test("strategyZoneSpan passes a zone overlapping the loaded window", () => {
  // zone times are unix SECONDS (wire shape); window bounds are ms.
  const z = { from_time: 3600, to_time: 7200, top: 110, bottom: 100, label: "range" };
  expect(strategyZoneSpan(z, 3_600_000, 10_000_000)).toEqual({ fromTs: 3_600_000, toTs: 7_200_000 });
  // Straddling the left edge still draws (klinecharts clamps the off-window point).
  expect(strategyZoneSpan(z, 5_000_000, 10_000_000)).toEqual({ fromTs: 3_600_000, toTs: 7_200_000 });
});

test("strategyZoneSpan rejects a zone entirely outside the loaded window", () => {
  const z = { from_time: 3600, to_time: 7200, top: 110, bottom: 100, label: "" };
  expect(strategyZoneSpan(z, 8_000_000, 10_000_000)).toBeNull();
  expect(strategyZoneSpan(z, 1_000_000, 2_000_000)).toBeNull();
});

// The live entry glyph is now the ONLY always-on mark of where a position opened:
// trade lines are drawn just while the trade is engaged (lib/positionLines.ts), so
// this arrow carries that job alone and has to read at a glance against a candle.
describe("liveMarkerGlyph", () => {
  const COLOR = "#2962ff";

  it("points its apex at the candle, a gap clear of the wick", () => {
    const [, arrow] = liveMarkerGlyph({ x: 100, y: 200, dir: -1, color: COLOR });
    const pts = (arrow.attrs as { coordinates: Array<{ x: number; y: number }> }).coordinates;
    expect(pts[0]).toEqual({ x: 100, y: 200 - LIVE_GLYPH_GAP });
  });

  it("mirrors through the anchor when it hangs below the candle", () => {
    const [, arrow] = liveMarkerGlyph({ x: 100, y: 200, dir: 1, color: COLOR });
    const pts = (arrow.attrs as { coordinates: Array<{ x: number; y: number }> }).coordinates;
    expect(pts[0]).toEqual({ x: 100, y: 200 + LIVE_GLYPH_GAP });
    expect(pts[1].y).toBe(200 + LIVE_GLYPH_GAP + LIVE_GLYPH_H);
  });

  it("is big enough to read: a wider-than-tall arrow of at least 12x10", () => {
    const [, arrow] = liveMarkerGlyph({ x: 100, y: 200, dir: -1, color: COLOR });
    const pts = (arrow.attrs as { coordinates: Array<{ x: number; y: number }> }).coordinates;
    expect(pts[2].x - pts[1].x).toBeGreaterThanOrEqual(12);
    expect(Math.abs(pts[1].y - pts[0].y)).toBeGreaterThanOrEqual(10);
    expect(2 * LIVE_GLYPH_HALF_W).toBe(pts[2].x - pts[1].x);
  });

  it("carries an outline so it separates from the candle it sits on", () => {
    const [, arrow] = liveMarkerGlyph({ x: 100, y: 200, dir: -1, color: COLOR });
    const styles = arrow.styles as { style: string; color: string; borderSize?: number };
    expect(styles.style).toBe("stroke_fill");
    expect(styles.color).toBe(COLOR);
    expect(styles.borderSize).toBeGreaterThan(0);
  });

  // The outline works by cutting the glyph out of what is BEHIND it, so it has to be
  // the chart's backdrop — a hardcoded white ring separates nothing on a light chart,
  // which is exactly where the glyph most needs the help.
  it("outlines in the theme's chart background", () => {
    const prev = document.documentElement.dataset.theme;
    try {
    document.documentElement.dataset.theme = "light";
    const light = liveMarkerGlyph({ x: 0, y: 0, dir: -1, color: COLOR })[1].styles as { borderColor: string };
    document.documentElement.dataset.theme = "dark";
    const dark = liveMarkerGlyph({ x: 0, y: 0, dir: -1, color: COLOR })[1].styles as { borderColor: string };
    expect(light.borderColor).toBe(chartColors.light.bg);
    expect(dark.borderColor).toBe(chartColors.dark.bg);
    expect(light.borderColor).not.toBe(dark.borderColor);
    } finally {
      if (prev == null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = prev;
    }
  });

  it("prefers a custom chart background over the theme default", () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.setProperty("--chart-bg", "#123456");
    try {
      const styles = liveMarkerGlyph({ x: 0, y: 0, dir: -1, color: COLOR })[1].styles as { borderColor: string };
      expect(styles.borderColor).toBe("#123456");
    } finally {
      document.documentElement.style.removeProperty("--chart-bg");
    }
  });

  it("keeps a finger-sized transparent hit target over the arrow", () => {
    const [hit] = liveMarkerGlyph({ x: 100, y: 200, dir: -1, color: COLOR });
    expect(hit.type).toBe("circle");
    const a = hit.attrs as { r: number; x: number };
    expect(a.x).toBe(100);
    expect(a.r).toBeGreaterThanOrEqual(LIVE_GLYPH_H);
  });
});
