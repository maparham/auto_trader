import type { KLineData } from "klinecharts";
import { describe, expect, it } from "vitest";
import {
  buildTlState,
  computeTrendlines,
  createTrendlinesSession,
  touchGaps,
  dropTrendlineHandles,
  getTrendlineHandles,
  hitAnyTrendlineHandle,
  hitHandle,
  inTouchBand,
  withinSlope,
  aboveSlope,
  hasBackClearance,
  hasSwingReach,
  isSignificantSwing,
  lineExtent,
  lineKey,
  meetsAt,
  pierces,
  TL_HANDLE_HIT,
  TL_HANDLE_RADIUS,
  TL_HANDLE_STROKE,
  TL_TOUCH_RADIUS,
  TL_PIVOT_ARM,
  TL_PIVOT_GAP,
  projectAt,
  rankLines,
  dedupeTolerance,
  selectDrawnLines,
  drawnPivotIdxs,
  TL_PIVOT_INSET,
  trendlineDimmed,
  TL_DIM_ALPHA,
  trendlineDimAlpha,
  TL_DEDUPE_ATR,
  TL_NEAR_PRICE_ATR,
  TRENDLINES_TEMPLATE,
  type TrendlinesCalcPoint,
  type TrendLine,
} from "./trendlines";
import {
  parseTrendlinesConfig,
  TRENDLINES_DEFAULTS,
  type TrendlinesConfig,
} from "./trendlinesOutputs";

// A resistance line falling 1.0 per bar from 100 at bar 0 to 90 at bar 10.
const res: TrendLine = {
  side: "resistance",
  i1: 0,
  p1: 100,
  i2: 10,
  p2: 90,
  touches: 2,
  // The two anchors, which is what a freshly seeded line carries. Fixtures that
  // move their anchors and mean to exercise the shared-BAR half of sharesPivot
  // override this; the rest match on anchors, as they did before it existed.
  touchIdxs: [0, 10],
  lastTouchIdx: 10,
  brokenIdx: null,
  firstTouchIdx: 0,
  // The anchor gap, which is what those two touches alone span. Fixtures that
  // move their anchors and care about spacing override it.
  maxTouchGap: 10,
  minTouchGap: 10,
  maxTouchIdx: 10,
};

// A support line rising 1.0 per bar from 50 at bar 0 to 60 at bar 10.
const sup: TrendLine = { ...res, side: "support", p1: 50, p2: 60 };

describe("projectAt", () => {
  it("interpolates between the anchors", () => {
    expect(projectAt(res, 5)).toBeCloseTo(95, 10);
    expect(projectAt(sup, 5)).toBeCloseTo(55, 10);
  });

  it("extrapolates past the second anchor", () => {
    expect(projectAt(res, 20)).toBeCloseTo(80, 10);
  });

  it("returns the exact endpoint prices", () => {
    expect(projectAt(res, res.i1)).toBe(100);
    expect(projectAt(res, res.i2)).toBe(90);
  });
});

describe("pierces", () => {
  it("a high above a resistance line by more than the tolerance pierces it", () => {
    expect(pierces(res, 5, 96.5, 1)).toBe(true);
    expect(pierces(res, 5, 95.5, 1)).toBe(false);
  });

  it("a low below a support line by more than the tolerance pierces it", () => {
    expect(pierces(sup, 5, 53.5, 1)).toBe(true);
    expect(pierces(sup, 5, 54.5, 1)).toBe(false);
  });

  it("does not pierce on the wrong side", () => {
    expect(pierces(res, 5, 10, 1)).toBe(false);
    expect(pierces(sup, 5, 900, 1)).toBe(false);
  });

  // THE parity test. A bar exactly at line + violTol must not pierce, and one
  // ULP beyond must. This is precisely where a slope-and-project implementation
  // diverges between runtimes, so it is what earns the cross-product form.
  //
  // JavaScript has no Math.nextUp (that is Java/Python). Step to the adjacent
  // double by incrementing the IEEE-754 bit pattern. Valid for positive finite
  // x, which is all these tests use. Python's side uses math.nextafter.
  const nextUp = (x: number): number => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    if (lo === 0xffffffff) {
      view.setUint32(0, hi + 1);
      view.setUint32(4, 0);
    } else {
      view.setUint32(4, lo + 1);
    }
    return view.getFloat64(0);
  };

  it("steps to the adjacent double", () => {
    expect(nextUp(96)).toBeGreaterThan(96);
    expect(nextUp(96) - 96).toBeLessThan(1e-10);
  });

  it("is exact at the tolerance boundary", () => {
    // Line value at bar 5 is 95, so 95 + violTol(1) = 96 is exactly on the edge.
    const atBoundary = 96;
    expect(pierces(res, 5, atBoundary, 1)).toBe(false);
    expect(pierces(res, 5, nextUp(atBoundary), 1)).toBe(true);
  });

  it("treats a zero tolerance as exact containment", () => {
    expect(pierces(res, 5, 95, 0)).toBe(false);
    expect(pierces(res, 5, nextUp(95), 0)).toBe(true);
  });

  it("discriminates cross-product from the forbidden slope-and-project form", () => {
    // This is the discriminating test. With most lines, every value is so
    // representable in binary that slope-and-project gets the same answer as
    // cross-product. But a line with slope -10/3 (not representable) exposes the
    // divergence.
    //
    // Resistance line from 100 at bar 0 to 90 at bar 3 has slope -10/3.
    // The exact mathematical boundary at j=1 is 290/3 ≈ 96.666...
    // The double 96.66666666666667 lies strictly ABOVE it:
    // Its mantissa times 3 is 20406935811522561, while 290 in that exponent
    // is 20406935811522560 — so price*3 exceeds 290 by exactly 1 ULP.
    //
    // Cross-product form: (96.66666666666667 - 100) * 3 > -10 → true. CORRECT.
    // Slope form: 96.66666666666667 > 100 + (-10*1)/3 → false (projects to same double). WRONG.
    const thirds: TrendLine = {
      side: "resistance",
      i1: 0,
      p1: 100,
      i2: 3,
      p2: 90,
      touches: 2,
      touchIdxs: [0, 3],
      lastTouchIdx: 3,
      maxTouchGap: 3,
      minTouchGap: 3,
      maxTouchIdx: 3,
      brokenIdx: null,
      firstTouchIdx: 0,
    };
    expect(pierces(thirds, 1, 96.66666666666667, 0)).toBe(true);
  });
});

describe("inTouchBand", () => {
  // Asymmetric on purpose. For resistance the band is
  // [line - touchTol, line + violTol]: a symmetric band with touchTol > violTol
  // would put the far edge of the "touch" zone inside the pierce zone.
  it("accepts a pivot below a resistance line by up to touchTol", () => {
    expect(inTouchBand(res, 5, 93, 1, 2)).toBe(true);
    expect(inTouchBand(res, 5, 92.9, 1, 2)).toBe(false);
  });

  it("accepts a pivot above a resistance line by up to violTol only", () => {
    expect(inTouchBand(res, 5, 96, 1, 2)).toBe(true);
    expect(inTouchBand(res, 5, 96.1, 1, 2)).toBe(false);
  });

  it("mirrors the asymmetry for support", () => {
    expect(inTouchBand(sup, 5, 57, 1, 2)).toBe(true);
    expect(inTouchBand(sup, 5, 57.1, 1, 2)).toBe(false);
    expect(inTouchBand(sup, 5, 54, 1, 2)).toBe(true);
    expect(inTouchBand(sup, 5, 53.9, 1, 2)).toBe(false);
  });
});

describe("meetsAt", () => {
  // res falls 1/bar from 100@0; sup rises 1/bar from 50@0. They meet where
  // 100 - j == 50 + j, i.e. j == 25 exactly.
  it("solves the exact crossing, fraction and all", () => {
    expect(meetsAt(res, [sup], 10, 250)).toBe(25);
    // A half-bar crossing must come back fractional, not snapped: klinecharts
    // maps a fractional index to a real pixel, so rounding here would visibly
    // miss the apex.
    const slower: TrendLine = { ...sup, p2: 55 };
    expect(meetsAt(res, [slower], 10, 250)).toBe(100 / 3);
  });

  it("only looks forward, and only inside the horizon", () => {
    expect(meetsAt(res, [sup], 25, 250)).toBeNull();
    expect(meetsAt(res, [sup], 10, 24)).toBeNull();
    expect(meetsAt(res, [sup], 10, 25)).toBe(25);
  });

  it("never meets a parallel line, including a coincident one", () => {
    const parallel: TrendLine = { ...res, p1: 80, p2: 70 };
    expect(meetsAt(res, [parallel], 10, 250)).toBeNull();
    expect(meetsAt(res, [{ ...res }], 10, 250)).toBeNull();
  });

  it("takes the nearest crossing when several are ahead", () => {
    const far: TrendLine = { ...sup, p1: 0, p2: 5 };
    expect(meetsAt(res, [far, sup], 10, 250)).toBe(25);
  });

  it("returns null with nothing to meet", () => {
    expect(meetsAt(res, [], 10, 250)).toBeNull();
  });
});

describe("rankLines", () => {
  const base: TrendLine = { ...res };
  it("prefers more touches, then longer span", () => {
    expect(
      rankLines({ ...base, touches: 3 }, { ...base, touches: 2 }),
    ).toBeLessThan(0);
    expect(
      rankLines(
        { ...base, i1: 0, lastTouchIdx: 50 },
        { ...base, i1: 10, lastTouchIdx: 50 },
      ),
    ).toBeLessThan(0);
  });

  it("breaks every remaining tie deterministically", () => {
    const a = { ...base, lastTouchIdx: 20 };
    const b = { ...base, lastTouchIdx: 10, i1: -10 };
    // same touches, same span (20-0 vs 10-(-10)) -> newer lastTouchIdx wins
    expect(rankLines(a, b)).toBeLessThan(0);
    // fully identical -> 0, so no reliance on sort stability
    expect(rankLines({ ...base }, { ...base })).toBe(0);
  });
});

/** Bars with a flat 1.0 true range so ATR(14) settles at exactly 1.0, which
 * makes every tolerance in these tests a round number. */
function bar(i: number, low: number, high: number): KLineData {
  const mid = (low + high) / 2;
  return { timestamp: i * 60_000, open: mid, high, low, close: mid, volume: 1 };
}

/** A flat corridor of `n` bars around price 100, each with range 1.0. */
function flat(n: number, from = 0): KLineData[] {
  return Array.from({ length: n }, (_, k) => bar(from + k, 99.5, 100.5));
}

// minBackBars 0, unlike the shipped default of 10: these fixtures are short
// synthetic corridors whose first anchor sits within a few bars of the series
// start, where the clearance gate rejects by design. Every test that is about
// the gate itself sets it explicitly.
const cfg = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig => ({
  ...TRENDLINES_DEFAULTS,
  pivotLen: 2,
  minSpanBars: 5,
  minBackBars: 0,
  ...over,
});

describe("isSignificantSwing", () => {
  //        0   1   2   3   4
  const highs = [10, 14, 10, 10, 12];
  const lows = [10, 10, 10, 6, 10];

  it("passes everything at zero, without reading a bar", () => {
    // Off is a short circuit, not a comparison that happens to come out true:
    // an EMPTY pool would otherwise reject.
    expect(isSignificantSwing([], [], [], 0, "support", 1, 0)).toBe(true);
  });

  it("measures a low against the most recent HIGH pivot before it", () => {
    // Leg = highs[1] - lows[3] = 14 - 6 = 8.
    const at = (mult: number) =>
      isSignificantSwing(highs, lows, [1], 3, "support", 1, mult);
    expect(at(8)).toBe(true);
    expect(at(8.01)).toBe(false);
  });

  it("measures a high against the most recent LOW pivot before it", () => {
    // Leg = highs[4] - lows[3] = 12 - 6 = 6.
    const at = (mult: number) =>
      isSignificantSwing(highs, lows, [3], 4, "resistance", 1, mult);
    expect(at(6)).toBe(true);
    expect(at(6.01)).toBe(false);
  });

  it("takes the LAST opposite pivot, not the first", () => {
    // Pool [0, 1]: bar 1's high of 14 is the leg, not bar 0's 10.
    expect(isSignificantSwing(highs, lows, [0, 1], 3, "support", 1, 8)).toBe(
      true,
    );
    expect(isSignificantSwing(highs, lows, [0], 3, "support", 1, 8)).toBe(false);
  });

  it("ignores an opposite pivot at or after the bar itself", () => {
    // Strictly before: one bar can be both a strict high and a strict low
    // pivot, and the resistance pool fills first within a confirm bar. With 3
    // and 4 skipped, bar 1 is the leg; with only 3 and 4 there is nothing.
    expect(isSignificantSwing(highs, lows, [1, 3, 4], 3, "support", 1, 8)).toBe(
      true,
    );
    expect(isSignificantSwing(highs, lows, [3, 4], 3, "support", 1, 0.1)).toBe(
      false,
    );
  });

  it("rejects when no opposite pivot exists yet", () => {
    // Unmeasurable is not the same as big.
    expect(isSignificantSwing(highs, lows, [], 3, "support", 1, 0.1)).toBe(
      false,
    );
  });

  it("scales the threshold with ATR", () => {
    expect(isSignificantSwing(highs, lows, [1], 3, "support", 2, 4)).toBe(true);
    expect(isSignificantSwing(highs, lows, [1], 3, "support", 2, 4.01)).toBe(
      false,
    );
  });

  it("does NOT depend on pivotLen, which is the whole point", () => {
    // The old window-average measure grew with pivotLen, so a stricter pivot
    // setting could ADD lines. There is no pivotLen argument left to pass.
    expect(isSignificantSwing.length).toBe(7);
  });
});

describe("withinSlope", () => {
  // Rise 10 over span 10 = 1.0 per bar; at ATR 2 that is 0.5 ATR per bar.
  const line: TrendLine = { ...sup, p1: 100, p2: 110 };

  it("passes everything at zero", () => {
    expect(withinSlope(line, 2, 0)).toBe(true);
  });

  it("compares steepness in ATR per bar", () => {
    expect(withinSlope(line, 2, 0.5)).toBe(true);
    expect(withinSlope(line, 2, 0.49)).toBe(false);
  });

  it("ignores direction, only steepness", () => {
    const down = { ...line, p2: 90 };
    expect(withinSlope(down, 2, 0.5)).toBe(true);
    expect(withinSlope(down, 2, 0.49)).toBe(false);
  });
});

describe("aboveSlope", () => {
  const line: TrendLine = { ...sup, p1: 100, p2: 110 };

  it("passes everything at zero", () => {
    expect(aboveSlope(line, 2, 0)).toBe(true);
  });

  it("is the mirror of withinSlope at the same threshold", () => {
    // Both true exactly at the boundary, so a band of [x, x] admits only a
    // line at exactly that steepness rather than nothing at all.
    expect(aboveSlope(line, 2, 0.5)).toBe(true);
    expect(withinSlope(line, 2, 0.5)).toBe(true);
    expect(aboveSlope(line, 2, 0.51)).toBe(false);
  });

  it("ignores direction, only steepness", () => {
    const down = { ...line, p2: 90 };
    expect(aboveSlope(down, 2, 0.5)).toBe(true);
    expect(aboveSlope(down, 2, 0.51)).toBe(false);
  });
});

