// Core S/R clustering math. Rendering is exercised visually; this suite pins the
// causal algorithm: strict fractal pivots (shared isPivotAt), ATR-scaled merge
// tolerance, touch-count gating, and the per-bar nearest support/resistance
// outputs the backtest rules read.
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { computeSrLevels } from "./srLevels";

/** Bar with high = close+1, low = close-1 so pivots land on close extremes ±1. */
function bar(close: number, i: number): KLineData {
  return {
    timestamp: 1700000000000 + i * 3600_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  };
}

/** Triangle wave: repeated cycles low(100) → peak → low, 8 bars per cycle.
 * peaks[k] is cycle k's top close; every trough close is 100. */
function triangle(peaks: number[]): KLineData[] {
  const closes: number[] = [];
  for (const p of peaks) {
    const up = (p - 100) / 4;
    closes.push(100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up);
  }
  closes.push(100); // final trough so the last low pivot can confirm
  return closes.map(bar);
}

const CFG = { pivotLen: 2, atrMult: 0.5, minTouches: 2, maxLevels: 8, maxBars: 500 };

describe("computeSrLevels", () => {
  // peaks at bar indices 4,12,20,28 (highs 111 each); troughs at 8,16,24,32 (lows 99).
  // With pivotLen=2, a pivot at bar i confirms at i+2; ATR(14) is warm from bar 13,
  // so the first usable touches are the high pivot at 12 (confirms 14) and the low
  // pivot at 16 (confirms 18).
  const candles = triangle([110, 110, 110, 110]);

  it("returns one point per bar", () => {
    const { points } = computeSrLevels(candles, CFG);
    expect(points).toHaveLength(candles.length);
  });

  it("emits no levels before a zone reaches minTouches", () => {
    const { points } = computeSrLevels(candles, CFG);
    // First resistance touch confirms at bar 14; a single touch is not major.
    expect(points[21].resistance).toBeUndefined();
    expect(points[21].support).toBeUndefined();
  });

  it("emits nearest resistance above and support below the close once major", () => {
    const { points } = computeSrLevels(candles, CFG);
    // Second high touch (pivot at 20) confirms at bar 22 → resistance = 111.
    expect(points[22].resistance).toBe(111);
    // Second low touch (pivot at 24) confirms at bar 26 → support = 99.
    expect(points[26].support).toBe(99);
    const last = points[points.length - 1];
    expect(last.resistance).toBe(111);
    expect(last.support).toBe(99);
  });

  it("clusters nearby pivots into one averaged level", () => {
    // Peak highs 111, 111.4, 110.8, 111 — all within 0.5×ATR of each other.
    const wobbly = triangle([110, 110.4, 109.8, 110]);
    const { points, levels } = computeSrLevels(wobbly, CFG);
    const resistances = levels.filter((l) => l.price > 105);
    expect(resistances).toHaveLength(1);
    // Only the last three peaks are ATR-warm touches: pivots at 12, 20, 28.
    const expected = (111.4 + 110.8 + 111) / 3;
    expect(resistances[0].touches).toBe(3);
    expect(resistances[0].price).toBeCloseTo(expected, 10);
    expect(points[points.length - 1].resistance).toBeCloseTo(expected, 10);
  });

  it("keeps far-apart zones as separate levels and tracks touch counts", () => {
    const { levels } = computeSrLevels(candles, CFG);
    expect(levels).toHaveLength(2);
    const [res, sup] = [...levels].sort((a, b) => b.price - a.price);
    expect(res.price).toBe(111);
    expect(res.touches).toBe(3); // pivots at 12, 20, 28
    expect(sup.price).toBe(99);
    expect(sup.touches).toBe(2); // pivots at 16 and 24 (the one at 32 never confirms)
  });

  it("caps the reported levels at maxLevels, keeping the most-touched", () => {
    const { levels } = computeSrLevels(candles, { ...CFG, maxLevels: 1 });
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBe(111); // 3 touches beats 2
  });
});

describe("computeSrLevels MTF branch", () => {
  const H = 3600_000;
  const t0 = 1700000000000;
  // 12 hourly chart bars spanning three 4-hour HTF bars.
  const chartBars = Array.from({ length: 12 }, (_, i) => bar(100, i));
  const mtf = {
    timeframe: "HOUR_4",
    htfMs: 4 * H,
    htfStarts: [t0, t0 + 4 * H, t0 + 8 * H],
    htfSupport: [100, 101, 102] as Array<number | undefined>,
    htfResistance: [110, undefined, 112] as Array<number | undefined>,
    htfLevels: [{ price: 100, halfWidth: 5, touches: 2, firstTs: t0, lastTs: t0 + 4 * H }],
  };

  it("aligns the HTF series onto chart bars using only CLOSED HTF bars", () => {
    const { points } = computeSrLevels(chartBars, CFG, { mtf });
    // Bars inside the first (still-open) HTF bar have no closed HTF bar yet.
    expect(points[0].support).toBeUndefined();
    expect(points[3].support).toBeUndefined();
    // Bars in the second HTF bar read the first CLOSED HTF bar's values.
    expect(points[4].support).toBe(100);
    expect(points[7].resistance).toBe(110);
    // Third HTF bar: support steps to 101; resistance was undefined on HTF bar 2.
    expect(points[8].support).toBe(101);
    expect(points[8].resistance).toBeUndefined();
    // The last HTF value (index 2) is never used — its bar never closes on-chart.
    expect(points[11].support).toBe(101);
  });

  it("maps stashed HTF level timestamps onto chart bar indices", () => {
    const { levels } = computeSrLevels(chartBars, CFG, { mtf });
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBe(100);
    expect(levels[0].touches).toBe(2);
    expect(levels[0].firstIdx).toBe(0); // firstTs = t0 → chart bar 0
    // lastTs names the HTF bar starting t0+4h; its last chart bar is index 7.
    expect(levels[0].lastIdx).toBe(7);
  });
});

