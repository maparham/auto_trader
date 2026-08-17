import { describe, expect, it } from "vitest";
import {
  MAX_LIVE_MULT,
  MAX_PAIR_PIVOTS,
  TL_ATR_LEN,
  TRENDLINES_DEFAULTS,
  TRENDLINES_OUTPUTS,
  parseTrendlinesConfig,
  trendlinesWarmup,
} from "./trendlinesOutputs";

describe("constants and defaults", () => {
  // These pin the VALUES only. MAX_LIVE_MULT is load-bearing (it decides which
  // lines survive, so it changes emitted values), and a suite that only checked
  // the number here would stay green if the cap were deleted outright. Its
  // BEHAVIOUR is pinned in trendlinesDxy.test.ts: the per-side live count is
  // bounded by MAX_LIVE_MULT x maxLines, and maxLines 2 vs 3 changes an emitted
  // value on 113 bars of that fixture.
  it("pins the exported constants", () => {
    expect(TL_ATR_LEN).toBe(14);
    expect(MAX_PAIR_PIVOTS).toBe(20);
    expect(MAX_LIVE_MULT).toBe(4);
  });

  it("pins all default values", () => {
    expect(TRENDLINES_DEFAULTS).toEqual({
      pivotLen: 5,
      violMult: 0.25,
      touchMult: 0.75,
      minTouches: 2,
      minSpanBars: 20,
      maxProjBars: 250,
      breakHoldBars: 30,
      maxLines: 3,
    });
  });
});

describe("parseTrendlinesConfig", () => {
  it("takes every default from an empty params list", () => {
    expect(parseTrendlinesConfig([])).toEqual(TRENDLINES_DEFAULTS);
  });

  it("reads params positionally", () => {
    const cfg = parseTrendlinesConfig([9, 0.5, 1.5, 3, 40, 100, 10, 2]);
    expect(cfg).toEqual({
      pivotLen: 9,
      violMult: 0.5,
      touchMult: 1.5,
      minTouches: 3,
      minSpanBars: 40,
      maxProjBars: 100,
      breakHoldBars: 10,
      maxLines: 2,
    });
  });

  // violMult zero is the STRICTEST setting (exact containment, no pierce
  // allowed), not a "filter off" switch. Coercing it back to the default would
  // silently swap strict containment for tolerant containment with no error.
  it("keeps a zero violMult", () => {
    expect(parseTrendlinesConfig([5, 0]).violMult).toBe(0);
  });

  // Number(null) is 0, which passes violMult's `>= 0` rule, so violMult becomes
  // 0 (strictest). Python's float(None) raises TypeError, returning the default
  // 0.25 instead. Same asymmetry for "", [] and other non-numeric strings.
  // `false` is NOT one of them: float(False) == 0.0 does not raise, so the two
  // runtimes agree there. This divergence is deliberate and caught here.
  it("coerces null to zero violMult, not the default", () => {
    expect(parseTrendlinesConfig([5, null]).violMult).toBe(0);
  });

  it("rejects a zero or negative touchMult back to the default", () => {
    expect(parseTrendlinesConfig([5, 0.25, 0]).touchMult).toBe(0.75);
    expect(parseTrendlinesConfig([5, 0.25, -1]).touchMult).toBe(0.75);
  });

  it("floors the integer params and rejects junk", () => {
    const cfg = parseTrendlinesConfig([5.9, 0.25, 0.75, 2.7, "x", null, 30, 3]);
    expect(cfg.pivotLen).toBe(5);
    expect(cfg.minTouches).toBe(2);
    expect(cfg.minSpanBars).toBe(TRENDLINES_DEFAULTS.minSpanBars);
    expect(cfg.maxProjBars).toBe(TRENDLINES_DEFAULTS.maxProjBars);
  });

  it("survives a non-array", () => {
    expect(parseTrendlinesConfig(undefined)).toEqual(TRENDLINES_DEFAULTS);
  });

  it("clamps minTouches to at least 2", () => {
    expect(parseTrendlinesConfig([5, 0.25, 0.75, 1]).minTouches).toBe(2);
  });

  it("clamps integer params to at least 1", () => {
    expect(parseTrendlinesConfig([0.5]).pivotLen).toBe(1);
  });
});

describe("outputs and warm-up", () => {
  it("names the four operands in pane order", () => {
    expect(TRENDLINES_OUTPUTS).toEqual([
      "tl_support",
      "tl_resistance",
      "tl_broken_support",
      "tl_broken_resistance",
    ]);
  });

  // ATR must be warm, two pivots must confirm, and they must span the minimum.
  it("floors warm-up at ATR + two confirms + the minimum span", () => {
    expect(trendlinesWarmup(TRENDLINES_DEFAULTS)).toBe(14 + 2 * 5 + 20);
    expect(trendlinesWarmup({ ...TRENDLINES_DEFAULTS, pivotLen: 9 })).toBe(14 + 18 + 20);
  });
});