describe("hasSwingReach", () => {
  // A low of 6 with 10s to its left: it beats every one of them.
  const lows = [10, 10, 10, 10, 6];
  const highs = [10, 10, 10, 10, 14];

  it("passes everything at zero, without reading a bar", () => {
    expect(hasSwingReach([], 0, "support", 0)).toBe(true);
  });

  it("counts only the bars to the LEFT", () => {
    // Nothing to the right of index 4 exists, and asking for 4 still passes:
    // right reach is deliberately not part of this.
    expect(hasSwingReach(lows, 4, "support", 4)).toBe(true);
    expect(hasSwingReach(highs, 4, "resistance", 4)).toBe(true);
  });

  it("rejects rather than truncating when it runs off the start", () => {
    // Same as isPivotAt: a window that does not fit is not a smaller window.
    expect(hasSwingReach(lows, 4, "support", 5)).toBe(false);
  });

  it("stops at the first bar that is not beyond the pivot", () => {
    expect(hasSwingReach([10, 5, 10, 10, 6], 4, "support", 2)).toBe(true);
    expect(hasSwingReach([10, 5, 10, 10, 6], 4, "support", 3)).toBe(false);
  });

  it("treats an equal bar as not beaten", () => {
    // Strict, matching isPivotAt's strict mode: a flat stretch is not reach.
    expect(hasSwingReach([10, 10, 10, 6, 6], 4, "support", 1)).toBe(false);
  });
});

describe("hasBackClearance", () => {
  // A flat corridor at 100 with a low at bar 4: a support line anchored there
  // has bars 0..3 well above it, so none of them can pierce it.
  const vals = Array.from({ length: 20 }, () => 100);
  vals[4] = 90;
  vals[12] = 95;
  const atr: Array<number | null> = Array.from({ length: 20 }, () => 1);
  const line: TrendLine = { ...sup, i1: 4, p1: 90, i2: 12, p2: 95 };

  it("passes everything at zero", () => {
    expect(hasBackClearance(line, vals, atr, 0.25, 0, [])).toBe(true);
  });

  it("reads only the bars before the FIRST anchor", () => {
    expect(hasBackClearance(line, vals, atr, 0.25, 4, [])).toBe(true);
  });

  it("rejects rather than truncating when it runs off the start", () => {
    // Same as isPivotAt and hasSwingReach: a window that does not fit is not a
    // smaller window, and the gate must not go weakest where the sample is
    // thinnest.
    expect(hasBackClearance(line, vals, atr, 0.25, 5, [])).toBe(false);
  });

  it("stops at the first bar that pierces the back-projection", () => {
    const pierced = [...vals];
    pierced[2] = 80;
    expect(hasBackClearance(line, pierced, atr, 0.25, 1, [])).toBe(true);
    expect(hasBackClearance(line, pierced, atr, 0.25, 2, [])).toBe(false);
  });

  it("counts an untestable bar as surviving", () => {
    // An unwarmed ATR gives no tolerance to test against, which is exactly what
    // the forward validation pass does with the same bar.
    const pierced = [...vals];
    pierced[2] = 80;
    const cold = [...atr];
    cold[2] = null;
    expect(hasBackClearance(line, pierced, cold, 0.25, 4, [])).toBe(true);
  });
});

describe("hasBackClearance stops at the reversal", () => {
  // A support that falls away from a peak. Bars 0..19 climb into a top at 19,
  // then a leg down: lows at 30 and 60 anchor a line whose backward projection
  // rises through the old rally and pierces every bar of it.
  const vals = Array.from({ length: 80 }, (_, i) =>
    i <= 19 ? 60 + i * 2 : 98 - (i - 19) * 0.6,
  );
  const atr: Array<number | null> = Array.from({ length: 80 }, () => 1);
  const line: TrendLine = {
    ...sup,
    i1: 30,
    p1: vals[30],
    i2: 60,
    p2: vals[60],
  };

  it("rejects on the old move when nothing marks the reversal", () => {
    // The behaviour before this change, still reachable when the compute floor
    // means no turn was ever recorded that far back.
    expect(hasBackClearance(line, vals, atr, 0.25, 25, [])).toBe(false);
  });

  it("passes once the top is known, on the leg's own bars alone", () => {
    expect(hasBackClearance(line, vals, atr, 0.25, 25, [19])).toBe(true);
  });

  it("takes the LAST turn before i1, not the first", () => {
    // An older top must not widen the window back into the previous move.
    expect(hasBackClearance(line, vals, atr, 0.25, 25, [3, 19])).toBe(true);
    // A turn at or after i1 is not this line's reversal and is ignored.
    expect(hasBackClearance(line, vals, atr, 0.25, 25, [19, 30, 44])).toBe(true);
  });

  it("still rejects when the leg's own bars pierce", () => {
    // The junk-line case: the reversal stop is not a free pass, only a shorter
    // window. Nothing about bar 29 belongs to the previous move.
    const pierced = [...vals];
    pierced[29] = 40;
    expect(hasBackClearance(line, pierced, atr, 0.25, 25, [19])).toBe(false);
  });

  it("falls back to the full walk when the turn is too close to i1", () => {
    // Pivots alternate, so an opposite turn often sits a bar or two behind i1.
    // Deciding on that window would DELETE lines the full walk clears, so the
    // short window is discarded rather than trusted. Both calls below therefore
    // give the same answer the strict walk gives.
    const flat = Array.from({ length: 80 }, () => 100);
    flat[30] = 90;
    flat[60] = 95;
    const clean: TrendLine = { ...sup, i1: 30, p1: 90, i2: 60, p2: 95 };
    expect(hasBackClearance(clean, flat, atr, 0.25, 25, [28])).toBe(true);
    expect(hasBackClearance(line, vals, atr, 0.25, 25, [28])).toBe(false);
  });

  it("never rescues a line that runs off the start of the series", () => {
    const early: TrendLine = { ...sup, i1: 12, p1: vals[12], i2: 60, p2: vals[60] };
    expect(hasBackClearance(early, vals, atr, 0.25, 25, [4])).toBe(false);
  });
});

describe("computeTrendlines", () => {
  it("returns one point per bar and emits nothing before warm-up", () => {
    const bars = flat(30);
    const { points } = computeTrendlines(bars, cfg());
    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({});
  });

  it("finds a rising support line through two swing lows", () => {
    // Two dips 20 bars apart, the second higher, inside a flat corridor.
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const sup = lines.filter((l) => l.side === "support");
    expect(sup.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(true);
  });

  // Min Pivot Size measures the LEG (this pivot to the last opposite pivot), so
  // these fixtures need BOTH sides, and the first pivot has to confirm after
  // ATR(14) has warmed: a confirm bar inside warm-up is skipped entirely, and
  // the missing turn silently starves every later leg.
  const wide = (n: number) =>
    Array.from({ length: n }, (_, k) => bar(k, 95, 105));
  // Highs poking above the corridor at 20 and 40, lows below it at 30 and 50.
  // The corridor's range of 10 settles ATR at ~10, so a leg of 11 is small and
  // one of ~20 is large against the same threshold.
  const legged = (lo30: number, lo50: number) => {
    const bars = wide(80);
    bars[20] = bar(20, 95, 105.5);
    bars[30] = bar(30, lo30, 105);
    bars[40] = bar(40, 95, 105.5);
    bars[50] = bar(50, lo50, 105);
    return bars;
  };
  const hasPair = (bars: KLineData[], c: TrendlinesConfig) =>
    computeTrendlines(bars, c).lines.some(
      (l) => l.side === "support" && l.i1 === 30 && l.i2 === 50,
    );

  it("drops a shallow swing once Min Pivot Size is on", () => {
    const bars = legged(94.5, 94.5); // legs of 11, about 1.05 ATR
    expect(hasPair(bars, cfg())).toBe(true);
    expect(hasPair(bars, cfg({ minSwingAtr: 1.5 }))).toBe(false);
  });

  it("keeps a deep swing at the same setting", () => {
    // Legs of 20.5 and 18.5: the gate rejects by SIZE, not everything.
    expect(hasPair(legged(85, 87), cfg({ minSwingAtr: 1.5 }))).toBe(true);
  });

  // Min Pivot Size no longer moves with Min Pivot Length. The measure it
  // replaced averaged the fractal window, so widening that window inflated
  // every pivot's size and a STRICTER pivot setting could ADD lines (measured
  // on the DXY fixture: 11 of 123 pivots passed at length 2, 25 of 51 at
  // length 5, and the drawn count went 3 to 12).
  it("gives the same verdict at every Pivot Length", () => {
    const shallow = legged(94.5, 94.5);
    const deep = legged(85, 87);
    for (const pivotLen of [2, 3, 4, 5]) {
      const c = { ...cfg({ minSwingAtr: 1.5 }), pivotLen };
      expect(hasPair(shallow, c), `shallow at ${pivotLen}`).toBe(false);
      expect(hasPair(deep, c), `deep at ${pivotLen}`).toBe(true);
    }
  });

  it("drops a swing with too little reach once Min Swing Reach is on", () => {
    // A rising pair, with a shallower low at bar 32 that sits ABOVE the line
    // (so it does not pierce the candidate) but below bar 40's low, which caps
    // bar 40's left reach at 7.
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[32] = bar(32, 93.5, 100.5);
    const pair = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).lines.some(
        (l) => l.side === "support" && l.i1 === 20 && l.i2 === 40,
      );
    expect(pair(cfg({ minSwingReach: 5 }))).toBe(true);
    expect(pair(cfg({ minSwingReach: 10 }))).toBe(false);
  });

  it("reaches further back as Pair Lookback widens", () => {
    // Three lows far apart. With a window of 1, bar 60 only pairs with bar 40,
    // so the 20-to-60 line cannot exist; at 2 it reaches past bar 40 to bar 20.
    // This is why a STRICTER pivot setting can ADD lines: dropping pivots frees
    // the same slots to cover more bars.
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const pair = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).lines.some(
        (l) => l.side === "support" && l.i1 === 20 && l.i2 === 60,
      );
    expect(pair(cfg({ pairPivots: 1 }))).toBe(false);
    expect(pair(cfg({ pairPivots: 2 }))).toBe(true);
  });

  it("never seeds a line flatter than Min Slope", () => {
    const barsFor = (lo60: number) => {
      const b = flat(80);
      b[20] = bar(20, 90, 100.5);
      b[60] = bar(60, lo60, 100.5);
      return b;
    };
    const pair = (b: KLineData[], c: TrendlinesConfig) =>
      computeTrendlines(b, c).lines.some((l) => l.i1 === 20 && l.i2 === 60);
    const flatPair = barsFor(90.2);
    const steep = barsFor(98);
    expect(pair(flatPair, cfg())).toBe(true);
    expect(pair(flatPair, cfg({ minSlopeAtr: 0.1 }))).toBe(false);
    expect(pair(steep, cfg({ minSlopeAtr: 0.1 }))).toBe(true);
  });

  it("never seeds a line steeper than Max Slope", () => {
    // Two dips 40 bars apart. The steep pair climbs 8 over 40 bars (0.2 per
    // bar, about 0.2 ATR); the shallow pair climbs 1.
    const barsFor = (lo60: number) => {
      const b = flat(80);
      b[20] = bar(20, 90, 100.5);
      b[60] = bar(60, lo60, 100.5);
      return b;
    };
    const pair = (b: KLineData[], c: TrendlinesConfig) =>
      computeTrendlines(b, c).lines.some((l) => l.i1 === 20 && l.i2 === 60);
    const steep = barsFor(98);
    const shallow = barsFor(91);
    expect(pair(steep, cfg())).toBe(true);
    expect(pair(steep, cfg({ maxSlopeAtr: 0.1 }))).toBe(false);
    expect(pair(shallow, cfg({ maxSlopeAtr: 0.1 }))).toBe(true);
  });

  it("never seeds a pair whose wrong side is in the past", () => {
    // A support pair at bars 30 and 50 with bar 20 far BELOW its
    // back-projection: valid over (i1, i], and nonsense before it. Bar 20, not
    // an earlier one, so ATR(14) has warmed up there.
    const bars = flat(80);
    bars[20] = bar(20, 80, 100.5);
    bars[30] = bar(30, 90, 100.5);
    bars[50] = bar(50, 94, 100.5);
    const seeds = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).lines.some((l) => l.i1 === 30 && l.i2 === 50);
    expect(seeds(cfg())).toBe(true);
    expect(seeds(cfg({ minBackBars: 9 }))).toBe(true);
    expect(seeds(cfg({ minBackBars: 10 }))).toBe(false);
  });

  it("silences a line past Max Span without destroying it", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some((p) => p.tl_support !== undefined);
    expect(emits(cfg())).toBe(true);
    expect(emits(cfg({ maxSpanBars: 40 }))).toBe(true);
    expect(emits(cfg({ maxSpanBars: 39 }))).toBe(false);
    const { lines } = computeTrendlines(bars, cfg({ maxSpanBars: 39 }));
    expect(lines.some((l) => l.lastTouchIdx - l.i1 >= 40)).toBe(true);
  });

  it("silences a line past Max Touches without destroying it", () => {
    // Three dips on one rising line: the pair plus a third pivot touching it.
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some((p) => p.tl_support !== undefined);
    expect(emits(cfg({ minTouches: 3 }))).toBe(true);
    expect(emits(cfg({ minTouches: 3, maxTouches: 3 }))).toBe(true);
    expect(emits(cfg({ minTouches: 3, maxTouches: 2 }))).toBe(false);
    // Silenced, not deleted: it is still in live state doing pierce and touch
    // work for the lines around it.
    const { lines } = computeTrendlines(
      bars,
      cfg({ minTouches: 3, maxTouches: 2 }),
    );
    expect(lines.some((l) => l.touches >= 3)).toBe(true);
  });

  it("silences a line whose touches sit further apart than Max Touch Spacing", () => {
    // One pair, 40 bars apart and nothing in between, so the spacing IS the
    // anchor gap.
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some((p) => p.tl_support !== undefined);
    expect(emits(cfg())).toBe(true);
    expect(emits(cfg({ maxTouchSpacing: 40 }))).toBe(true);
    expect(emits(cfg({ maxTouchSpacing: 39 }))).toBe(false);
    // Silenced, not deleted, like the two ceilings above it.
    const { lines } = computeTrendlines(bars, cfg({ maxTouchSpacing: 39 }));
    expect(lines.some((l) => l.maxTouchGap === 40)).toBe(true);
  });

  // THE SORT, and the reason widestTouchGap copies before it. A touch BETWEEN
  // the anchors splits the anchor gap in two, so this line is well spaced even
  // though its span is unchanged. touchIdxs holds [20, 60, 40] in insertion
  // order (the retro pass appends after i2), so an implementation that walked
  // it as-is would measure 40 and -20, report the anchor gap unsplit, and
  // reject exactly the line the setting exists to keep.
  it("measures the gap between touches in BAR order, not insertion order", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const line = computeTrendlines(bars, cfg({ minTouches: 3 })).lines.find(
      (l) => l.i1 === 20 && l.i2 === 60,
    );
    expect(line).toBeDefined();
    // The premise: recorded out of order, with the mid touch last.
    expect((line as TrendLine).touchIdxs).toEqual([20, 60, 40]);
    expect((line as TrendLine).maxTouchGap).toBe(20);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some((p) => p.tl_support !== undefined);
    // 20 admits it; the anchor gap of 40 would not have.
    expect(emits(cfg({ minTouches: 3, maxTouchSpacing: 20 }))).toBe(true);
    expect(emits(cfg({ minTouches: 3, maxTouchSpacing: 19 }))).toBe(false);
  });

  it("keeps measuring spacing as touches arrive after the seed", () => {
    // Anchors 20 bars apart, then a third touch 40 bars after the second: the
    // widest gap is that late one, not the anchor pair.
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[80] = bar(80, 96, 100.5);
    const line = computeTrendlines(bars, cfg({ minTouches: 3 })).lines.find(
      (l) => l.i1 === 20 && l.i2 === 40,
    );
    expect(line).toBeDefined();
    expect((line as TrendLine).touchIdxs).toEqual([20, 40, 80]);
    expect((line as TrendLine).maxTouchGap).toBe(40);
    // maxTouchIdx tracks the newest touch, which is what makes that O(1).
    expect((line as TrendLine).maxTouchIdx).toBe(80);
  });

  // THE FLOOR, and the case that proves it is not just Min Span wearing a new
  // label. On a TWO-touch line the two are the same number: a fresh pair has
  // one gap, i2 - i1, and minSpanBars measures lastTouchIdx - i1. So the test
  // that discriminates is a line with a LONG span whose touches BUNCH: 20 and
  // 22 sit two bars apart inside a 60-bar span, so Min Span waves it through
  // and the floor rejects it.
  it("drops a line whose touches bunch, where Min Span cannot", () => {
    const bars = flat(100);
    bars[20] = bar(20, 90, 100.5);
    bars[22] = bar(22, 90.1, 100.5);
    bars[80] = bar(80, 93, 100.5);
    const line = computeTrendlines(
      bars,
      cfg({ pivotLen: 1, minTouches: 3 }),
    ).lines.find((l) => l.touchIdxs.includes(20) && l.touchIdxs.includes(22));
    expect(line).toBeDefined();
    // The premise: a long span carrying a two-bar gap.
    const l = line as TrendLine;
    expect(l.lastTouchIdx - l.i1).toBeGreaterThan(50);
    expect(l.minTouchGap).toBe(2);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some(
        (p) => p.tl_support !== undefined,
      );
    const base = { pivotLen: 1, minTouches: 3 } as Partial<TrendlinesConfig>;
    expect(emits(cfg({ ...base, minTouchSpacing: 2 }))).toBe(true);
    expect(emits(cfg({ ...base, minTouchSpacing: 3 }))).toBe(false);
    // Min Span cannot express that: the span clears any floor the bunched pair
    // would need, so raising it only removes the line for the wrong reason.
    expect(emits(cfg({ ...base, minSpanBars: 50 }))).toBe(true);
  });

  // THE GUARD THAT MUST NOT BE ZERO. touchGaps reports no-gap as widest 0 and
  // narrowest Infinity, because a floor compares the other way round: 0 would
  // be under every floor above zero and would silence every line that took the
  // guard path.
  it("reports no gap as 0 widest and Infinity narrowest, never 0 for both", () => {
    expect(touchGaps([])).toEqual({ widest: 0, narrowest: Infinity });
    expect(touchGaps([7])).toEqual({ widest: 0, narrowest: Infinity });
    expect(touchGaps([10, 50])).toEqual({ widest: 40, narrowest: 40 });
    // Out of bar order, the way the detector records them.
    expect(touchGaps([10, 50, 30])).toEqual({ widest: 20, narrowest: 20 });
    expect(touchGaps([10, 12, 50])).toEqual({ widest: 38, narrowest: 2 });
  });

  it("shrinks the narrowest gap as touches arrive after the seed", () => {
    // Anchors 40 apart, then a touch 2 bars after the second: the floor sees
    // that new gap even though the seed had nothing narrow in it.
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    bars[62] = bar(62, 94.3, 100.5);
    const line = computeTrendlines(
      bars,
      cfg({ pivotLen: 1, minTouches: 3 }),
    ).lines.find((l) => l.i1 === 20 && l.i2 === 60);
    expect(line).toBeDefined();
    expect((line as TrendLine).touchIdxs).toEqual([20, 60, 62]);
    expect((line as TrendLine).minTouchGap).toBe(2);
    expect((line as TrendLine).maxTouchGap).toBe(40);
  });

  it("is off at 0, so a chart saved before the param existed is unchanged", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const emits = (c: TrendlinesConfig) =>
      computeTrendlines(bars, c).points.some((p) => p.tl_support !== undefined);
    expect(emits(cfg({ maxTouchSpacing: 0 }))).toBe(true);
    expect(parseTrendlinesConfig([]).maxTouchSpacing).toBe(0);
    expect(parseTrendlinesConfig([]).minTouchSpacing).toBe(0);
    // Absent slots 17 and 18 read the defaults, which ARE the off state.
    const old = parseTrendlinesConfig([5, 0.25, 0.75, 2, 20, 250, 30, 3]);
    expect(old.maxTouchSpacing).toBe(0);
    expect(old.minTouchSpacing).toBe(0);
  });

  // THE INVARIANT: one recorded index per touch, anchors included, so the ×N
  // tag and the rings the chart paints can never disagree.
  it("records the bar of every touch, the anchors among them", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.touchIdxs).toHaveLength(l.touches);
      expect(l.touchIdxs).toContain(l.i1);
      expect(l.touchIdxs).toContain(l.i2);
      expect(Math.max(...l.touchIdxs)).toBe(l.lastTouchIdx);
      expect(Math.min(...l.touchIdxs)).toBe(l.i1);
    }
    // Non-triviality: this fixture really does produce a line with a touch
    // beyond its two anchors, so the assertions above are not all vacuous.
    const three = lines.find((l) => l.touches > 2);
    expect(three, "no line collected a third touch").toBeDefined();
    expect(three!.touchIdxs).toContain(40);
  });

  it("rejects a candidate that a bar between the anchors pierces", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    // A dip well under the 20->40 line. It IS a strict pivot low at this
    // pivotLen, so it seeds pairs of its own; what it kills is specifically
    // the 20->40 pair, which it sits far below.
    bars[30] = bar(30, 80, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    expect(lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(false);
    // Positive control: the assertion above passes vacuously on an empty list,
    // so pin the pairs that DO survive. Same vacuity class the causality test
    // guards against below.
    expect(lines.some((l) => l.i1 === 20 && l.i2 === 30)).toBe(true);
    expect(lines.some((l) => l.i1 === 30 && l.i2 === 40)).toBe(true);
  });

  // The hole that per-pivot break detection leaves: a line is almost always
  // broken by an ordinary bar, not by a pivot.
  it("marks a line broken on an ordinary bar, not only at a confirm bar", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    // Bar 60's LOW drops far below the projected support line (the break test
    // reads the bar's extreme via extremeOf, not its close). Bar 60 does also
    // confirm as a pivot low at bar 62, which is exactly the point: the break
    // must be recorded at 60, the bar that pierced, not at the confirm bar.
    bars[60] = bar(60, 80, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const line = lines.find((l) => l.i1 === 20 && l.i2 === 40);
    expect(line?.brokenIdx).toBe(60);
  });

  it("moves a broken line from tl_support to tl_broken_support", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 80, 100.5);
    const { points } = computeTrendlines(bars, cfg({ breakHoldBars: 10 }));
    expect(points[59].tl_support).toBeDefined();
    expect(points[61].tl_support).toBeUndefined();
    expect(points[61].tl_broken_support).toBeDefined();
    // Past the hold window it is gone from both.
    expect(points[75].tl_broken_support).toBeUndefined();
  });

  it("stops projecting past maxProjBars", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { points } = computeTrendlines(bars, cfg({ maxProjBars: 20 }));
    expect(points[55].tl_support).toBeDefined();
    expect(points[100].tl_support).toBeUndefined();
  });

  // The two clocks are INDEPENDENT: maxProjBars ages an UNBROKEN line from its
  // last touch, breakHoldBars holds a BROKEN one from its break bar. If the
  // emit path intersects them, a break landing near the end of a line's
  // projection horizon silently loses its retest window. No other test varies
  // both knobs, which is how that stayed hidden.
  it("holds a broken line for the whole breakHoldBars window past maxProjBars", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 80, 100.5);
    const { points } = computeTrendlines(
      bars,
      cfg({ maxProjBars: 20, breakHoldBars: 10 }),
    );
    // The unbroken horizon ends at lastTouchIdx(40) + maxProjBars(20) = 60,
    // exactly the break bar, so every hold-window bar lies beyond it.
    for (let i = 61; i <= 70; i++) {
      expect({
        bar: i,
        held: points[i].tl_broken_support !== undefined,
      }).toEqual({
        bar: i,
        held: true,
      });
    }
    expect(points[71].tl_broken_support).toBeUndefined();
  });

  // The property that actually protects backtests. If this fails, the
  // indicator is repainting and every backtest that reads it is wrong.
  it("is causal: a prefix computes the same values as the full series", () => {
    const bars = flat(90);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[62] = bar(62, 96, 100.5);
    bars[70] = bar(70, 88, 100.5);
    const full = computeTrendlines(bars, cfg()).points;
    // Non-triviality guard: a prefix/full comparison over an all-empty series
    // would pass while proving nothing, so assert the fixture really emits.
    expect(
      full.filter((p) => p.tl_support !== undefined).length,
    ).toBeGreaterThan(10);
    expect(full.some((p) => p.tl_broken_support !== undefined)).toBe(true);
    for (let i = 0; i < bars.length; i++) {
      const prefix = computeTrendlines(bars.slice(0, i + 1), cfg()).points;
      expect({ bar: i, ...prefix[i] }).toEqual({ bar: i, ...full[i] });
    }
  });
});