// The per-bar selection is cached and only rebuilt when the cluster pool moves
// or the age window slides past the oldest eligible level. Expiry is the half a
// cache can silently get wrong: it drops a level with no touch to signal it.
describe("computeSrLevels level expiry", () => {
  it("drops a level exactly maxBars after its last touch, with no later touch", () => {
    // Four peaks put resistance past minTouches (ATR(14) only warms at bar 13,
    // so the early cycles cannot count), then a long flat tail carrying no
    // strict pivots at all, so nothing ever re-touches the level.
    const head = triangle([110, 110, 110, 110]);
    const flat: KLineData[] = [];
    for (let i = 0; i < 200; i++) flat.push(bar(100, head.length + i));
    const candles = [...head, ...flat];
    const cfg = { ...CFG, maxBars: 40 };
    const { points } = computeSrLevels(candles, cfg);

    // The last touch can only confirm inside the triangle section, so the flat
    // tail measures the window from there.
    expect(points.some((p) => p.resistance !== undefined)).toBe(true);
    // Held while inside the window...
    expect(points[head.length + 5].resistance).toBeDefined();
    // ...and gone once the window has slid past the newest touch entirely.
    expect(points[head.length + cfg.maxBars + 5].resistance).toBeUndefined();
  });

  it("expires levels the same way at maxBars=1 (recompute on nearly every bar)", () => {
    const candles = triangle([110, 110, 110, 110]);
    const { points } = computeSrLevels(candles, { ...CFG, maxBars: 1 });
    // A one-bar window can never hold a level beyond the bar after its touch.
    const live = points.filter((p) => p.support !== undefined || p.resistance !== undefined);
    expect(live.length).toBeLessThan(points.length / 2);
  });
});

describe("srZoneStyleOf", () => {
  it("returns the defaults for a bare extendData", async () => {
    const { srZoneStyleOf, SR_ZONE_STYLE_DEFAULTS } = await import("./srLevels");
    expect(srZoneStyleOf({})).toEqual(SR_ZONE_STYLE_DEFAULTS);
    expect(srZoneStyleOf(undefined)).toEqual(SR_ZONE_STYLE_DEFAULTS);
  });

  it("merges a partial zoneStyle over the defaults", async () => {
    const { srZoneStyleOf, SR_ZONE_STYLE_DEFAULTS } = await import("./srLevels");
    const st = srZoneStyleOf({ zoneStyle: { supColor: "#123456" } });
    expect(st.supColor).toBe("#123456");
    expect(st.resColor).toBe(SR_ZONE_STYLE_DEFAULTS.resColor);
    expect(st.opacity).toBe(SR_ZONE_STYLE_DEFAULTS.opacity);
  });

  it("defaults dimBroken to on, and an explicit false survives the merge", async () => {
    const { srZoneStyleOf } = await import("./srLevels");
    expect(srZoneStyleOf({}).dimBroken).toBe(true);
    expect(srZoneStyleOf({ zoneStyle: { dimBroken: false } }).dimBroken).toBe(false);
  });
});

describe("isLevelBroken", () => {
  it("is broken when the last close is on the opposite side of the level from the close at its last touch", async () => {
    const { isLevelBroken } = await import("./srLevels");
    // Close was above the level at the last touch (bar 2), now below → broken.
    expect(isLevelBroken(100, 2, [105, 102, 101, 99])).toBe(true);
    // Still above → holding.
    expect(isLevelBroken(100, 2, [105, 102, 101, 103])).toBe(false);
    // Was below at touch, still below → holding (a resistance keeps resisting).
    expect(isLevelBroken(110, 1, [105, 104, 106, 108])).toBe(false);
    // Was below at touch, now above → broken through resistance.
    expect(isLevelBroken(110, 1, [105, 104, 106, 112])).toBe(true);
  });

  it("treats a close exactly at the level as the upper side (matching support classification)", async () => {
    const { isLevelBroken } = await import("./srLevels");
    expect(isLevelBroken(100, 0, [100, 100])).toBe(false);
    expect(isLevelBroken(100, 0, [100, 99.9])).toBe(true);
  });
});

describe("zoneAlpha", () => {
  it("ramps with touches above minTouches and caps at 3x the base", async () => {
    const { zoneAlpha } = await import("./srLevels");
    expect(zoneAlpha(2, 2, 0.1)).toBeCloseTo(0.1, 10);
    expect(zoneAlpha(4, 2, 0.1)).toBeCloseTo(0.18, 10);
    expect(zoneAlpha(20, 2, 0.1)).toBeCloseTo(0.3, 10); // cap
    expect(zoneAlpha(3, 2, 0.2)).toBeCloseTo(0.24, 10); // base scales the ramp start
  });
});
