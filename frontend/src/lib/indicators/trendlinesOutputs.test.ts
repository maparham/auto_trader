import { describe, expect, it } from "vitest";
import {
  MAX_MAX_LINES,
  MAX_PAIR_PIVOTS,
  parseTrendlinesConfig,
  TL_ATR_LEN,
  TL_NEAREST,
  tlOutputName,
  TRENDLINES_DEFAULTS,
  trendlinesOutputs,
  trendlinesWarmup,
} from "./trendlinesOutputs";

describe("TRENDLINES_DEFAULTS", () => {
  it("pins the calcParams slot order", () => {
    expect(Object.keys(TRENDLINES_DEFAULTS)).toEqual([
      "pivotLen", "touchMult", "minTouches", "minSpanBars", "maxProjBars", "maxLines",
      "minSwingAtr", "minSwingReach", "pairPivots", "maxTouches", "maxSpanBars",
      "maxSlopeAtr", "minSlopeAtr", "maxTouchSpacing", "minTouchSpacing",
      "minCrossings", "maxCrossings", "pierceMult", "minBackBars", "maxDistAtr", "maxDistPct",
    ]);
  });
  it("shares one pool, so pairing reaches 40 pivots back", () => {
    expect(MAX_PAIR_PIVOTS).toBe(40);
    expect(TRENDLINES_DEFAULTS.pairPivots).toBe(40);
  });
});

describe("parseTrendlinesConfig", () => {
  it("returns the defaults for an empty or non-array input", () => {
    expect(parseTrendlinesConfig([])).toEqual(TRENDLINES_DEFAULTS);
    expect(parseTrendlinesConfig(undefined)).toEqual(TRENDLINES_DEFAULTS);
    expect(parseTrendlinesConfig("junk")).toEqual(TRENDLINES_DEFAULTS);
  });
  it("reads every slot in order", () => {
    const p = [4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4, 0.4, 12, 2.5, 1.5];
    expect(parseTrendlinesConfig(p)).toEqual({
      pivotLen: 4, touchMult: 0.5, minTouches: 3, minSpanBars: 30, maxProjBars: 100,
      maxLines: 9, minSwingAtr: 3, minSwingReach: 6, pairPivots: 25, maxTouches: 7,
      maxSpanBars: 300, maxSlopeAtr: 0.2, minSlopeAtr: 0.01, maxTouchSpacing: 60,
      minTouchSpacing: 3, minCrossings: 1, maxCrossings: 4, pierceMult: 0.4,
      minBackBars: 12, maxDistAtr: 2.5, maxDistPct: 1.5,
    });
  });
  // "Only lines near price" was a draw-time rule at a fixed TL_NEAR_PRICE_ATR
  // (5). A pane that CHOSE it keeps that cut as Max Distance; a present slot
  // (even 0) wins over the legacy flag, and a pane that never chose it stays
  // off. Mirrored by the Python parser.
  it("migrates a saved near-price declutter onto Max Distance", () => {
    expect(parseTrendlinesConfig([], { declutter: "near" }).maxDistAtr).toBe(5);
    expect(parseTrendlinesConfig([], { nearPrice: true }).maxDistAtr).toBe(5);
    expect(parseTrendlinesConfig([], { declutter: "off", nearPrice: true }).maxDistAtr).toBe(0);
    expect(parseTrendlinesConfig([], {}).maxDistAtr).toBe(0);
    expect(parseTrendlinesConfig([]).maxDistAtr).toBe(0);
    const twenty = Array.from({ length: 20 }, (_, i) => i);
    expect(parseTrendlinesConfig(twenty, { declutter: "near" }).maxDistAtr).toBe(19);
    expect(parseTrendlinesConfig([...Array(19).fill(5), 0], { declutter: "near" }).maxDistAtr).toBe(0);
  });
  it("keeps zero on the >= 0 params and floors the integers", () => {
    const c = parseTrendlinesConfig([2.9, 0, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(c.pivotLen).toBe(2);
    expect(c.touchMult).toBe(0);
    expect(c.minTouches).toBe(2); // clamped to the two anchors
    expect(c.minSpanBars).toBe(TRENDLINES_DEFAULTS.minSpanBars); // 0 fails > 0
    expect(c.maxLines).toBe(TRENDLINES_DEFAULTS.maxLines);
    expect(c.minSwingAtr).toBe(0);
    expect(c.maxTouches).toBe(0);
    expect(c.minCrossings).toBe(0);
    expect(c.maxCrossings).toBe(0);
    expect(c.pierceMult).toBe(0);
    expect(c.minBackBars).toBe(0);
    expect(c.maxDistAtr).toBe(0);
    expect(c.maxDistPct).toBe(0);
  });

  // A pierce is a full touch and a gap only a half, so the two tolerances ship
  // with different defaults: no gap at all, a quarter ATR of pierce.
  it("defaults Max Touch Gap to zero and Max Pierce to a quarter ATR", () => {
    expect(TRENDLINES_DEFAULTS.touchMult).toBe(0);
    expect(TRENDLINES_DEFAULTS.pierceMult).toBe(0.25);
    expect(parseTrendlinesConfig([5]).pierceMult).toBe(0.25);
  });
  // A pane saved under the OLD calcParams layout reads its Max Projection into
  // slot 5. Each unit is a rule operand plus MAX_LIVE_MULT live lines, so the
  // parser caps it rather than minting 251 operands on a pane nobody touched.
  it("clamps Max Trendlines to the ceiling", () => {
    expect(parseTrendlinesConfig([5, 0.75, 2, 20, 250, 250]).maxLines).toBe(50);
    expect(MAX_MAX_LINES).toBe(50);
    // Anything under the ceiling is untouched, the goldens' 3 included.
    expect(parseTrendlinesConfig([5, 0.75, 2, 20, 250, 3]).maxLines).toBe(3);
  });
  it("sends negatives and junk to the default", () => {
    const c = parseTrendlinesConfig([-1, -1, "x", null, [], {}, NaN]);
    expect(c).toEqual(TRENDLINES_DEFAULTS);
  });
});

describe("trendlinesOutputs", () => {
  it("names one ranked output per Max Trendlines slot, then the nearest", () => {
    const cfg = { ...TRENDLINES_DEFAULTS, maxLines: 3 };
    expect(trendlinesOutputs(cfg)).toEqual(["tl_1", "tl_2", "tl_3", TL_NEAREST]);
    expect(tlOutputName(7)).toBe("tl_7");
    expect(TL_NEAREST).toBe("tl_nearest");
  });
  it("grows with the setting", () => {
    expect(trendlinesOutputs({ ...TRENDLINES_DEFAULTS, maxLines: 1 })).toEqual(["tl_1", TL_NEAREST]);
    expect(trendlinesOutputs({ ...TRENDLINES_DEFAULTS, maxLines: 9 })).toHaveLength(10);
  });
});

describe("trendlinesWarmup", () => {
  it("is ATR warm-up plus two pivot confirms plus the minimum span", () => {
    expect(trendlinesWarmup(TRENDLINES_DEFAULTS)).toBe(TL_ATR_LEN + 2 * 5 + 20);
    expect(trendlinesWarmup({ ...TRENDLINES_DEFAULTS, pivotLen: 3, minSpanBars: 10 })).toBe(TL_ATR_LEN + 6 + 10);
  });
});