describe("selectDrawnLines", () => {
  // Flat lines at assorted distances from a close of 100 read at bar 100.
  const near: TrendLine = {
    ...sup,
    i1: 0,
    p1: 99,
    i2: 10,
    p2: 99,
    lastTouchIdx: 10,
  };
  const mid: TrendLine = {
    ...sup,
    i1: 0,
    p1: 90,
    i2: 10,
    p2: 90,
    lastTouchIdx: 10,
  };
  const far: TrendLine = {
    ...sup,
    i1: 0,
    p1: 10,
    i2: 10,
    p2: 10,
    lastTouchIdx: 10,
  };
  const resNear: TrendLine = {
    ...res,
    i1: 0,
    p1: 101,
    i2: 10,
    p2: 101,
    lastTouchIdx: 10,
  };
  const resFar: TrendLine = {
    ...res,
    i1: 0,
    p1: 400,
    i2: 10,
    p2: 400,
    lastTouchIdx: 10,
  };

  it("keeps the maxLines nearest the close, one budget across both sides", () => {
    // near (99) and resNear (101) are both 1 away; mid (90) is 10 away and the
    // rest further. A per-side budget of 2 would draw four lines here; the
    // budget is total, so exactly two draw and side does not shield a line.
    const out = selectDrawnLines(
      [far, mid, near, resFar, resNear],
      100,
      100,
      2,
      {},
      null,
    );
    expect(out).toEqual([near, resNear]);
  });

  it("lets one side take the whole budget when its lines are nearer", () => {
    // Both supports sit nearer to the close than the nearest resistance, so
    // maxLines 2 goes entirely to supports: "the lines nearest to price", not
    // "some of each side".
    expect(
      selectDrawnLines([mid, near, resFar], 100, 100, 2, {}, null),
    ).toEqual([near, mid]);
  });

  it("drops the far line even when it outranks the near one", () => {
    // `far` wins on touches, so a rank-first cap would keep it and delete the
    // line actually in play. The drawn set is proximity-first so it does not.
    const strongFar = { ...far, touches: 9 };
    expect(rankLines(strongFar, near)).toBeLessThan(0);
    expect(selectDrawnLines([strongFar, near], 100, 100, 1, {}, null)).toEqual([
      near,
    ]);
  });

  it("measures proximity by projection, not by anchor price", () => {
    // Anchored far below price but sloping through it: 50 at bar 0, 60 at bar
    // 10, so bar 100 projects to 150 (50 away) while the flat 90 is 10 away.
    const sloping: TrendLine = {
      ...sup,
      i1: 0,
      p1: 50,
      i2: 10,
      p2: 60,
      lastTouchIdx: 10,
    };
    expect(projectAt(sloping, 100)).toBeCloseTo(150, 10);
    expect(selectDrawnLines([sloping, mid], 100, 100, 1, {}, null)).toEqual([
      mid,
    ]);
  });

  it("breaks an exact proximity tie by rank, not by list order", () => {
    // Both exactly 1.0 from the close, one either side of it.
    const above: TrendLine = {
      ...sup,
      i1: 0,
      p1: 101,
      i2: 10,
      p2: 101,
      lastTouchIdx: 10,
    };
    const below: TrendLine = {
      ...sup,
      i1: 0,
      p1: 99,
      i2: 10,
      p2: 99,
      touches: 5,
      lastTouchIdx: 10,
    };
    expect(selectDrawnLines([above, below], 100, 100, 1, {}, null)).toEqual([
      below,
    ]);
    expect(selectDrawnLines([below, above], 100, 100, 1, {}, null)).toEqual([
      below,
    ]);
  });

  // THE UNION. maxLines is a floor for drawing, not a cap: a line an operand is
  // reading is drawn however far down the proximity order it sits, because the
  // chart is the only place a user can audit what a rule is doing. On the DXY
  // fixture the emit path's four picks (side x broken) against the drawing
  // budget hid an emitted value on 193 emissions; trendlinesDxy.test.ts pins
  // that at zero on real data, and these pin the mechanism.
  it("keeps an emitting line that falls outside maxLines", () => {
    // `far` is third by proximity, so maxLines 1 would drop it, but tl_support
    // is reading it.
    expect(
      selectDrawnLines([far, mid, near], 100, 100, 1, { tl_support: 10 }, null),
    ).toEqual([near, far]);
  });

  it("keeps a pinned line that falls outside maxLines", () => {
    // A pin's own handle is the only control that releases it, so the budget
    // must not evict the line: merging and the near-price cut already spare
    // pinned lines, and a budget that did not would strand a pin with nothing
    // to click the moment other lines crowd closer to price.
    expect(
      selectDrawnLines(
        [far, mid, near],
        100,
        100,
        1,
        {},
        { tol: 0, keep: new Set([far]) },
      ),
    ).toEqual([near, far]);
  });

  it("matches the emitted value by side and by broken state", () => {
    const brokenMid: TrendLine = { ...mid, brokenIdx: 50 };
    // tl_broken_support reaches the broken line; the unbroken `mid` at the same
    // price is not pulled in with it, and a resistance operand at that price
    // does not reach across sides either.
    expect(
      selectDrawnLines(
        [near, mid, brokenMid],
        100,
        100,
        1,
        { tl_broken_support: 90 },
        null,
      ),
    ).toEqual([near, brokenMid]);
    expect(
      selectDrawnLines([near, mid], 100, 100, 1, { tl_support: 90 }, null),
    ).toEqual([near, mid]);
    expect(
      selectDrawnLines([near, mid], 100, 100, 1, { tl_resistance: 90 }, null),
    ).toEqual([near]);
  });

  it("ignores an emitted value no line projects to", () => {
    // Exact equality, not proximity: the emitted number IS projectAt's result,
    // so a value 1e-9 away belongs to some other line and must not stand in.
    expect(
      selectDrawnLines(
        [near, mid],
        100,
        100,
        1,
        { tl_support: 90.000000001 },
        null,
      ),
    ).toEqual([near]);
  });

  it("returns everything when maxLines exceeds the live set", () => {
    expect(selectDrawnLines([near, mid], 100, 100, 9, {}, null)).toHaveLength(
      2,
    );
    expect(selectDrawnLines([], 100, 100, 3, {}, null)).toEqual([]);
  });

  // THE NEAR-PRICE FILTER, which is a DISTANCE cut and so does something
  // maxLines cannot: the budget keeps a fixed count however far away
  // they all are. `near` projects to 99 and `mid` to 80 against a close of 100,
  // so a tolerance of 5 admits one and rejects the other with the budget wide
  // open at 9.
  it("drops lines further than nearTol from the close", () => {
    expect(selectDrawnLines([near, mid], 100, 100, 9, {}, null, 5)).toEqual([
      near,
    ]);
    // 0 is off, not "everything is far".
    expect(
      selectDrawnLines([near, mid], 100, 100, 9, {}, null, 0),
    ).toHaveLength(2);
  });

  it("always keeps the nearest line on a side, however far it is", () => {
    // Every line miles away: a plain distance cut would leave the pane blank,
    // which reads as a broken indicator rather than as an answer.
    expect(selectDrawnLines([far, mid], 100, 100, 9, {}, null, 1)).toEqual([
      mid,
    ]);
    // Per SIDE, not one for the whole chart.
    const out = selectDrawnLines([far, resFar], 100, 100, 9, {}, null, 1);
    expect(out).toHaveLength(2);
  });

  it("keeps a far line the emit path is reading, or a pinned one", () => {
    // The chart is the only surface an operand can be audited on, so the
    // near-price cut gets the same exemptions merging does.
    expect(
      selectDrawnLines([near, mid, far], 100, 100, 9, { tl_support: 10 }, null, 1),
    ).toEqual([near, far]);
    expect(
      selectDrawnLines([near, mid, far], 100, 100, 9, {}, { tol: 0, keep: new Set([far]) }, 1),
    ).toEqual([near, far]);
  });
});

