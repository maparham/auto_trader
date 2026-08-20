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
  // value on 87 bars of that fixture.
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
      minSwingAtr: 0,
      minSwingReach: 0,
      pairPivots: MAX_PAIR_PIVOTS,
      maxTouches: 0,
      maxSpanBars: 0,
      maxSlopeAtr: 0,
      minSlopeAtr: 0,
      minBackBars: 10,
    });
  });
});

describe("parseTrendlinesConfig", () => {
  it("takes every default from an empty params list", () => {
    expect(parseTrendlinesConfig([])).toEqual(TRENDLINES_DEFAULTS);
  });

  it("reads params positionally", () => {
    const cfg = parseTrendlinesConfig([9, 0.5, 1.5, 3, 40, 100, 10, 2, 0.8, 12, 40, 6, 90, 0.3, 0.02, 25]);
    expect(cfg).toEqual({
      pivotLen: 9,
      violMult: 0.5,
      touchMult: 1.5,
      minTouches: 3,
      minSpanBars: 40,
      maxProjBars: 100,
      breakHoldBars: 10,
      maxLines: 2,
      minSwingAtr: 0.8,
      minSwingReach: 12,
      pairPivots: 40,
      maxTouches: 6,
      maxSpanBars: 90,
      maxSlopeAtr: 0.3,
      minSlopeAtr: 0.02,
      minBackBars: 25,
    });
  });

  // The ONLY gate whose default is not off: it closes a hole in seeding rather
  // than expressing a taste, so charts saved before it existed move under it.
  // A NEGATIVE falls back to that default rather than to 0, unlike the gates
  // that default to 0 and land there either way: only an explicit 0 is off.
  it("defaults Min Back Clearance on and clamps it to zero", () => {
    expect(parseTrendlinesConfig([]).minBackBars).toBe(10);
    const base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0];
    for (const [raw, want] of [[25, 25], [25.9, 25], [0, 0], [-2, 10]] as const)
      expect(parseTrendlinesConfig([...base, raw]).minBackBars).toBe(want);
    expect(parseTrendlinesConfig([...base, "x"]).minBackBars).toBe(10);
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

  // minSwingAtr's default IS zero, so this pins the `>= 0` rule rather than a
  // value: on a `> 0` rule a stored 0 would take the default, which happens to
  // be 0 too, and the test would pass while the setting could never be turned
  // off once raised. Reading it back from a non-default config is what shows
  // the difference.
  it("keeps a zero minSwingAtr, so the gate can be switched off", () => {
    const on = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 1.5];
    expect(parseTrendlinesConfig(on).minSwingAtr).toBe(1.5);
    expect(parseTrendlinesConfig([...on.slice(0, 8), 0]).minSwingAtr).toBe(0);
  });

  it("rejects a negative or junk minSwingAtr back to the default", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, v]).minSwingAtr;
    expect(at(-1)).toBe(0);
    expect(at("x")).toBe(0);
    expect(at(undefined)).toBe(0);
  });

  // Floored to an integer and clamped to 0, NOT to 1 like the other integer
  // params: intAt's floor of 1 would make the off state unreachable.
  it("floors minSwingReach and clamps it to zero, not one", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, v])
        .minSwingReach;
    expect(at(12.9)).toBe(12);
    expect(at(0)).toBe(0);
    expect(at(-4)).toBe(0);
    expect(at("x")).toBe(0);
  });

  it("defaults pairPivots to the constant and clamps it to at least one", () => {
    // intAt, so a 0-wide window (which could pair with nothing, and no line
    // could ever form) falls back to the default rather than sticking.
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, v])
        .pairPivots;
    expect(parseTrendlinesConfig([]).pairPivots).toBe(MAX_PAIR_PIVOTS);
    expect(at(60)).toBe(60);
    expect(at(5.9)).toBe(5);
    expect(at(0)).toBe(MAX_PAIR_PIVOTS);
    expect(at(-3)).toBe(MAX_PAIR_PIVOTS);
  });

  it("defaults maxTouches off and clamps it to zero, not one", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, v])
        .maxTouches;
    expect(parseTrendlinesConfig([]).maxTouches).toBe(0);
    expect(at(5)).toBe(5);
    expect(at(5.9)).toBe(5);
    expect(at(0)).toBe(0);
    expect(at(-2)).toBe(0);
    expect(at("x")).toBe(0);
  });

  it("defaults maxSpanBars off and clamps it to zero, not one", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, v])
        .maxSpanBars;
    expect(parseTrendlinesConfig([]).maxSpanBars).toBe(0);
    expect(at(40)).toBe(40);
    expect(at(40.9)).toBe(40);
    expect(at(0)).toBe(0);
    expect(at(-2)).toBe(0);
    expect(at("x")).toBe(0);
  });

  it("defaults maxSlopeAtr off and takes a zero", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, v])
        .maxSlopeAtr;
    expect(parseTrendlinesConfig([]).maxSlopeAtr).toBe(0);
    expect(at(0.25)).toBe(0.25);
    expect(at(0)).toBe(0);
    expect(at(-1)).toBe(0);
    expect(at("x")).toBe(0);
  });

  it("defaults minSlopeAtr off and takes a zero", () => {
    const at = (v: unknown) =>
      parseTrendlinesConfig([
        5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, v,
      ]).minSlopeAtr;
    expect(parseTrendlinesConfig([]).minSlopeAtr).toBe(0);
    expect(at(0.05)).toBe(0.05);
    expect(at(0)).toBe(0);
    expect(at(-1)).toBe(0);
    expect(at("x")).toBe(0);
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