describe("selectDrawnLines dedup", () => {
  const NONE: ReadonlySet<TrendLine> = new Set();
  // A fan out of one pivot: both start at bar 0 / price 90, which is what a
  // swing pairing with two later swings produces. Read at bar 100.
  const fanA: TrendLine = {
    ...sup,
    i1: 0,
    p1: 90,
    i2: 50,
    p2: 94,
    touchIdxs: [0, 50],
    lastTouchIdx: 50,
  };
  const fanB: TrendLine = {
    ...sup,
    i1: 0,
    p1: 90,
    i2: 40,
    p2: 93.3,
    touchIdxs: [0, 40],
    lastTouchIdx: 40,
  };

  it("merges two lines out of the same pivot that land together", () => {
    expect(projectAt(fanA, 100)).toBeCloseTo(98, 6);
    expect(projectAt(fanB, 100)).toBeCloseTo(98.25, 6);
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toEqual([fanB]);
  });

  it("with no tolerance at all, keeps one line per pivot: the nearest to price", () => {
    // What "One line per pivot" runs: the three-through-one-swing case no
    // tolerance a pane can afford would collapse. Read at bar 100 against a
    // close of 100, these land 18 and 27 apart, so the fan survives any sane
    // Merge Tolerance and dies here.
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    const mid: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 86, touchIdxs: [0, 50] };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touchIdxs: [0, 50] };
    expect(projectAt(near, 100)).toBeCloseTo(100, 6);
    expect(projectAt(mid, 100)).toBeCloseTo(82, 6);
    expect(projectAt(far, 100)).toBeCloseTo(72, 6);
    expect(
      selectDrawnLines([mid, far, near], 100, 100, 3, {}, { tol: Infinity, keep: NONE }),
    ).toEqual([near]);
  });

  it("with no tolerance, still spares a line an operand is reading", () => {
    // The exemptions are the whole reason this is the merge pass and not a new
    // rule: the chart is the only surface an emitted value can be audited on.
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touchIdxs: [0, 50] };
    expect(
      selectDrawnLines(
        [near, far], 100, 100, 3, { tl_support: projectAt(far, 100) },
        { tol: Infinity, keep: NONE },
      ),
    ).toEqual([near, far]);
  });

  it("with no tolerance, still spares a pinned line", () => {
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touchIdxs: [0, 50] };
    expect(
      selectDrawnLines([near, far], 100, 100, 3, {}, { tol: Infinity, keep: new Set([far]) }),
    ).toEqual([near, far]);
  });

  it("with no tolerance, leaves lines that share no pivot alone", () => {
    // Not a distance cut: two unrelated levels both stay, however far apart.
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    const b: TrendLine = { ...sup, i1: 10, p1: 60, i2: 60, p2: 62, touchIdxs: [10, 60] };
    expect(
      selectDrawnLines([a, b], 100, 100, 3, {}, { tol: Infinity, keep: NONE }),
    ).toEqual([a, b]);
  });

  it("merges a fan that closes onto a shared second pivot", () => {
    // Different starts, same end: they meet at bar 50 and separate again after
    // it. Same clutter, so the same treatment.
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 94, touchIdxs: [0, 50] };
    const b: TrendLine = { ...sup, i1: 20, p1: 92, i2: 50, p2: 94, touchIdxs: [20, 50] };
    expect(
      selectDrawnLines([a, b], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("merges a chain, where one line's end is the other's start", () => {
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 94, touchIdxs: [0, 50] };
    const b: TrendLine = { ...sup, i1: 50, p1: 94, i2: 70, p2: 95.6, touchIdxs: [50, 70] };
    expect(projectAt(a, 100)).toBeCloseTo(98, 6);
    expect(projectAt(b, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines([a, b], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("leaves two lines alone when they share no pivot, however close", () => {
    // Identical projection at the last bar, but grown from different swings.
    // Merging on closeness alone would swallow unrelated levels.
    const other: TrendLine = { ...sup, i1: 20, p1: 70, i2: 60, p2: 84, touchIdxs: [20, 60] };
    expect(projectAt(other, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines([fanA, other], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
  });

  // The BAR decides it, and a differing recorded price does not save a line
  // from merging. Two same-side lines cannot honestly touch one bar at two
  // prices: a bar has one high and one low, and a touch is recorded only
  // within a tolerance of it. This fixture is therefore impossible in
  // production, and the rule that merges it is the same one that catches the
  // real case, where a swing anchors one line and is a mid-line touch of the
  // rest.
  it("treats the same bar as shared even at a different recorded price", () => {
    const sameBar: TrendLine = {
      ...sup,
      i1: 0,
      p1: 70,
      i2: 50,
      p2: 84,
      touchIdxs: [0, 50],
    };
    expect(projectAt(sameBar, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines(
        [fanA, sameBar],
        100,
        100,
        3,
        {},
        { tol: 1, keep: NONE },
      ),
    ).toHaveLength(1);
  });

  // The real shape this pass was missing: neither line is anchored where the
  // other one is, they only both TOUCH the same swing.
  it("merges two lines that only touch the same pivot, neither anchored on it", () => {
    const a: TrendLine = {
      ...sup,
      i1: 0,
      p1: 90,
      i2: 50,
      p2: 94,
      touches: 3,
      touchIdxs: [0, 30, 50],
      lastTouchIdx: 50,
    };
    const b: TrendLine = {
      ...sup,
      i1: 10,
      p1: 90.9,
      i2: 60,
      p2: 94.9,
      touches: 3,
      touchIdxs: [10, 30, 60],
      lastTouchIdx: 60,
    };
    // No anchor in common: the old test would have left both.
    expect(a.i1 === b.i1 || a.i2 === b.i2 || a.i1 === b.i2 || a.i2 === b.i1).toBe(
      false,
    );
    expect(Math.abs(projectAt(a, 100) - projectAt(b, 100))).toBeLessThan(1);
    expect(
      selectDrawnLines([a, b], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("stops merging once the two ends are further apart than tol", () => {
    const wide: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    expect(projectAt(wide, 100)).toBeCloseTo(100, 6);
    expect(
      selectDrawnLines([fanA, wide], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
  });

  it("frees the merged line's budget slot for a different line", () => {
    const other: TrendLine = {
      ...sup,
      i1: 5,
      p1: 60,
      i2: 55,
      p2: 60,
      lastTouchIdx: 55,
    };
    // Without merging the two fan lines fill maxLines 2 and `other` never
    // draws; with it, the freed slot goes to the line with a different shape.
    expect(
      selectDrawnLines([fanA, fanB, other], 100, 100, 2, {}, null),
    ).toEqual([fanB, fanA]);
    expect(
      selectDrawnLines(
        [fanA, fanB, other],
        100,
        100,
        2,
        {},
        { tol: 1, keep: NONE },
      ),
    ).toEqual([fanB, other]);
  });

  it("never merges away a line an operand is reading", () => {
    // fanA is the emitter here, so the exact-value guarantee outranks merging
    // and both survive.
    expect(
      selectDrawnLines(
        [fanA, fanB],
        100,
        100,
        3,
        { tl_support: projectAt(fanA, 100) },
        { tol: 1, keep: NONE },
      ),
    ).toEqual([fanB, fanA]);
  });

  it("never merges away a pinned line, which owns the only handle to undo it", () => {
    expect(
      selectDrawnLines(
        [fanA, fanB],
        100,
        100,
        3,
        {},
        { tol: 1, keep: new Set([fanA]) },
      ),
    ).toEqual([fanB, fanA]);
  });

  it("is off at tol 0, so an unwarmed ATR cannot silently thin the chart", () => {
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, {}, { tol: 0, keep: NONE }),
    ).toHaveLength(2);
    expect(dedupeTolerance(undefined, true)).toBe(0);
    expect(dedupeTolerance(NaN, true)).toBe(0);
    expect(dedupeTolerance(4, false)).toBe(0);
    expect(dedupeTolerance(4, true)).toBe(4 * TL_DEDUPE_ATR);
  });

  // THE FIELD. An explicit 0 is honoured (it means off, like the switch), but
  // anything that is not a finite number >= 0 falls back to the default rather
  // than turning merging off by accident: a chart saved before the field
  // existed has no key at all, and undefined * atr is NaN, which no comparison
  // is ever <= so nothing would merge.
  it("takes the tolerance from the panel, and falls back rather than breaking", () => {
    expect(dedupeTolerance(4, true, 2)).toBe(8);
    expect(dedupeTolerance(4, true, 0)).toBe(0);
    expect(dedupeTolerance(4, true, undefined)).toBe(4 * TL_DEDUPE_ATR);
    expect(dedupeTolerance(4, true, NaN)).toBe(4 * TL_DEDUPE_ATR);
    expect(dedupeTolerance(4, true, -1)).toBe(4 * TL_DEDUPE_ATR);
    // The LEGACY flag still wins, so a pane saved while the "Merge similar
    // lines" checkbox existed and was unticked stays unmerged. Nothing writes
    // it any more: 0 above is the switch the panel offers.
    expect(dedupeTolerance(4, false, 2)).toBe(0);
  });

  // THE DEFAULT, pinned with the ceiling that bounds it. It was raised to 2.5
  // on a measurement that could only ever go up: it counted the near-twins
  // LEFT at each tolerance and took the value that left fewest, with nothing
  // counting the distinct lines swallowed. Measured the other way on a live
  // US100 daily pane, not one merge at any tolerance from 0.25 to 3 was a fan
  // off a shared origin; every one joined lines beginning months apart that
  // converge on a later pivot, and 1 -> 2.5 nearly doubled how many of those
  // collapsed. The value is a field now, and this is only where it starts.
  //
  // Above half of TL_NEAR_PRICE_ATR a line at the close could merge with one at
  // the far edge of the band that is drawn at all, so that is a ceiling on the
  // default rather than a preference.
  it("defaults to 1 ATR, never more than half the near-price band", () => {
    expect(TL_DEDUPE_ATR).toBe(1);
    expect(TL_DEDUPE_ATR).toBeLessThanOrEqual(TL_NEAR_PRICE_ATR / 2);
  });

  it("does not merge across sides", () => {
    const mirror: TrendLine = { ...fanA, side: "resistance" };
    expect(
      selectDrawnLines([fanA, mirror], 100, 100, 3, {}, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
  });
});

describe("TRENDLINES_TEMPLATE", () => {
  it("declares the sixteen calcParams in spec order", () => {
    expect(TRENDLINES_TEMPLATE.calcParams).toEqual([
      5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0, 10,
    ]);
  });

  it("is a price-series overlay on the candle pane", () => {
    expect(TRENDLINES_TEMPLATE.series).toBe("price");
    expect(TRENDLINES_TEMPLATE.figures).toEqual([]);
  });

  it("rides the full line list on the last calc row only", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const rows = TRENDLINES_TEMPLATE.calc!(bars, {
      calcParams: [2, 0.25, 0.75, 2, 5, 250, 30, 3],
      extendData: {},
    } as never) as TrendlinesCalcPoint[];
    expect(rows).toHaveLength(60);
    expect(rows[rows.length - 1].lines).toBeDefined();
    expect(rows[0].lines).toBeUndefined();
  });

  // THE constraint that makes `extend` safe to expose. Decluttering the chart
  // must not silently change a strategy that reads tl_resistance, so calc reads
  // calcParams and NOTHING from extendData. Worth pinning rather than assuming:
  // SR_LEVELS' calc does pass its extendData into compute, so the pattern next
  // door is exactly the one that would break this.
  it("emits identical values under every extend mode", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 80, 100.5);
    const params = [2, 0.25, 0.75, 2, 5, 250, 30, 3];
    const run = (extend?: string): TrendlinesCalcPoint[] =>
      TRENDLINES_TEMPLATE.calc!(bars, {
        calcParams: params,
        extendData: { extend },
      } as never) as TrendlinesCalcPoint[];
    const ray = run("ray");
    // Non-triviality: an all-empty series would compare equal while proving
    // nothing.
    expect(
      ray.filter((p) => p.tl_support !== undefined).length,
    ).toBeGreaterThan(10);
    expect(run("segment")).toEqual(ray);
    expect(run("extended")).toEqual(ray);
    expect(run("apex")).toEqual(ray);
    expect(run("cross")).toEqual(ray);
    expect(run("lastbar")).toEqual(ray);
    expect(run(undefined)).toEqual(ray);
  });
});

// The draw callback against a recording stub: no canvas, no chart instance,
// just the geometry it hands to ctx. What this cannot check is appearance
// (colours, dash pattern, label placement) — only that the right segments, in
// the right count, reach the context.
interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dashed: boolean;
  /** The opacity the stroke was painted at: full for a live line, the dim
   * alpha for a stale or well-touched one, and the broken fade under a break. */
  alpha: number;
}

/** A recorded fillText call: the ×N tag and where it landed. */
interface Tag {
  text: string;
  x: number;
  y: number;
}

/** A recorded arc call: the dot marking where a line was broken. */
interface Mark {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

interface Painted {
  segments: Segment[];
  tags: Tag[];
  marks: Mark[];
  touchMarks: Mark[];
  /** Handle strokes (chevron arms, or the pinned end bar). */
  handleStrokes: Segment[];
}

interface View {
  width: number; // pane width INCLUDING the y-axis strip
  height: number;
  axis: number; // y-axis strip width
  toX: (barIdx: number) => number;
  toY: (price: number) => number;
}

/** The identity viewport: x pixel = bar index, y pixel = 1000 - price * 10, so
 * a recorded segment reads back as (barIndex, price) directly. Nothing is
 * clamped here, which is exactly why the tag tests below do NOT use it. */
const IDENTITY_VIEW: View = {
  width: 1000,
  height: 400,
  axis: 60,
  toX: (i) => i,
  toY: (p) => 1000 - p * 10,
};

/** A viewport shaped like the real pane: the last 120 bars across an 840px plot
 * area beside a 60px y-axis strip, y auto-scaled to the visible candles. Under
 * this mapping every line's projection horizon (lastTouchIdx + maxProjBars)
 * lands far to the right of the pane, so the tag's x-clamp actually engages —
 * which, on a live chart, it ALWAYS does. */
function paneView(bars: KLineData[], visible = 120): View {
  const width = 900;
  const height = 400;
  const axis = 60;
  const first = bars.length - visible;
  const px = (width - axis) / visible;
  const shown = bars.slice(Math.max(0, first));
  const lo = Math.min(...shown.map((b) => b.low));
  const hi = Math.max(...shown.map((b) => b.high));
  return {
    width,
    height,
    axis,
    toX: (i) => (i - first) * px,
    toY: (p) => ((hi - p) / (hi - lo)) * height,
  };
}

/** The chart stub the most recent record() drew with: the handle registry is
 * keyed by chart identity, so reading it back needs the same object. */
let lastChart: object = {};

function record(
  bars: KLineData[],
  calcParams: number[],
  extend?: string,
  view: View = IDENTITY_VIEW,
  pinned?: string[],
  // OFF by default here, unlike the app: nearly every draw test below counts
  // segments, and merging would quietly change those counts into assertions
  // about the dedup pass instead of about what they were written to check.
  // "default" omits the key entirely, which is the only way to exercise the
  // draw path's own fallback.
  dedupe: boolean | "default" = false,
  // OFF here, unlike the app, for the same reason dedupe is: the tests below
  // count segments, and a distance cut would turn those counts into assertions
  // about the near-price filter. "default" omits the key, which is the only way
  // to exercise the draw path's own fallback.
  nearPrice: boolean | "default" = false,
  // Matches the app's own default, so an omitted argument and an omitted key
  // mean the same thing and there is no third state to test.
  hideBroken = false,
  // The Declutter select. Absent leaves the key off entirely, which is how the
  // tests above exercise the legacy `nearPrice` fallback the draw path keeps.
  declutter?: "off" | "near" | "pivot",
  // The two dim thresholds. Absent leaves both keys off, so every test above
  // paints at the alphas it always did.
  dim?: {
    dimTouches?: number;
    dimStaleBars?: number;
    dimBroken?: boolean;
    dimOpacity?: number;
  },
  // OFF by default here, ON in the app — the same deal dedupe and nearPrice
  // have, and for the same reason: the carets are strokes, so with them on
  // every segment count below would be counting pivots as well as lines.
  // "default" omits the key, which is how the test for the default-on
  // behaviour exercises the draw path's own fallback.
  showPivots: boolean | "default" = false,
  // The line-pivot marks (showLinePivots). OFF by default here AND in the app,
  // so "default" and false coincide; the key is still omitted on "default" so
  // the draw path's own fallback is what the default test exercises.
  showLinePivots: boolean | "default" = false,
): Painted {
  const segments: Segment[] = [];
  const tags: Tag[] = [];
  // Break dots are recorded APART from segments: several tests assert exact
  // segment counts, and a marker landing in that array would break them.
  const marks: Mark[] = [];
  // Touch rings, apart from break dots for the same reason: the tests that
  // count break marks would otherwise be counting touches too. The RADIUS is
  // the discriminator, and like the handle's heavier stroke it is a real
  // visual difference, not a test-only flag.
  const touchMarks: Mark[] = [];
  // Same reason for the handle glyphs, which are strokes rather than arcs now.
  // lineWidth is the discriminator, and it is not a test-only flag: the handle
  // really is drawn heavier than the line it caps.
  const handleStrokes: Segment[] = [];
  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let dashed = false;
  const ctx = {
    font: "",
    textBaseline: "",
    textAlign: "",
    strokeStyle: "",
    fillStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    stroke: () => {},
    setLineDash: (d: number[]) => {
      dashed = d.length > 0;
    },
    moveTo: (x: number, y: number) => {
      cur = { x, y };
      start = { x, y };
    },
    lineTo: (x: number, y: number) => {
      const seg = { x0: cur.x, y0: cur.y, x1: x, y1: y, dashed, alpha: ctx.globalAlpha };
      if (ctx.lineWidth === TL_HANDLE_STROKE) handleStrokes.push(seg);
      else segments.push(seg);
      cur = { x, y };
    },
    // The pivot marks are FILLED triangles, so their closing edge exists only
    // as a closePath. Recorded like any other edge, or a caret would read as
    // two edges here and three on the canvas.
    closePath: () => {
      const seg = { x0: cur.x, y0: cur.y, x1: start.x, y1: start.y, dashed, alpha: ctx.globalAlpha };
      if (ctx.lineWidth === TL_HANDLE_STROKE) handleStrokes.push(seg);
      else segments.push(seg);
      cur = { ...start };
    },
    rect: () => {},
    clip: () => {},
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (text: string, x: number, y: number) => {
      tags.push({ text, x, y });
    },
    arc: (x: number, y: number, r: number) => {
      const m = { x, y, r, alpha: ctx.globalAlpha };
      if (r === TL_TOUCH_RADIUS) touchMarks.push(m);
      else marks.push(m);
    },
    fill: () => {},
  };
  // One object per record() call, and the handle registry is keyed on it, so
  // these tests exercise the same per-chart isolation the app relies on.
  const chartStub = {
    getDataList: () => bars,
    getSize: () => ({ width: view.axis }),
  };
  lastChart = chartStub;
  const ext = {
    extend,
    pinned,
    ...(dedupe === "default" ? {} : { dedupe }),
    ...(nearPrice === "default" ? {} : { nearPrice }),
    ...(declutter ? { declutter } : {}),
    ...(dim ?? {}),
    ...(showPivots === "default" ? {} : { showPivots }),
    ...(showLinePivots === "default" ? {} : { showLinePivots }),
    hideBroken,
  };
  const result = TRENDLINES_TEMPLATE.calc!(bars, {
    calcParams,
    extendData: ext,
  } as never);
  const drew = TRENDLINES_TEMPLATE.draw!({
    ctx,
    chart: chartStub,
    indicator: {
      result,
      calcParams,
      extendData: ext,
      paneId: "candle_pane",
      name: "TRENDLINES",
    },
    bounding: { width: view.width, height: view.height },
    xAxis: { convertToPixel: (i: number) => view.toX(i) },
    yAxis: { convertToPixel: (p: number) => view.toY(p) },
  } as never);
  // isCover: klinecharts must skip its own figure loop, or the empty `figures`
  // list is not the whole story.
  expect(drew).toBe(true);
  return { segments, tags, marks, touchMarks, handleStrokes };
}

describe("TRENDLINES_TEMPLATE.draw", () => {
  const bars = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };
  const params = (maxLines: number): number[] => [
    2,
    0.25,
    0.75,
    2,
    5,
    250,
    30,
    maxLines,
  ];

  // ONE GATE FOR BOTH SURFACES. A setting that means "real trendline" to a rule
  // and nothing to the chart is a setting the user cannot trust: measured on a
  // live US100 daily pane at Min Touches 7, all 15 drawn lines were under it
  // (the best had 3) and 0 qualified.
  it("draws only what an operand could read", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 92, 100.5);
    b[60] = bar(60, 94, 100.5);
    const withFloor = (minTouches: number, minSpanBars: number): number[] => [
      2, 0.25, 0.75, minTouches, minSpanBars, 250, 30, 5,
    ];
    // The 20->40->60 line collects three touches over a 40-bar span.
    expect(record(b, withFloor(3, 5)).segments.length).toBeGreaterThan(0);
    // One touch more than any line here has, and one bar more than the longest
    // span: each floor alone empties the pane.
    expect(record(b, withFloor(4, 5)).segments).toHaveLength(0);
    expect(record(b, withFloor(2, 41)).segments).toHaveLength(0);
  });

  // The ceilings thin the CHART, not only the operand path. Both tips call the
  // lines they reject noise, so leaving them painted reads as the setting
  // doing nothing. The FLOORS deliberately still draw: a line under Min Touches
  // or Min Span is geometry in play, and showing it is the pane's job.
  it("stops drawing a line past Max Span", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[60] = bar(60, 94, 100.5);
    const withCeiling = (maxSpanBars: number): number[] => [
      2, 0.25, 0.75, 2, 5, 250, 30, 5, 0, 0, 20, 0, maxSpanBars,
    ];
    const wide = record(b, withCeiling(0)).segments.length;
    expect(wide).toBeGreaterThan(0);
    // 39 is one bar under the 20->60 span, the same boundary the emit-path
    // test above uses.
    expect(record(b, withCeiling(39)).segments).toHaveLength(0);
    expect(record(b, withCeiling(40)).segments).toHaveLength(wide);
  });

  it("fades a well-touched line, RINGS AND ALL, and only when asked", () => {
    const b = bars();
    // Min Touches is 2, so every line the fixture yields meets a threshold of
    // 2: the assertion is about the whole drawn set, not about one line.
    const live = record(b, params(1), "lastbar");
    const solid = live.segments.filter((sg) => !sg.dashed);
    expect(solid.length, "fixture must draw an unbroken line").toBeGreaterThan(0);
    expect(solid.every((sg) => sg.alpha === 1)).toBe(true);

    const dimmed = record(b, params(1), "lastbar", undefined, undefined, false, false, false, undefined, {
      dimTouches: 2,
    });
    const dimSolid = dimmed.segments.filter((sg) => !sg.dashed);
    expect(dimSolid.length).toBe(solid.length);
    expect(dimSolid.every((sg) => sg.alpha === TL_DIM_ALPHA)).toBe(true);
    // THE RINGS TOO. The alpha is restored at three sites in the draw loop
    // (after the break dot, after the pin handle), and a stroke that fades
    // while its touch rings stay opaque is the failure this pins: it looks
    // right on the line and wrong everywhere else.
    // Every drawn line here meets the threshold, broken ones included (the
    // broken fade is off, so they take the dim depth too), so no ring is left
    // opaque.
    expect(dimmed.touchMarks.length).toBeGreaterThan(0);
    expect(dimmed.touchMarks.every((m) => m.alpha === TL_DIM_ALPHA)).toBe(true);
  });

  it("dashes a broken line WITHOUT fading it unless asked", () => {
    const b = bars();
    const dashedAt = (dim?: {
      dimTouches?: number;
      dimBroken?: boolean;
    }) =>
      record(b, params(1), "lastbar", undefined, undefined, false, false, false, undefined, dim)
        .segments.filter((sg) => sg.dashed)
        .map((sg) => sg.alpha);
    const opaque = dashedAt();
    expect(opaque.length, "fixture must draw a broken line").toBeGreaterThan(0);
    // The dashes and the break dot carry the message on their own; a broken
    // line is where a retest happens, so nothing pushes it back by default.
    expect(opaque.every((a) => a === 1)).toBe(true);
    expect(dashedAt({ dimBroken: true }).every((a) => a === TL_DIM_ALPHA)).toBe(true);
  });

  it("paints EVERY dim at one depth, whatever put the line into it", () => {
    const b = bars();
    const dashedAt = (dim: Record<string, unknown>) =>
      record(b, params(1), "lastbar", undefined, undefined, false, false, false, undefined, dim)
        .segments.filter((sg) => sg.dashed)
        .map((sg) => sg.alpha);
    // Broken, well-touched, or both: one depth, and the dashes are what say
    // which kind of dim this is.
    expect(dashedAt({ dimBroken: true, dimTouches: 2 }).every((a) => a === TL_DIM_ALPHA)).toBe(true);
    // With the broken fade off, a broken line still picks up the dim depth —
    // being broken is not a reason to paint a stale line brighter.
    expect(dashedAt({ dimTouches: 2 }).every((a) => a === TL_DIM_ALPHA)).toBe(true);
  });

  it("paints the dim at the pane's own opacity, clamped", () => {
    const b = bars();
    const solidAt = (dim: Record<string, unknown>) =>
      record(b, params(1), "lastbar", undefined, undefined, false, false, false, undefined, dim)
        .segments.filter((sg) => !sg.dashed)
        .map((sg) => sg.alpha);
    expect(solidAt({ dimTouches: 2, dimOpacity: 25 }).every((a) => a === 0.25)).toBe(true);
    // Floored: a fade that reached invisible would hide a line with no row
    // saying so.
    expect(solidAt({ dimTouches: 2, dimOpacity: 0 }).every((a) => a === 0.1)).toBe(true);
    // An opacity alone dims nothing — it is a depth, not a switch.
    expect(solidAt({ dimOpacity: 25 }).every((a) => a === 1)).toBe(true);
  });

  it("rings every touch, on the line and not at the candle's own extreme", () => {
    const b = bars();
    const { lines } = computeTrendlines(b, cfg());
    const line = lines.find((l) => l.touches > 2);
    expect(line, "fixture must produce a multi-touch line").toBeDefined();
    const { touchMarks } = record(b, params(1), "lastbar");
    // maxLines 1 plus the operands' lines, so more than one line can draw;
    // what must hold is that each drawn line contributed one ring per touch.
    expect(touchMarks.length).toBeGreaterThanOrEqual(line!.touches);
    for (const idx of line!.touchIdxs) {
      const at = touchMarks.filter((m) => m.x === idx);
      expect(at.length, `no ring at touch bar ${idx}`).toBeGreaterThan(0);
      // ON THE LINE: the y is the line's own projection, not bars[idx].low,
      // which sits up to a touch tolerance away.
      expect(
        at.some((m) => Math.abs(m.y - IDENTITY_VIEW.toY(projectAt(line!, idx))) < 1e-6),
      ).toBe(true);
    }
  });

  // The DRAW PATH's own default, which is what makes the filter reach a user:
  // selectDrawnLines takes the tolerance as an argument and defaults it to OFF,
  // so an untouched chart getting the filter is a fact about this path alone.
  // What the cut does with the lines it is given is covered precisely by the
  // selectDrawnLines tests above; this one is about the default.
  it("hides the far lines by default, and stops when switched off", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 91, 100.5);
    b[62] = bar(62, 99, 100.5);
    b[70] = bar(70, 99.2, 100.5);
    // Four support lines, projecting 7.05, 5.18, 1.66 and 0.58 from the close
    // against a 5-ATR tolerance of 5.42: the fixture straddles the cut rather
    // than sitting all on one side of it.
    const cp = params(8);
    const off = record(b, cp, undefined, undefined, undefined, false, false);
    expect(off.segments).toHaveLength(4);
    // A segment starts at its line's first anchor, so bar 20 identifies the
    // far one, and it is the one that goes.
    expect(off.segments.some((s) => s.x0 === 20)).toBe(true);
    const on = record(b, cp, undefined, undefined, undefined, false, true);
    expect(on.segments).toHaveLength(3);
    expect(on.segments.some((s) => s.x0 === 20)).toBe(false);
    // With the key absent, which is what an untouched chart sends, the filter
    // is ON. That fallback lives in the draw path and nowhere else.
    const fallback = record(
      b,
      cp,
      undefined,
      undefined,
      undefined,
      false,
      "default",
    );
    expect(fallback.segments).toHaveLength(on.segments.length);
  });

  it("merges a fan on the draw path, and does it by default", () => {
    const b = bars();
    const live = computeTrendlines(b, cfg()).lines;
    // Bars 20/40/60 are all pivot lows, so bar 20 anchors a fan: this fixture
    // is exactly the shape the dedup pass exists for.
    const all = record(
      b,
      params(live.length),
      undefined,
      undefined,
      undefined,
      false,
    );
    const merged = record(
      b,
      params(live.length),
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(all.segments.length).toBeGreaterThan(merged.segments.length);
    // With the key absent, which is what an untouched chart sends, merging is
    // on. That fallback lives in the draw path and nowhere else.
    const fallback = record(
      b,
      params(live.length),
      undefined,
      undefined,
      undefined,
      "default",
    );
    expect(fallback.segments).toHaveLength(merged.segments.length);
  });

  it("collapses a fan to one line per pivot, with merging switched off", () => {
    // Bar 20 anchors the fan. dedupe is FALSE in both runs, so the collapse can
    // only come from the Declutter choice: picking it is the explicit
    // instruction that ticking Merge similar lines only implies.
    const b = bars();
    const live = computeTrendlines(b, cfg()).lines;
    const cp = params(live.length);
    const off = record(b, cp, undefined, undefined, undefined, false, false, false, "off");
    const perPivot = record(b, cp, undefined, undefined, undefined, false, false, false, "pivot");
    expect(perPivot.segments.length).toBeLessThan(off.segments.length);
  });

  it("reads Declutter over the legacy near-price key", () => {
    // The straddling fixture the near-price default test uses: four support
    // lines, one of them outside the 5-ATR cut (the one anchored at bar 20).
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 91, 100.5);
    b[62] = bar(62, 99, 100.5);
    b[70] = bar(70, 99.2, 100.5);
    const cp = params(8);
    // Legacy key alone: the cut runs, as it always did.
    expect(record(b, cp, undefined, undefined, undefined, false, true).segments)
      .toHaveLength(3);
    // Select present: it decides, and the stale checkbox underneath it does
    // not. Both rules cannot run at once, so "off" means off.
    expect(
      record(b, cp, undefined, undefined, undefined, false, true, false, "off").segments,
    ).toHaveLength(4);
    expect(
      record(b, cp, undefined, undefined, undefined, false, false, false, "near").segments,
    ).toHaveLength(3);
  });

  // maxLines is the drawn set's FLOOR, not a hard cap: the budgeted lines are
  // chosen by proximity and then whatever an operand is reading joins them.
  // This fixture shows both halves, because at maxLines 1 the budget spends
  // its one slot on the live line tl_support reads (the nearest, at 98.85)
  // and so would hide the BROKEN line tl_broken_support reads (101.8).
  it("budgets the drawn set at maxLines, then adds the operands' lines", () => {
    const b = bars();
    const live = computeTrendlines(b, cfg()).lines;
    // Only support lines form on flat highs, so one side carries this fixture.
    expect(live.filter((l) => l.side === "support")).toHaveLength(live.length);
    expect(live.length).toBeGreaterThan(1);
    // Uncapped: maxLines above the live count draws everything.
    expect(record(b, params(live.length)).segments).toHaveLength(live.length);
    // Budgeted: maxLines 1 picks ONE by proximity. The live set itself is
    // unchanged (its cap is MAX_LIVE_MULT x maxLines = 4, still above this
    // fixture's count), so this really is the drawing budget and not the
    // detector's.
    const one = computeTrendlines(b, cfg({ maxLines: 1 }));
    expect(one.lines).toHaveLength(live.length);
    const lastIdx = b.length - 1;
    const close = b[lastIdx].close;
    const point = one.points[lastIdx];
    expect(
      selectDrawnLines(one.lines, lastIdx, close, 1, {}, null),
    ).toHaveLength(1);
    // That one budgeted slot goes to tl_support's line, so asserting on
    // tl_support here would pass with the union removed. tl_broken_support is
    // the operand the budget really would have hidden: it joins only through
    // the union, so it is the assertion that can fail.
    expect(point.tl_broken_support).toBeDefined();
    const budgeted = selectDrawnLines(one.lines, lastIdx, close, 1, {}, null);
    expect(
      budgeted.some((l) => projectAt(l, lastIdx) === point.tl_broken_support),
    ).toBe(false);
    const drawn = selectDrawnLines(one.lines, lastIdx, close, 1, point, null);
    expect(drawn).toHaveLength(2);
    expect(
      drawn.some((l) => projectAt(l, lastIdx) === point.tl_broken_support),
    ).toBe(true);
    expect(record(b, params(1)).segments).toHaveLength(2);
  });

  it("draws each line from its first anchor to its projection horizon", () => {
    const b = bars();
    const seg = record(b, params(1)).segments[0];
    const res = computeTrendlines(b, cfg());
    const drawn = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      1,
      res.points[b.length - 1],
      null,
    )[0];
    expect(seg.x0).toBe(drawn.i1);
    expect(seg.x1).toBe(drawn.lastTouchIdx + 250);
    expect(seg.y0).toBeCloseTo(1000 - projectAt(drawn, drawn.i1) * 10, 6);
    expect(seg.y1).toBeCloseTo(1000 - projectAt(drawn, seg.x1) * 10, 6);
  });

  it("changes only the endpoints across extend modes, never the drawn set", () => {
    const b = bars();
    const ray = record(b, params(3)).segments;
    const segment = record(b, params(3), "segment").segments;
    const extended = record(b, params(3), "extended").segments;
    expect(segment).toHaveLength(ray.length);
    expect(extended).toHaveLength(ray.length);
    // Segment stops at the line's own end, which for a BROKEN line is its
    // break rather than its last touch: the two differ here, so this cannot be
    // written as a flat r.x1 - 250.
    const res = computeTrendlines(b, cfg());
    const drawnLines = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      3,
      res.points[b.length - 1],
      null,
    );
    expect(drawnLines.some((l) => l.brokenIdx !== null)).toBe(true);
    ray.forEach((r, i) => {
      const l = drawnLines[i];
      const end =
        l.brokenIdx !== null
          ? Math.max(l.lastTouchIdx, l.brokenIdx)
          : l.lastTouchIdx;
      // Same left anchor as the ray, stopping at that end instead of the horizon.
      expect(segment[i].x0).toBe(r.x0);
      expect(segment[i].x1).toBe(end);
      // Extended reaches maxProjBars back before the first anchor.
      expect(extended[i].x0).toBe(r.x0 - 250);
      expect(extended[i].x1).toBe(r.x1);
    });
  });

  it("dashes a broken line and leaves an unbroken one solid", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 94, 100.5);
    b[60] = bar(60, 80, 100.5); // pierces the 20->40 support
    const segs = record(b, params(3)).segments;
    expect(segs.some((s) => s.dashed)).toBe(true);
    expect(segs.some((s) => !s.dashed)).toBe(true);
  });

  it("hides the broken lines when asked, and shows them by default", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 94, 100.5);
    b[60] = bar(60, 80, 100.5); // pierces the 20->40 support
    const shown = record(b, params(3)).segments;
    expect(shown.some((s) => s.dashed)).toBe(true);
    const hidden = record(
      b,
      params(3),
      undefined,
      undefined,
      undefined,
      false,
      false,
      true,
    ).segments;
    expect(hidden.some((s) => s.dashed)).toBe(false);
    // The unbroken ones are untouched, so this is a filter and not an off
    // switch for the whole overlay.
    expect(hidden.length).toBe(shown.filter((s) => !s.dashed).length);
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("paints nothing when there are no lines", () => {
    expect(record(flat(30), params(3))).toEqual({
      segments: [],
      tags: [],
      marks: [],
      touchMarks: [],
      handleStrokes: [],
    });
  });

  // THE TAG MUST SIT ON ITS LINE. The x is clamped inside the pane, and on a
  // live chart that clamp ALWAYS engages: for any live line
  // lastTouchIdx + maxProjBars >= lastIdx, so the segment's right end is always
  // past the right edge. Pinning the tag's y to the line's price AT that far
  // right end (which SR_LEVELS can do, its levels being horizontal) throws the
  // tag hundreds of pixels off a sloped line and usually off the pane
  // altogether. So y is interpolated at the clamped x.
  //
  // This runs under paneView, NOT the identity viewport: with x pixel = bar
  // index nothing ever clamps, and the assertion would hold for the broken
  // version too.
  it("puts the ×N tag on the line it labels, inside the pane", () => {
    // Shallow dips, unlike the fixture the other draw tests use: a steep line
    // legitimately runs off the top of the pane before the right edge, and its
    // tag correctly follows it off, so the on-pane half of this assertion would
    // be wrong rather than discriminating. The on-segment half holds either way.
    const b = flat(80);
    b[20] = bar(20, 95, 100.5);
    b[45] = bar(45, 96, 100.5);
    b[70] = bar(70, 97, 100.5);
    const view = paneView(b);
    const { segments, tags } = record(b, params(3), undefined, view);
    expect(segments.length).toBeGreaterThan(1);
    expect(tags).toHaveLength(segments.length);
    const tagRight = view.width - view.axis - 4;
    segments.forEach((s, i) => {
      const tag = tags[i];
      // Guard: if the clamp is not engaging, this fixture proves nothing.
      expect(s.x1).toBeGreaterThan(view.width);
      expect(tag.x).toBeLessThanOrEqual(tagRight);
      expect(tag.x).toBeGreaterThan(0);
      // ON the segment, to within a pixel.
      const onLine = s.y0 + ((s.y1 - s.y0) * (tag.x - s.x0)) / (s.x1 - s.x0);
      expect(Math.abs(tag.y - onLine)).toBeLessThan(1);
      // And on the pane, which is the visible symptom the interpolation fixes.
      expect(tag.y).toBeGreaterThan(0);
      expect(tag.y).toBeLessThan(view.height);
      // Pinning to the far-right end (the bug) would be far away: assert the
      // fixture really does discriminate rather than trusting it to.
      expect(Math.abs(s.y1 - onLine)).toBeGreaterThan(50);
    });
    // Each tag names its own line's touch count, in draw order.
    const res = computeTrendlines(b, cfg());
    const drawn = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      3,
      res.points[b.length - 1],
      null,
    );
    expect(tags.map((t) => t.text)).toEqual(drawn.map((l) => `×${l.touches}`));
  });
});

describe("TRENDLINES_TEMPLATE.draw break marker and meeting modes", () => {
  const params = (maxLines: number): number[] => [
    2,
    0.25,
    0.75,
    2,
    5,
    250,
    30,
    maxLines,
  ];

  /** Rising lows and falling highs: one support, one resistance, converging.
   * Support runs 90@20 -> 94@50 (slope 4/30), resistance 110@30 -> 106@60
   * (slope -4/30), so they meet at bar 100 exactly. */
  const wedge = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[50] = bar(50, 94, 100.5);
    out[30] = bar(30, 99.5, 110);
    out[60] = bar(60, 99.5, 106);
    return out;
  };

  /** The support-only fixture: three rising lows, one of which breaks. */
  const dips = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };

  it("puts a dot where the line broke, and only on broken lines", () => {
    const b = dips();
    const { marks, segments } = record(b, params(3));
    const broken = computeTrendlines(b, cfg()).lines.filter(
      (l) => l.brokenIdx !== null,
    );
    expect(broken).toHaveLength(1);
    expect(marks).toHaveLength(1);
    // Non-triviality: more lines are drawn than are broken, so a marker per
    // line would also produce "some" marks.
    expect(segments.length).toBeGreaterThan(marks.length);
    const idx = broken[0].brokenIdx as number;
    expect(marks[0].x).toBe(idx);
    expect(marks[0].y).toBeCloseTo(1000 - projectAt(broken[0], idx) * 10, 6);
    // Full opacity: the line around it is faded to 0.45, and the dot is the
    // part worth seeing.
    expect(marks[0].alpha).toBe(1);
  });

  it("draws a broken line as far as its break, even stopping at the last touch", () => {
    const b = dips();
    const broken = computeTrendlines(b, cfg()).lines.find(
      (l) => l.brokenIdx !== null,
    );
    expect(broken).toBeDefined();
    const line = broken as TrendLine;
    // The premise: the break lands AFTER the last touch, so ending at the last
    // touch would stop short of it.
    expect(line.brokenIdx as number).toBeGreaterThan(line.lastTouchIdx);
    const dashed = record(b, params(3), "segment").segments.filter(
      (s) => s.dashed,
    );
    expect(dashed).toHaveLength(1);
    expect(dashed[0].x1).toBe(line.brokenIdx);
  });

  it("apex stops both sides of a wedge where they meet", () => {
    const b = wedge();
    const lines = computeTrendlines(b, cfg()).lines;
    // The fixture must really carry both sides, or "opposite side only" proves
    // nothing here.
    expect(new Set(lines.map((l) => l.side))).toEqual(
      new Set(["support", "resistance"]),
    );
    const apex = record(b, params(3), "apex").segments;
    const ray = record(b, params(3), "ray").segments;
    expect(apex).toHaveLength(2);
    for (const seg of apex) expect(seg.x1).toBeCloseTo(100, 6);
    // ...and that is genuinely shorter than the ray horizon it replaced.
    for (const seg of ray) expect(seg.x1).toBeGreaterThan(200);
  });

  it("cross also stops at an opposite line when that is the nearest one", () => {
    const b = wedge();
    const cross = record(b, params(3), "cross").segments;
    for (const seg of cross) expect(seg.x1).toBeCloseTo(100, 6);
  });

  it("ends every line at the newest bar in lastbar mode", () => {
    const b = dips();
    const lastIdx = b.length - 1;
    const segs = record(b, params(3), "lastbar").segments;
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) expect(seg.x1).toBe(lastIdx);
    // Distinct from segment mode, which stops at each line's own end well
    // before the newest bar.
    const seg = record(b, params(3), "segment").segments;
    expect(seg.some((s) => s.x1 < lastIdx)).toBe(true);
  });

  it("stops an unmet line at the newest bar, not the projection horizon", () => {
    // Same-side lines only, and every crossing among them sits at or behind the
    // anchors, so no forward meeting exists on either mode.
    const b = dips();
    const lastIdx = b.length - 1;
    const ray = record(b, params(3), "ray").segments;
    // The ray horizon really is far past the newest bar, or this proves nothing.
    for (const seg of ray) expect(seg.x1).toBeGreaterThan(lastIdx + 200);
    for (const mode of ["apex", "cross"]) {
      const segs = record(b, params(3), mode).segments;
      expect(segs).toHaveLength(ray.length);
      for (const seg of segs) expect(seg.x1).toBe(lastIdx);
    }
  });
});

describe("lineKey", () => {
  const bars = flat(50);
  it("identifies a line by its anchors' TIMESTAMPS, not their indices", () => {
    const line: TrendLine = { ...sup, i1: 10, i2: 30 };
    expect(lineKey(line, bars)).toBe(
      `support:${bars[10].timestamp}:${bars[30].timestamp}`,
    );
    // The same line after 5 older bars load: indices shift by 5, the key does not.
    const shifted = [...flat(5, -5), ...bars];
    const moved: TrendLine = { ...line, i1: 15, i2: 35 };
    expect(lineKey(moved, shifted)).toBe(lineKey(line, bars));
  });

  it("separates the two sides at identical anchors", () => {
    const s1: TrendLine = { ...sup, i1: 10, i2: 30 };
    const r1: TrendLine = { ...res, i1: 10, i2: 30 };
    expect(lineKey(s1, bars)).not.toBe(lineKey(r1, bars));
  });
});

describe("lineExtent", () => {
  const line: TrendLine = {
    ...sup,
    i1: 0,
    i2: 10,
    lastTouchIdx: 10,
    brokenIdx: null,
  };
  const c = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig =>
    cfg(over);

  it("lets a pin outrun whatever the mode says", () => {
    for (const mode of [
      "ray",
      "segment",
      "extended",
      "lastbar",
      "apex",
      "cross",
    ] as const) {
      expect(lineExtent(line, mode, c(), [line], 40, 500).jRight).toBe(500);
    }
  });

  it("never pulls a line back behind its own end when pinned", () => {
    // A pin edge BEHIND the line's last touch must not shorten it.
    expect(lineExtent(line, "ray", c(), [line], 40, 5).jRight).toBe(10);
  });

  it("keeps the left edge under the mode even when pinned", () => {
    expect(lineExtent(line, "extended", c(), [line], 40, 500).jLeft).toBe(
      0 - 250,
    );
    expect(lineExtent(line, "ray", c(), [line], 40, 500).jLeft).toBe(0);
  });
});

describe("lineExtent with mixed touches", () => {
  const line: TrendLine = {
    side: "support", i1: 100, p1: 50, i2: 140, p2: 60,
    touches: 3, touchIdxs: [80, 100, 140], lastTouchIdx: 140,
    firstTouchIdx: 80, brokenIdx: null,
    // 80 -> 100 -> 140 in bar order: the widest gap is the last leg.
    maxTouchGap: 40, minTouchGap: 20, maxTouchIdx: 140,
  };
  it("stopping modes start at firstTouchIdx, extended runs maxProjBars before it", () => {
    const cfg = { ...TRENDLINES_DEFAULTS, mixedTouches: 1 };
    expect(lineExtent(line, "lastbar", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "segment", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "ray", cfg, [], 200, null).jLeft).toBe(80);
    expect(lineExtent(line, "extended", cfg, [], 200, null).jLeft).toBe(80 - cfg.maxProjBars);
  });
  it("a line with no early touch is unchanged: firstTouchIdx === i1", () => {
    const plain = { ...line, firstTouchIdx: 100, touchIdxs: [100, 140], touches: 2 };
    expect(lineExtent(plain, "lastbar", TRENDLINES_DEFAULTS, [], 200, null).jLeft).toBe(100);
  });
});

describe("hitHandle", () => {
  const handles = [
    { key: "a", x: 100, y: 100 },
    { key: "b", x: 110, y: 100 },
  ];

  it("misses beyond the grab radius and hits inside it", () => {
    expect(hitHandle(handles, 100, 100 + TL_HANDLE_HIT + 1)).toBeNull();
    expect(hitHandle(handles, 100, 100 + TL_HANDLE_HIT - 1)).toBe("a");
  });

  it("takes the nearest when two overlap", () => {
    expect(hitHandle(handles, 104, 100)).toBe("a");
    expect(hitHandle(handles, 107, 100)).toBe("b");
  });

  it("returns null with no handles", () => {
    expect(hitHandle([], 100, 100)).toBeNull();
  });
});

describe("TRENDLINES draw handles", () => {
  const params = (maxLines: number): number[] => [
    2,
    0.25,
    0.75,
    2,
    5,
    250,
    30,
    maxLines,
  ];
  const dips = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };

  it("puts a clickable handle on the right end of every drawn line", () => {
    // lastbar mode, so the ends land ON the pane. Under a ray the ends sit 250
    // bars out, where the identity view puts them far above the pane and the
    // bounds guard correctly drops their handles.
    const b = dips();
    const { segments } = record(b, params(3), "lastbar");
    const handles = getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES");
    // One per drawn line whose end is actually on the pane. Even at the newest
    // bar a steep line can project above the top, and that handle is dropped
    // rather than drawn into a neighbouring pane.
    const onPane = segments.filter(
      (s) => s.y1 >= 0 && s.y1 <= IDENTITY_VIEW.height,
    );
    expect(onPane.length).toBeGreaterThan(0);
    expect(handles).toHaveLength(onPane.length);
    // Each handle sits JUST PAST its segment's right end, along the segment's
    // own direction: the ring is tangent to the tip rather than centred on it,
    // and the hit test has to follow the ring or a click lands off the dot.
    const OUT = TL_HANDLE_RADIUS + 0.5;
    for (const seg of onPane) {
      const len = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
      const ex = seg.x1 + ((seg.x1 - seg.x0) * OUT) / len;
      const ey = seg.y1 + ((seg.y1 - seg.y0) * OUT) / len;
      expect(
        handles.some(
          (h) => Math.abs(h.x - ex) < 1e-6 && Math.abs(h.y - ey) < 1e-6,
        ),
      ).toBe(true);
    }
  });

  it("anchors every handle at the newest bar, whatever the mode", () => {
    // The natural end moves with the mode (last touch in segment, an apex),
    // but the handle must not: it sits on the line's projection at the newest
    // bar, one column beside price. In segment mode that is PAST the drawn
    // stroke, on the line's invisible extension.
    const b = dips();
    const lastIdx = b.length - 1;
    const OUT = TL_HANDLE_RADIUS + 0.5;
    for (const mode of ["segment", "lastbar", "apex", "cross"] as const) {
      const { segments } = record(b, params(3), mode);
      const handles = getTrendlineHandles(
        lastChart,
        "candle_pane",
        "TRENDLINES",
      );
      expect(handles.length).toBeGreaterThan(0);
      for (const h of handles) {
        // At the newest bar, pushed out at most one ring past it along the
        // line's own direction.
        expect(h.x).toBeGreaterThanOrEqual(lastIdx);
        expect(h.x).toBeLessThanOrEqual(lastIdx + OUT);
        // On its line's projection: collinear with one drawn segment.
        expect(
          segments.some((s) => {
            const slope = (s.y1 - s.y0) / (s.x1 - s.x0);
            return Math.abs(h.y - (s.y0 + slope * (h.x - s.x0))) < 1e-6;
          }),
        ).toBe(true);
      }
    }
  });

  it("drops the handle when the newest bar is scrolled off the pane", () => {
    // ABSOLUTE anchoring: panning back through history takes the handle
    // off-screen with its bar. Clamping it to the pane edge instead is exactly
    // what the anchor exists to prevent — a handle that moves to stay in view.
    const b = dips();
    // The identity view, cut down so the newest bar (79) sits past the plot
    // area's right edge (width 50, axis 10): lines still draw, handles do not.
    const scrolledBack: typeof IDENTITY_VIEW = { ...IDENTITY_VIEW, width: 50, axis: 10 };
    const { segments } = record(b, params(3), "lastbar", scrolledBack);
    expect(segments.length).toBeGreaterThan(0);
    expect(
      getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES"),
    ).toHaveLength(0);
  });

  it("offers no handle in the modes that already run right", () => {
    // A pin means "run past where you stopped". Ray and Extended never stop, so
    // there is nothing to pin, and their end sits maxProjBars into the future
    // where a handle would be off the pane and unclickable anyway.
    const b = dips();
    for (const mode of ["ray", "extended"] as const) {
      const { segments } = record(b, params(3), mode);
      expect(segments.length).toBeGreaterThan(0);
      expect(
        getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES"),
      ).toHaveLength(0);
    }
  });

  it("ignores a stored pin in those modes rather than extending with no undo", () => {
    const b = dips();
    const res = computeTrendlines(b, cfg());
    const drawn = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      3,
      res.points[b.length - 1],
      null,
    );
    const key = lineKey(drawn[0], b);
    const free = record(b, params(3), "ray").segments;
    const held = record(b, params(3), "ray", IDENTITY_VIEW, [key]).segments;
    expect(held).toEqual(free);
  });

  it("clears the handles when nothing is drawn", () => {
    record(dips(), params(3), "lastbar");
    expect(
      getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES").length,
    ).toBeGreaterThan(0);
    // A flat corridor forms no lines at all.
    record(flat(30), params(3));
    expect(
      getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES"),
    ).toHaveLength(0);
  });
});

describe("TRENDLINES pinning", () => {
  const params = (maxLines: number): number[] => [
    2,
    0.25,
    0.75,
    2,
    5,
    250,
    30,
    maxLines,
  ];
  const dips = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };

  /** The key of the drawn line whose end is on the pane in lastbar mode. */
  const firstDrawnKey = (b: KLineData[]): string => {
    const res = computeTrendlines(b, cfg());
    const drawn = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      3,
      res.points[b.length - 1],
      null,
    );
    return lineKey(drawn[0], b);
  };

  it("runs a pinned line past where its mode would have stopped", () => {
    const b = dips();
    const key = firstDrawnKey(b);
    const free = record(b, params(3), "lastbar").segments;
    const held = record(b, params(3), "lastbar", IDENTITY_VIEW, [key]).segments;
    expect(held).toHaveLength(free.length);
    // Exactly one line moved, and it moved to the RIGHT.
    const moved = held.filter((h, i) => h.x1 !== free[i].x1);
    expect(moved).toHaveLength(1);
    expect(moved[0].x1).toBeGreaterThan(free[held.indexOf(moved[0])].x1);
  });

  it("leaves the handle where it was so the same click undoes the pin", () => {
    // THE point of anchoring the handle to the newest bar: a handle that
    // travelled to the pane edge with the line would leave nothing to click.
    const b = dips();
    const key = firstDrawnKey(b);
    record(b, params(3), "lastbar");
    const free = getTrendlineHandles(
      lastChart,
      "candle_pane",
      "TRENDLINES",
    ).map((h) => ({ ...h }));
    record(b, params(3), "lastbar", IDENTITY_VIEW, [key]);
    const held = getTrendlineHandles(lastChart, "candle_pane", "TRENDLINES");
    expect(held).toHaveLength(free.length);
    for (let i = 0; i < free.length; i += 1) {
      expect(held[i].key).toBe(free[i].key);
      expect(held[i].x).toBeCloseTo(free[i].x, 9);
      expect(held[i].y).toBeCloseTo(free[i].y, 9);
    }
    // ...and the pinned line really is one of them, so this is not vacuous.
    expect(held.some((h) => h.key === key)).toBe(true);
  });

  it("ignores a pin key that matches no drawn line", () => {
    const b = dips();
    const free = record(b, params(3), "lastbar").segments;
    const held = record(b, params(3), "lastbar", IDENTITY_VIEW, [
      "support:1:2",
    ]).segments;
    expect(held).toEqual(free);
  });
});

describe("hitAnyTrendlineHandle", () => {
  const params = (maxLines: number): number[] => [
    2,
    0.25,
    0.75,
    2,
    5,
    250,
    30,
    maxLines,
  ];
  const dips = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };

  it("answers only for the chart that drew the handles", () => {
    record(dips(), params(3), "lastbar");
    const drew = lastChart;
    const h = getTrendlineHandles(drew, "candle_pane", "TRENDLINES")[0];
    expect(h).toBeDefined();
    expect(hitAnyTrendlineHandle(drew, h.x, h.y)).toBe(true);
    // A DIFFERENT chart with the same pane and instance names must not inherit
    // them: pane-relative pixels from one chart would otherwise light up the
    // cursor over another in a multi-chart layout.
    expect(hitAnyTrendlineHandle({}, h.x, h.y)).toBe(false);
  });

  it("misses a point away from every handle", () => {
    record(dips(), params(3), "lastbar");
    expect(hitAnyTrendlineHandle(lastChart, -500, -500)).toBe(false);
  });

  // A removed pane never draws again, and the draw is the only thing that
  // clears the registry, so its last handles would answer the cursor test for
  // the life of the chart: a pointer cursor over dots that are gone.
  it("forgets an instance's handles when it is removed", () => {
    record(dips(), params(3), "lastbar");
    const drew = lastChart;
    const h = getTrendlineHandles(drew, "candle_pane", "TRENDLINES")[0];
    expect(h).toBeDefined();
    dropTrendlineHandles(drew, "TRENDLINES2");
    expect(hitAnyTrendlineHandle(drew, h.x, h.y)).toBe(true);
    dropTrendlineHandles(drew, "TRENDLINES");
    expect(getTrendlineHandles(drew, "candle_pane", "TRENDLINES")).toHaveLength(
      0,
    );
    expect(hitAnyTrendlineHandle(drew, h.x, h.y)).toBe(false);
  });
});

describe("trendlineDimmed", () => {
  const line = (touches: number, lastTouchIdx: number) =>
    ({ touches, lastTouchIdx }) as const;

  it("is off with no thresholds, whatever the line looks like", () => {
    expect(trendlineDimmed(line(9, 0), 500, undefined)).toBe(false);
    expect(trendlineDimmed(line(9, 0), 500, {})).toBe(false);
  });

  it("treats 0 and a non-number as OFF, not as 'dim everything'", () => {
    // 0 is this file's standing off switch (maxTouches, maxSpan, minSlope), so
    // a threshold of 0 must not read as "touches >= 0", which every line meets.
    expect(trendlineDimmed(line(2, 100), 100, { dimTouches: 0 })).toBe(false);
    expect(trendlineDimmed(line(2, 0), 100, { dimStaleBars: 0 })).toBe(false);
    expect(
      trendlineDimmed(line(9, 0), 100, {
        dimTouches: NaN,
        dimStaleBars: NaN,
      }),
    ).toBe(false);
  });

  it("dims AT the touch threshold, not one past it", () => {
    expect(trendlineDimmed(line(4, 100), 100, { dimTouches: 5 })).toBe(false);
    expect(trendlineDimmed(line(5, 100), 100, { dimTouches: 5 })).toBe(true);
    expect(trendlineDimmed(line(6, 100), 100, { dimTouches: 5 })).toBe(true);
  });

  it("counts staleness from the LAST TOUCH, not from the line's age", () => {
    // Both lines are equally old; only the second has been forgotten.
    expect(trendlineDimmed(line(3, 95), 100, { dimStaleBars: 20 })).toBe(false);
    expect(trendlineDimmed(line(3, 80), 100, { dimStaleBars: 20 })).toBe(true);
  });

  it("ORs the two conditions", () => {
    const ext = { dimTouches: 5, dimStaleBars: 20 };
    // Fresh and lightly touched: neither fires.
    expect(trendlineDimmed(line(2, 100), 100, ext)).toBe(false);
    // Either one alone is enough.
    expect(trendlineDimmed(line(7, 100), 100, ext)).toBe(true);
    expect(trendlineDimmed(line(2, 70), 100, ext)).toBe(true);
  });
});

describe("trendlineDimAlpha", () => {
  it("defaults when the pane has no opacity of its own", () => {
    expect(trendlineDimAlpha(undefined)).toBe(TL_DIM_ALPHA);
    expect(trendlineDimAlpha({})).toBe(TL_DIM_ALPHA);
    // A hand-written payload must not paint a line at NaN alpha, which canvas
    // silently reads as "leave the last value alone".
    expect(trendlineDimAlpha({ dimOpacity: NaN })).toBe(TL_DIM_ALPHA);
  });

  it("reads the panel's percent, clamped to [10, 100]", () => {
    expect(trendlineDimAlpha({ dimOpacity: 40 })).toBe(0.4);
    expect(trendlineDimAlpha({ dimOpacity: 100 })).toBe(1);
    // 0 is NOT the off switch here, unlike every threshold on this panel: a
    // line at 0 is gone, and removing a line is what Declutter and Hide broken
    // lines are for.
    expect(trendlineDimAlpha({ dimOpacity: 0 })).toBe(0.1);
    expect(trendlineDimAlpha({ dimOpacity: -20 })).toBe(0.1);
    expect(trendlineDimAlpha({ dimOpacity: 250 })).toBe(1);
  });
});

// The pivot MARKS: what the pivot settings admit, drawn directly instead of
// only through the lines those pivots happen to produce.
describe("TRENDLINES pivot marks", () => {
  const bars = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    // Highs too, or the flat corridor has no strict high pivot at all and the
    // resistance side of every assertion below is vacuous.
    out[30] = bar(30, 99.5, 110);
    out[50] = bar(50, 99.5, 108);
    return out;
  };
  // Padded on both sides, unlike IDENTITY_VIEW: a caret sits OUTSIDE the wick,
  // so a view that maps the extreme highs onto y = 0 would clip every
  // resistance mark and the counts below would be measuring the clamp.
  const view: View = {
    width: 900,
    height: 400,
    axis: 60,
    toX: (i) => i * 10,
    toY: (p) => (110 - p) * 15 + 40,
  };
  const paint = (
    calcParams: number[],
    showPivots: boolean | "default",
    showLinePivots: boolean | "default" = false,
  ): Segment[] =>
    record(
      bars(),
      calcParams,
      undefined,
      view,
      undefined,
      false,
      false,
      false,
      undefined,
      undefined,
      showPivots,
      showLinePivots,
    ).segments;
  const passing = (calcParams: number[]) =>
    computeTrendlines(bars(), parseTrendlinesConfig(calcParams)).pivots;
  const LINES = [2, 0.25, 0.75, 2, 5, 250, 30, 3];
  // Min Touches one above anything this fixture reaches: not a line survives,
  // which is the case the marks have to keep working in.
  const NO_LINES = [2, 0.25, 0.75, 4, 5, 250, 30, 3];

  it("marks every passing pivot by default, and stops when switched off", () => {
    const off = paint(LINES, false);
    const on = paint(LINES, true);
    // Absent key === on: the meta row's default and the draw path's fallback
    // have to agree, or the panel shows a ticked box over an unmarked pane.
    expect(paint(LINES, "default")).toEqual(on);
    const pv = passing(LINES);
    const total = pv.support.length + pv.resistance.length;
    expect(total).toBeGreaterThan(0);
    // Three edges per filled caret, and nothing else changed: the lines are
    // untouched.
    expect(on).toHaveLength(off.length + 3 * total);
  });

  it("marks the pivots even where no line survived to be drawn", () => {
    // The pane is empty of lines at this config — the check the whole test
    // rests on, since marks that rode the line early-returns would vanish here.
    expect(paint(NO_LINES, false)).toHaveLength(0);
    const pv = passing(NO_LINES);
    const total = pv.support.length + pv.resistance.length;
    expect(total).toBeGreaterThan(0);
    expect(paint(NO_LINES, "default")).toHaveLength(3 * total);
  });

  it("points the arrow at price, clear of the wick", () => {
    const marks = paint(NO_LINES, true);
    const pv = passing(NO_LINES);
    // A filled triangle: tip TOWARDS price and TL_PIVOT_GAP clear of the wick,
    // base the width of both arms further out. Three edges, in path order.
    const caret = (idx: number, price: number, dir: 1 | -1) => {
      const x = view.toX(idx);
      const yTip = view.toY(price) + dir * TL_PIVOT_GAP;
      const yBase = view.toY(price) + dir * (TL_PIVOT_GAP + TL_PIVOT_ARM);
      const pts = [
        { x, y: yTip },
        { x: x - TL_PIVOT_ARM, y: yBase },
        { x: x + TL_PIVOT_ARM, y: yBase },
      ];
      return pts.map((p, i) => {
        const q = pts[(i + 1) % pts.length];
        return { x0: p.x, y0: p.y, x1: q.x, y1: q.y, dashed: false, alpha: 1 };
      });
    };
    // UP under a low, DOWN over a high — the arrow points at the swing.
    // Measured against the PIVOT's own price, which is the swing's extreme,
    // not the line's projection.
    const sup = pv.support[0];
    const res = pv.resistance[0];
    for (const arm of caret(sup, pv.lows[sup], 1))
      expect(marks).toContainEqual(arm);
    for (const arm of caret(res, pv.highs[res], -1))
      expect(marks).toContainEqual(arm);
  });
});

// "Mark line pivots": the complement of Show pivots. Show pivots says what the
// FILTER admitted; this says which of those the DRAWN lines rest on.
describe("TRENDLINES line-pivot marks", () => {
  const bars = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    out[30] = bar(30, 99.5, 110);
    out[50] = bar(50, 99.5, 108);
    return out;
  };
  const view: View = {
    width: 900,
    height: 400,
    axis: 60,
    toX: (i) => i * 10,
    toY: (p) => (110 - p) * 15 + 40,
  };
  const paint = (
    calcParams: number[],
    showPivots: boolean | "default",
    showLinePivots: boolean | "default",
  ): Segment[] =>
    record(
      bars(),
      calcParams,
      undefined,
      view,
      undefined,
      false,
      false,
      false,
      undefined,
      undefined,
      showPivots,
      showLinePivots,
    ).segments;
  const LINES = [2, 0.25, 0.75, 2, 5, 250, 30, 3];
  // Min Touches one above anything this fixture reaches: not a line survives,
  // so nothing can be "used" and the stemmed batch must come out empty.
  const NO_LINES = [2, 0.25, 0.75, 4, 5, 250, 30, 3];
  // Min Span 25 with Mixed touches OFF (slot 16). The two highs are 20 bars
  // apart, so no resistance line can span them, and with mixed touches off no
  // support line can count them either: they pass the pivot filter with
  // nothing resting on them, which is exactly the pane this setting exists
  // for. Slots 8..15 hold their defaults.
  const MIXED = [2, 0.25, 0.75, 2, 25, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0, 10, 0];
  const passing = (calcParams: number[]) =>
    computeTrendlines(bars(), parseTrendlinesConfig(calcParams)).pivots;
  // Both glyphs are the same triangle: 3 edges each. What separates them is
  // the INSET — a hollow arrow is stroked one pixel inside the filled one's
  // outline, so its base is 2px narrower — which is the point of the shape:
  // a line pivot claims not one pixel more of the pane than a spare one.
  const EDGES = 3;
  const PLAIN_BASE = 2 * TL_PIVOT_ARM;
  const HOLLOW_BASE = 2 * (TL_PIVOT_ARM - TL_PIVOT_INSET);
  // The base is the only horizontal edge of either triangle.
  const baseWidth = (sg: Segment) => (sg.y0 === sg.y1 ? Math.abs(sg.x1 - sg.x0) : 0);

  it("is off unless asked for: absent key paints exactly what false does", () => {
    expect(paint(LINES, false, "default")).toEqual(paint(LINES, false, false));
    expect(paint(LINES, true, "default")).toEqual(paint(LINES, true, false));
  });

  it("marks the used pivots with a hollow arrow and leaves the rest alone", () => {
    const linesOnly = paint(LINES, false, false);
    const hollow = paint(LINES, false, true).slice(linesOnly.length);
    const used = drawnPivotIdxs(
      computeTrendlines(bars(), parseTrendlinesConfig(LINES)).lines,
    );
    const pv = passing(LINES);
    // Only the pivots a line rests on, and only those the pivot pools hold —
    // a line's touch can be an opposite-side pivot, but it is a pivot either
    // way, so every mark still stands on one.
    const marked = [...pv.support, ...pv.resistance].filter((i) => used.has(i));
    expect(marked.length).toBeGreaterThan(0);
    expect(hollow).toHaveLength(EDGES * marked.length);
    // Every mark sits on a used pivot's x, so none has wandered.
    const xs = new Set(marked.map((i) => view.toX(i)));
    for (const sg of hollow)
      expect([...xs].some((x) => Math.abs(x - sg.x0) <= TL_PIVOT_ARM)).toBe(true);
    // And every one is the HOLLOW triangle, inset inside the filled outline.
    const bases = hollow.map(baseWidth).filter((w) => w > 0);
    expect(bases).toHaveLength(marked.length);
    for (const w of bases) expect(w).toBeCloseTo(HOLLOW_BASE, 6);
  });

  it("keeps the filled arrow's footprint exactly, claiming no extra pane", () => {
    const linesOnly = paint(LINES, false, false);
    const hollow = paint(LINES, false, true).slice(linesOnly.length);
    const filled = paint(LINES, true, false).slice(linesOnly.length);
    // The hollow arrows must not reach further from the wick than the filled
    // ones do — the whole reason the stem was dropped. Compared as the extreme
    // in each direction over the same pivot set (LINES uses every pivot).
    const span = (segs: Segment[]) => {
      const ys = segs.flatMap((sg) => [sg.y0, sg.y1]);
      return [Math.min(...ys), Math.max(...ys)];
    };
    const [hTop, hBot] = span(hollow);
    const [fTop, fBot] = span(filled);
    expect(hBot).toBeLessThanOrEqual(fBot);
    expect(hTop).toBeGreaterThanOrEqual(fTop);
    // Inset by exactly TL_PIVOT_INSET at the tip, not by an arbitrary margin.
    expect(hBot).toBeCloseTo(fBot, 6); // the base is shared; only the tip moves
  });

  it("takes the plain arrow off a used pivot, keeping it on the others", () => {
    const linesOnly = paint(MIXED, false, false);
    const all = paint(MIXED, true, false).slice(linesOnly.length);
    const split = paint(MIXED, true, true).slice(linesOnly.length);
    const pv = passing(MIXED);
    const marked = pv.support.length + pv.resistance.length;
    // Show pivots alone: one filled arrow on every passing pivot.
    expect(all).toHaveLength(EDGES * marked);
    // With both on, EVERY pivot is still marked exactly once — the counts are
    // identical because the two glyphs are the same triangle. What changes is
    // WHICH triangle: the base widths split the marks into the two kinds.
    expect(split).toHaveLength(EDGES * marked);
    const bases = split.map(baseWidth).filter((w) => w > 0);
    expect(bases).toHaveLength(marked);
    const onLine = bases.filter((w) => Math.abs(w - HOLLOW_BASE) < 1e-6).length;
    const spare = bases.filter((w) => Math.abs(w - PLAIN_BASE) < 1e-6).length;
    // Every mark is one kind or the other, and BOTH are on this pane — or the
    // split would hold just as well on a pane that painted everything alike.
    expect(onLine + spare).toBe(marked);
    expect(onLine).toBeGreaterThan(0);
    expect(spare).toBeGreaterThan(0);
  });

  it("marks nothing when no line survived to rest on a pivot", () => {
    const linesOnly = paint(NO_LINES, false, false);
    expect(linesOnly).toHaveLength(0);
    expect(paint(NO_LINES, false, true)).toHaveLength(0);
    // Show pivots still paints its own, unchanged: the two settings are
    // independent, and an empty used set cannot subtract from it.
    expect(paint(NO_LINES, true, true)).toEqual(paint(NO_LINES, true, false));
  });
});

describe("mixed-pivot touches", () => {
  // Deterministic zigzag walk (LCG, Numerical Recipes constants — same idiom
  // as indicatorParityGolden). No Math.random.
  function walk(n: number, seed: number): KLineData[] {
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0), s / 4294967296);
    const out: KLineData[] = [];
    let px = 100;
    for (let i = 0; i < n; i++) {
      const drift = Math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 2.5;
      const open = px;
      const close = px + drift;
      const high = Math.max(open, close) + rnd() * 1.5;
      const low = Math.min(open, close) - rnd() * 1.5;
      out.push({ timestamp: i * 60_000, open, high, low, close, volume: 1 });
      px = close;
    }
    return out;
  }
  const bars = walk(400, 3);
  const off = { ...TRENDLINES_DEFAULTS, mixedTouches: 0 };
  const on = { ...TRENDLINES_DEFAULTS, mixedTouches: 1 };
  const key = (l: TrendLine) => `${l.side}:${l.i1}:${l.i2}`;

  it("changes touches only: geometry, lifetime and breaks are identical", () => {
    const a = computeTrendlines(bars, off);
    const b = computeTrendlines(bars, on);
    const am = new Map(a.lines.map((l) => [key(l), l]));
    const bm = new Map(b.lines.map((l) => [key(l), l]));
    expect([...bm.keys()].sort()).toEqual([...am.keys()].sort());
    for (const [k2, la] of am) {
      const lb = bm.get(k2)!;
      expect([lb.p1, lb.p2, lb.brokenIdx, lb.lastTouchIdx]).toEqual([la.p1, la.p2, la.brokenIdx, la.lastTouchIdx]);
      expect(lb.touches).toBeGreaterThanOrEqual(la.touches);
      expect(lb.touchIdxs.length).toBe(lb.touches);
    }
  });

  it("off means untouched: firstTouchIdx === i1 and counts match today's", () => {
    const a = computeTrendlines(bars, off);
    for (const l of a.lines) {
      expect(l.firstTouchIdx).toBe(l.i1);
      expect(l.touchIdxs.length).toBe(l.touches);
    }
  });

  it("on collects at least one opposite-side touch on this walk, each inside band and window", () => {
    const b = computeTrendlines(bars, on);
    const a = computeTrendlines(bars, off);
    const am = new Map(a.lines.map((l) => [key(l), l]));
    let extras = 0;
    for (const l of b.lines) {
      const base = am.get(key(l))!;
      const extra = l.touchIdxs.filter((t) => !base.touchIdxs.includes(t));
      extras += extra.length;
      const oppPool = b.pivots[l.side === "support" ? "resistance" : "support"];
      const oppVals = l.side === "support" ? b.pivots.highs : b.pivots.lows;
      for (const t of extra) {
        expect(oppPool).toContain(t);
        expect(t).toBeGreaterThanOrEqual(l.i1 - TRENDLINES_DEFAULTS.maxProjBars);
        const tol = b.atr[t] as number;
        expect(
          inTouchBand(l, t, oppVals[t], off.touchMult * tol, off.violMult * tol),
        ).toBe(true);
      }
      expect(l.firstTouchIdx).toBeLessThanOrEqual(l.i1);
      if (l.firstTouchIdx < l.i1) expect(l.touchIdxs).toContain(l.firstTouchIdx);
    }
    // The walk must actually exercise the feature. If a code change makes this
    // 0, pick a different seed for walk() rather than deleting the assertion.
    expect(extras).toBeGreaterThan(0);
  });
});

describe("windowed buildTlState (compute floor)", () => {
  // A long flat corridor with one early support pair (20/40) and one late pair
  // (220/240), so a floor between them separates "excluded by the window" from
  // "fully warmed inside it".
  const floorBars = (): KLineData[] => {
    // 280 bars: the early pair stays inside maxProjBars (250) of the end,
    // so the full run still carries it for the comparison.
    const bars = flat(280);
    bars[20] = bar(20, 94, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[200] = bar(200, 94, 100.5);
    bars[220] = bar(220, 94, 100.5);
    return bars;
  };

  it("startIdx 0 is identical to computeTrendlines", () => {
    const bars = floorBars();
    const full = computeTrendlines(bars, cfg());
    const st = buildTlState(bars, bars.length, cfg(), 0);
    expect(st.lines).toEqual(full.lines);
    expect(st.points).toEqual(full.points);
    expect(st.atr).toEqual(full.atr);
  });

  it("a floor keeps fully-warmed late lines and drops lines left of it", () => {
    const bars = floorBars();
    const full = computeTrendlines(bars, cfg());
    expect(full.lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(true);
    expect(full.lines.some((l) => l.i1 === 200 && l.i2 === 220)).toBe(true);
    const st = buildTlState(bars, bars.length, cfg(), 100);
    expect(st.lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(false);
    const late = st.lines.find((l) => l.i1 === 200 && l.i2 === 220);
    const twin = full.lines.find((l) => l.i1 === 200 && l.i2 === 220);
    expect(late).toBeTruthy();
    // Identical geometry for the shared late line: the floor's warmup margin
    // is upstream of everything this line reads.
    expect(late!.p1).toBe(twin!.p1);
    expect(late!.p2).toBe(twin!.p2);
    expect(late!.brokenIdx).toBe(twin!.brokenIdx);
  });

  it("point rows below the floor are empty; ATR warms from the floor", () => {
    const bars = floorBars();
    const st = buildTlState(bars, bars.length, cfg(), 100);
    expect(st.points[99]).toEqual({});
    expect(st.points[0]).toEqual({});
    expect(st.atr[100 + 12]).toBeNull(); // inside the windowed ATR warmup
    expect(st.atr[100 + 13]).not.toBeNull(); // TL_ATR_LEN 14: first value
    expect(st.atr[50]).toBeNull(); // below the floor: never computed
  });
});

describe("session compute floor", () => {
  const floored = (): KLineData[] => {
    const bars = flat(280);
    bars[20] = bar(20, 94, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[200] = bar(200, 94, 100.5);
    bars[220] = bar(220, 94, 100.5);
    return bars;
  };

  it("computes from the floor: empty rows below, early lines absent", () => {
    const bars = floored();
    const session = createTrendlinesSession();
    const r = session.compute(bars, cfg(), bars[100].timestamp);
    expect(r.points[99]).toEqual({});
    expect(r.lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(false);
    expect(r.lines.some((l) => l.i1 === 200 && l.i2 === 220)).toBe(true);
  });

  it("lowering the floor rebuilds and surfaces earlier lines", () => {
    const bars = floored();
    const session = createTrendlinesSession();
    const high = session.compute(bars, cfg(), bars[100].timestamp);
    expect(high.lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(false);
    const low = session.compute(bars, cfg(), bars[0].timestamp);
    expect(low.lines.some((l) => l.i1 === 20 && l.i2 === 40)).toBe(true);
  });

  it("a stable floor keeps the incremental per-tick path (shared prefix rows)", () => {
    const bars = floored();
    const session = createTrendlinesSession();
    const floorTs = bars[100].timestamp;
    const r1 = session.compute(bars, cfg(), floorTs);
    // In-place tick mutation, klinecharts-style: same array identity.
    bars[bars.length - 1] = bar(279, 99.0, 100.5);
    const r2 = session.compute(bars, cfg(), floorTs);
    for (let i = 0; i < bars.length - 1; i++)
      expect(r2.points[i]).toBe(r1.points[i]); // identity: no rebuild happened
  });
});
