import type { KLineData } from "klinecharts";
import { describe, expect, it } from "vitest";
import { hiddenAware } from "./hiddenCalc";
import {
  buildTlState,
  computeTrendlines,
  createTrendlinesSession,
  dropTrendlineHandles,
  getTrendlineHandles,
  hitAnyTrendlineHandle,
  hitHandle,
  touchWeight,
  TL_TAG_ROW,
  withinSlope,
  aboveSlope,
  hasSwingReach,
  swingStrength,
  admitMajor,
  poolPosition,
  isMajor,
  isSignificantSwing,
  lineExtent,
  lineKey,
  meetsAt,
  overCeilings,
  sideSign,
  stepCrossing,
  hasBackClearance,
  touchGaps,
  TL_HANDLE_HIT,
  TL_HANDLE_RADIUS,
  TL_HANDLE_STROKE,
  TL_TOUCH_RADIUS,
  TL_PIVOT_ARM,
  TL_PIVOT_GAP,
  projectAt,
  rankLines,
  compareSurvival,
  selectDrawnLines,
  poolable,
  trendlineGate,
  selectLevels,
  pivotDepths,
  mergeTolerance,
  maxDistanceTol,
  sameTrend,
  withinDistance,
  drawnPivotIdxs,
  TL_PIVOT_STEM,
  TL_PIVOT_USED_GAP,
  trendlineDimmed,
  TL_DIM_ALPHA,
  trendlineDimAlpha,
  TL_DEDUPE_ATR,
  TL_NEAR_PRICE_ATR,
  TL_LINE_COLOR,
  trendlineDash,
  trendlineStyleOf,
  TRENDLINES_TEMPLATE,
  type TrendlinesCalcPoint,
  type TrendLine,
  type PivotKind,
} from "./trendlines";
import {
  MAX_LIVE,
  parseTrendlinesConfig,
  TRENDLINES_DEFAULTS,
  type TrendlinesConfig,
} from "./trendlinesOutputs";

// A descending line falling 1.0 per bar from 100 at bar 0 to 90 at bar 10,
// anchored on two highs.
const res: TrendLine = {
  i1: 0,
  p1: 100,
  k1: "high",
  i2: 10,
  p2: 90,
  k2: "high",
  touches: 2,
  // The two anchors, which is what a freshly seeded line carries. Fixtures that
  // move their anchors and mean to exercise the shared-BAR half of sharesPivot
  // override this; the rest match on anchors, as they did before it existed.
  touchIdxs: [0, 10],
  touchKinds: ["high", "high"],
  lastTouchIdx: 10,
  crossings: 0,
  crossIdxs: [],
  lastSign: 0,
  // The anchor gap, which is what those two touches alone span. Fixtures that
  // move their anchors and care about spacing override it.
  maxTouchGap: 10,
  minTouchGap: 10,
  maxTouchIdx: 10,
};

// An ascending line rising 1.0 per bar from 50 at bar 0 to 60 at bar 10,
// anchored on two lows.
const sup: TrendLine = {
  ...res,
  p1: 50,
  p2: 60,
  k1: "low",
  k2: "low",
  touchKinds: ["low", "low"],
};

// A descending line through a high at bar 0 (100) and a LOW at bar 10 (90):
// the sideless shape this detector exists for. Its two kinds differ.
const mixed: TrendLine = {
  i1: 0, p1: 100, k1: "high",
  i2: 10, p2: 90, k2: "low",
  touches: 2, touchIdxs: [0, 10], touchKinds: ["high", "low"],
  lastTouchIdx: 10, crossings: 0, crossIdxs: [], lastSign: 0,
  maxTouchGap: 10, minTouchGap: 10, maxTouchIdx: 10,
};

describe("projectAt", () => {
  it("interpolates between the anchors and extrapolates past them", () => {
    expect(projectAt(mixed, 0)).toBe(100);
    expect(projectAt(mixed, 10)).toBe(90);
    expect(projectAt(mixed, 5)).toBe(95);
    expect(projectAt(mixed, 20)).toBe(80);
  });
});

// `mixed` projects to 95 at bar 5, which is what every case below measures
// against. The kind argument is the PIVOT's kind, not the line's: a swing high
// tests the line from below, a swing low from above.
describe("touchWeight", () => {
  it("scores a swing HIGH: through the line is a full touch, short of it a half", () => {
    expect(touchWeight(mixed, 5, 95, "high", 0.5, 0.25)).toBe(1); // exactly on
    expect(touchWeight(mixed, 5, 95.2, "high", 0.5, 0.25)).toBe(1); // 0.2 through
    expect(touchWeight(mixed, 5, 95.3, "high", 0.5, 0.25)).toBe(0); // past Max Pierce
    expect(touchWeight(mixed, 5, 94.6, "high", 0.5, 0.25)).toBe(0.5); // 0.4 short
    expect(touchWeight(mixed, 5, 94.4, "high", 0.5, 0.25)).toBe(0); // past Max Touch Gap
  });

  it("scores a swing LOW the mirrored way: through means BELOW the line", () => {
    expect(touchWeight(mixed, 5, 95, "low", 0.5, 0.25)).toBe(1);
    expect(touchWeight(mixed, 5, 94.8, "low", 0.5, 0.25)).toBe(1); // 0.2 through
    expect(touchWeight(mixed, 5, 94.7, "low", 0.5, 0.25)).toBe(0);
    expect(touchWeight(mixed, 5, 95.4, "low", 0.5, 0.25)).toBe(0.5); // 0.4 short
    expect(touchWeight(mixed, 5, 95.6, "low", 0.5, 0.25)).toBe(0);
  });

  it("at zero on both tolerances, only a pivot exactly on the line counts", () => {
    expect(touchWeight(mixed, 5, 95, "high", 0, 0)).toBe(1);
    expect(touchWeight(mixed, 5, 95, "low", 0, 0)).toBe(1);
    expect(touchWeight(mixed, 5, 95.0001, "high", 0, 0)).toBe(0);
    expect(touchWeight(mixed, 5, 94.9999, "high", 0, 0)).toBe(0);
  });

  it("at zero Max Touch Gap a pivot short of the line scores nothing at all", () => {
    // The shipped default: a gap never counts unless the user allows one.
    expect(touchWeight(mixed, 5, 94.9, "high", 0, 0.25)).toBe(0);
    expect(touchWeight(mixed, 5, 95.1, "low", 0, 0.25)).toBe(0);
  });
});

describe("sideSign / stepCrossing", () => {
  it("reports which side of the line a close sits on, 0 exactly on it", () => {
    expect(sideSign(mixed, 5, 96)).toBe(1);
    expect(sideSign(mixed, 5, 94)).toBe(-1);
    expect(sideSign(mixed, 5, 95)).toBe(0);
  });
  it("counts a crossing only when the non-zero sign changes", () => {
    const l = { ...mixed, touchIdxs: [...mixed.touchIdxs], touchKinds: [...mixed.touchKinds] };
    stepCrossing(l, 1, 98); // below: baseline, no count
    expect([l.crossings, l.lastSign]).toEqual([0, -1]);
    stepCrossing(l, 2, 97.5); // still below (line is 98 here)
    expect(l.crossings).toBe(0);
    stepCrossing(l, 3, 97); // line is 97 here: on it, keeps the previous sign
    expect([l.crossings, l.lastSign]).toEqual([0, -1]);
    stepCrossing(l, 4, 99); // above: one crossing
    expect([l.crossings, l.lastSign]).toEqual([1, 1]);
    stepCrossing(l, 5, 90); // back below: two
    expect(l.crossings).toBe(2);
    // The crossing bars, for the marks: only the counted ones.
    expect(l.crossIdxs).toEqual([4, 5]);
  });
  it("records crossing bars on a line restored without the field", () => {
    const l = { ...mixed, touchIdxs: [...mixed.touchIdxs], touchKinds: [...mixed.touchKinds] };
    delete (l as { crossIdxs?: number[] }).crossIdxs;
    stepCrossing(l, 1, 98);
    stepCrossing(l, 4, 99);
    expect([l.crossings, l.crossIdxs]).toEqual([1, [4]]);
  });
});

describe("hasBackClearance", () => {
  // `back` runs 100@5 -> 90@15 (1/bar down), so behind i1 the line sits at
  // 101@4, 102@3, 103@2, 104@1, 105@0.
  const back: TrendLine = { ...mixed, i1: 5, i2: 15, touchIdxs: [5, 15], lastTouchIdx: 15, maxTouchIdx: 15 };
  it("is off at zero", () => {
    expect(hasBackClearance(back, [200, 0, 200, 0, 200, 100], 0, 0)).toBe(true);
  });
  it("passes when the close stays on one side, either side", () => {
    expect(hasBackClearance(back, [90, 90, 90, 90, 90, 100], 0, 5)).toBe(true);
    expect(hasBackClearance(back, [110, 110, 110, 110, 110, 100], 0, 5)).toBe(true);
  });
  it("a close on the line is neutral", () => {
    expect(hasBackClearance(back, [90, 104, 90, 102, 90, 100], 0, 5)).toBe(true);
  });
  it("rejects a single side change inside the window", () => {
    expect(hasBackClearance(back, [90, 90, 110, 90, 90, 100], 0, 5)).toBe(false);
  });
  it("ignores bars outside the window", () => {
    expect(hasBackClearance(back, [110, 90, 90, 90, 90, 100], 0, 4)).toBe(true);
  });
  it("rejects when the window reaches before the first computed bar", () => {
    expect(hasBackClearance(back, [90, 90, 90, 90, 90, 100], 0, 6)).toBe(false);
    expect(hasBackClearance(back, [90, 90, 90, 90, 90, 100], 1, 5)).toBe(false);
    expect(hasBackClearance(back, [90, 90, 90, 90, 90, 100], 1, 4)).toBe(true);
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
  const base = mixed;
  it("prefers more touches, then a longer span, then fewer crossings", () => {
    const more = { ...base, touches: 3 };
    expect(rankLines(more, base)).toBeLessThan(0);
    const longer = { ...base, lastTouchIdx: 30 };
    expect(rankLines(longer, base)).toBeLessThan(0);
    const crossed = { ...base, crossings: 2 };
    expect(rankLines(base, crossed)).toBeLessThan(0);
  });
  it("breaks the remaining ties by recency, origin, then anchor price", () => {
    const a = { ...base, i1: 0, lastTouchIdx: 20 };
    const b = { ...base, i1: 5, lastTouchIdx: 25 }; // same span 20, more recent
    expect(rankLines(b, a)).toBeLessThan(0);
    const c = { ...base, i1: 0, i2: 10, p1: 50 };
    expect(rankLines(c, base)).toBeLessThan(0); // lower p1 first
    expect(rankLines(base, base)).toBe(0);
  });
});

describe("survival order", () => {
  const base = mixed;
  it("keeps the least-crossed line first, then the longest, then the most touched", () => {
    const crossed = { ...base, crossings: 2 };
    expect(compareSurvival(base, crossed)).toBeLessThan(0);
    // A line with FEWER touches still outlives a crossed one: this is exactly
    // where survival and rankLines disagree.
    const fewerButClean = { ...base, touches: 2 };
    const manyButCrossed = { ...base, touches: 9, crossings: 1 };
    expect(compareSurvival(fewerButClean, manyButCrossed)).toBeLessThan(0);
    expect(rankLines(fewerButClean, manyButCrossed)).toBeGreaterThan(0);
    // Equal crossings: the longer line, then the more touched one.
    const longer = { ...base, lastTouchIdx: 30 };
    expect(compareSurvival(longer, base)).toBeLessThan(0);
    const more = { ...base, touches: 3 };
    expect(compareSurvival(more, base)).toBeLessThan(0);
  });

  it("breaks the remaining ties by recency, origin, then anchor price, and is total", () => {
    const a = { ...base, i1: 0, lastTouchIdx: 20 };
    const b = { ...base, i1: 5, lastTouchIdx: 25 }; // same span 20, more recent
    expect(compareSurvival(b, a)).toBeLessThan(0);
    const lowerP1 = { ...base, i1: 0, i2: 10, p1: 50 };
    expect(compareSurvival(lowerP1, base)).toBeLessThan(0);
    expect(compareSurvival(base, base)).toBe(0);
    // Antisymmetric on every key, so the two ports sort identically.
    const pairs: Array<[typeof base, typeof base]> = [
      [base, crossedOf(base)],
      [base, { ...base, lastTouchIdx: 30 }],
      [base, { ...base, touches: 7 }],
      [base, { ...base, i1: 1 }],
      [base, { ...base, p1: 1 }],
    ];
    for (const [x, y] of pairs) {
      expect(Math.sign(compareSurvival(x, y))).toBe(-Math.sign(compareSurvival(y, x)));
    }
  });
});

/** A copy of `l` price has crossed once, for the antisymmetry sweep. */
function crossedOf(l: TrendLine): TrendLine {
  return { ...l, crossings: 1 };
}

describe("isMajor and overCeilings with crossings", () => {
  const cfgC = { ...TRENDLINES_DEFAULTS, minSpanBars: 5 };
  it("floors on Min Crossings and silences on Max Crossings", () => {
    const l = { ...mixed, crossings: 1 };
    expect(isMajor(l, 12, { ...cfgC, minCrossings: 2 })).toBe(false);
    expect(isMajor(l, 12, { ...cfgC, minCrossings: 1 })).toBe(true);
    expect(overCeilings({ ...l, crossings: 3 }, { ...cfgC, maxCrossings: 2 })).toBe(true);
    expect(overCeilings({ ...l, crossings: 2 }, { ...cfgC, maxCrossings: 2 })).toBe(false);
    expect(overCeilings(l, cfgC)).toBe(false); // 0 = no limit
  });
  it("has no broken clock: coverage ends Max Projection past the last touch", () => {
    expect(isMajor(mixed, 10 + cfgC.maxProjBars, cfgC)).toBe(true);
    expect(isMajor(mixed, 11 + cfgC.maxProjBars, cfgC)).toBe(false);
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

/** A deterministic random walk: unlike `flat`, lines drawn through its pivots
 * run THROUGH later price, so they collect crossings. */
function walk(n: number, seed = 11): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const bars: KLineData[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px += (rand() - 0.5) * 3;
    bars.push(bar(i, px - 0.5, px + 0.5));
  }
  return bars;
}

const cfg = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig => ({
  ...TRENDLINES_DEFAULTS,
  pivotLen: 2,
  minSpanBars: 5,
  ...over,
});

describe("isSignificantSwing", () => {
  //        0   1   2   3   4
  const highs = [10, 14, 10, 10, 12];
  const lows = [10, 10, 10, 6, 10];

  it("passes everything at zero, without reading a bar", () => {
    // Off is a short circuit, not a comparison that happens to come out true:
    // an EMPTY pool would otherwise reject.
    expect(isSignificantSwing([], [], [], 0, "low", 1, 0)).toBe(true);
  });

  it("measures a low against the most recent HIGH pivot before it", () => {
    // Leg = highs[1] - lows[3] = 14 - 6 = 8.
    const at = (mult: number) =>
      isSignificantSwing(highs, lows, [1], 3, "low", 1, mult);
    expect(at(8)).toBe(true);
    expect(at(8.01)).toBe(false);
  });

  it("measures a high against the most recent LOW pivot before it", () => {
    // Leg = highs[4] - lows[3] = 12 - 6 = 6.
    const at = (mult: number) =>
      isSignificantSwing(highs, lows, [3], 4, "high", 1, mult);
    expect(at(6)).toBe(true);
    expect(at(6.01)).toBe(false);
  });

  it("takes the LAST opposite pivot, not the first", () => {
    // Pool [0, 1]: bar 1's high of 14 is the leg, not bar 0's 10.
    expect(isSignificantSwing(highs, lows, [0, 1], 3, "low", 1, 8)).toBe(
      true,
    );
    expect(isSignificantSwing(highs, lows, [0], 3, "low", 1, 8)).toBe(false);
  });

  it("ignores an opposite pivot at or after the bar itself", () => {
    // Strictly before: one bar can be both a strict high and a strict low
    // pivot, and the resistance pool fills first within a confirm bar. With 3
    // and 4 skipped, bar 1 is the leg; with only 3 and 4 there is nothing.
    expect(isSignificantSwing(highs, lows, [1, 3, 4], 3, "low", 1, 8)).toBe(
      true,
    );
    expect(isSignificantSwing(highs, lows, [3, 4], 3, "low", 1, 0.1)).toBe(
      false,
    );
  });

  it("rejects when no opposite pivot exists yet", () => {
    // Unmeasurable is not the same as big.
    expect(isSignificantSwing(highs, lows, [], 3, "low", 1, 0.1)).toBe(
      false,
    );
  });

  it("scales the threshold with ATR", () => {
    expect(isSignificantSwing(highs, lows, [1], 3, "low", 2, 4)).toBe(true);
    expect(isSignificantSwing(highs, lows, [1], 3, "low", 2, 4.01)).toBe(
      false,
    );
  });

  it("does NOT depend on pivotLen, which is the whole point", () => {
    // The old window-average measure grew with pivotLen, so a stricter pivot
    // setting could ADD lines. There is no pivotLen argument left to pass.
    expect(isSignificantSwing.length).toBe(7);
  });
});

describe("major tier", () => {
  // A big low at bar 20 (its opposite turn is the high at bar 15; a turn
  // confirmed before ATR warms up is never recorded), then a run of small
  // zigzag pivots that pushes bar 20 out of any short recent window, then a
  // low at bar 170 level with it. Closes stay near 100, so the line across
  // the two lows is never crossed. Under Major Length 10 the majors are the
  // bar 15 high, the bar 20 low and the bar 170 low: every zigzag turn has an
  // equal neighbour within 10 bars. Mirrors Python _old_major_low.
  const oldMajorLow = (): KLineData[] => {
    const bars = flat(200);
    bars[15] = bar(15, 99.5, 103);
    bars[20] = bar(20, 80, 100.5);
    for (let j = 30; j < 150; j += 6) {
      bars[j] = bar(j, 98, 100.5);
      bars[j + 3] = bar(j + 3, 99.5, 102);
    }
    bars[170] = bar(170, 80, 100.5);
    return bars;
  };
  const spansTheLows = (lines: TrendLine[]) => lines.filter((l) => l.i1 === 20 && l.i2 === 170);

  it("reaches past the recent window", () => {
    const bars = oldMajorLow();
    const base = cfg({ pairPivots: 4, maxLines: 50, mergeAtr: 0, majorLen: 10 });
    expect(spansTheLows(computeTrendlines(bars, { ...base, majorPivots: 0 }).lines)).toHaveLength(0);
    expect(spansTheLows(computeTrendlines(bars, { ...base, majorPivots: 1 }).lines)).toHaveLength(1);
  });

  it("is a union with the recent window: a major still inside it seeds once", () => {
    const c = cfg({ pairPivots: 200, maxLines: 50, mergeAtr: 0, majorPivots: 12, majorLen: 10 });
    expect(spansTheLows(computeTrendlines(oldMajorLow(), c).lines)).toHaveLength(1);
  });

  it("drops a major no line could span under Max Span", () => {
    const c = cfg({ pairPivots: 4, maxLines: 50, mergeAtr: 0, majorPivots: 1, maxSpanBars: 100, majorLen: 10 });
    expect(spansTheLows(computeTrendlines(oldMajorLow(), c).lines)).toHaveLength(0);
  });

  it("matches the incremental session with the tier on", () => {
    const bars = oldMajorLow();
    const c = cfg({ pairPivots: 4, maxLines: 50, mergeAtr: 0, majorPivots: 1, majorLen: 10 });
    const ref = computeTrendlines(bars, c);
    const session = createTrendlinesSession();
    const inc = session.compute(bars, c);
    expect(inc.lines).toEqual(ref.lines);
    expect(inc.points).toEqual(ref.points);
  });

  it("exposes the tier's pool positions and the majors seen, for the marks and the readout", () => {
    const bars = oldMajorLow();
    // Size off: the bar 15 high's leg has no opposite turn before it, so any
    // Size at all would drop it (the default 3 included).
    const { pivots } = computeTrendlines(bars, cfg({ pairPivots: 4, maxLines: 50, mergeAtr: 0, majorPivots: 12, majorLen: 10, majorSizeAtr: 0 }));
    expect(pivots.majorQs!.map((q) => [pivots.idxs[q], pivots.kinds[q]])).toEqual([[15, "high"], [20, "low"], [170, "low"]]);
    expect(pivots.majorsSeen).toBe(3);
    // Major Size drops the bar 15 high, whose leg has no opposite turn before it.
    const sized = computeTrendlines(bars, cfg({ majorPivots: 12, majorLen: 10, majorSizeAtr: 5 })).pivots;
    expect(sized.majorsSeen).toBe(2);
    expect(computeTrendlines(bars, cfg({ majorPivots: 0 })).pivots.majorQs).toEqual([]);
  });

  it("a major is the extreme over Major Length bars each side", () => {
    // 30 runs off the start for bar 20, so nothing is major and the long
    // line is not seeded; at 10 it is.
    const bars = oldMajorLow();
    const base = cfg({ pairPivots: 4, maxLines: 50, mergeAtr: 0, majorPivots: 12 });
    expect(spansTheLows(computeTrendlines(bars, { ...base, majorLen: 30 }).lines)).toHaveLength(0);
    expect(spansTheLows(computeTrendlines(bars, { ...base, majorLen: 10 }).lines)).toHaveLength(1);
  });

  it("poolPosition finds a pivot by bar and kind", () => {
    const pool = { idxs: [3, 9, 9, 15], kinds: ["high", "high", "low", "low"] as PivotKind[] };
    expect(poolPosition(pool, 9, "low")).toBe(2);
    expect(poolPosition(pool, 9, "high")).toBe(1);
    expect(poolPosition(pool, 15, "high")).toBe(-1);
    expect(poolPosition(pool, 4, "low")).toBe(-1);
  });

  it("admitMajor evicts the weakest only when strictly beaten", () => {
    const m = { q: [] as number[], strength: [] as number[] };
    admitMajor(m, 0, 1, 2);
    admitMajor(m, 1, 3, 2);
    admitMajor(m, 2, 1, 2); // tie with the weakest: the older stays
    expect(m).toEqual({ q: [0, 1], strength: [1, 3] });
    admitMajor(m, 3, 2, 2);
    expect(m).toEqual({ q: [1, 3], strength: [3, 2] });
    admitMajor(m, 4, 9, 0); // off
    expect(m.q).toEqual([1, 3]);
  });

  it("swingStrength is the leg in ATR, 0 without an opposite turn or ATR", () => {
    const highs = [100, 110, 100];
    const lows = [90, 100, 90];
    expect(swingStrength(highs, lows, [1], 2, "low", 4)).toBe(5);
    expect(swingStrength(highs, lows, [], 2, "low", 4)).toBe(0);
    expect(swingStrength(highs, lows, [1], 2, "low", null)).toBe(0);
    expect(swingStrength(highs, lows, [2], 2, "low", 4)).toBe(0); // strictly before k
  });
});

describe("withinSlope", () => {
  // Rise 10 over span 10 = 1.0 per bar; at ATR 2 that is +0.5 ATR per bar.
  const line: TrendLine = { ...sup, p1: 100, p2: 110 };
  const down: TrendLine = { ...line, p2: 90 };

  it("passes everything at zero", () => {
    expect(withinSlope(line, 2, 0)).toBe(true);
    expect(withinSlope(down, 2, 0)).toBe(true);
  });

  it("compares the SIGNED slope in ATR per bar", () => {
    expect(withinSlope(line, 2, 0.5)).toBe(true);
    expect(withinSlope(line, 2, 0.49)).toBe(false);
    // A falling line is below any positive ceiling, however small.
    expect(withinSlope(down, 2, 0.01)).toBe(true);
  });

  it("keeps only falling lines under a negative ceiling", () => {
    expect(withinSlope(down, 2, -0.5)).toBe(true);
    expect(withinSlope(down, 2, -0.51)).toBe(false);
    expect(withinSlope(line, 2, -0.01)).toBe(false);
  });
});

describe("aboveSlope", () => {
  const line: TrendLine = { ...sup, p1: 100, p2: 110 };
  const down: TrendLine = { ...line, p2: 90 };

  it("passes everything at zero", () => {
    expect(aboveSlope(line, 2, 0)).toBe(true);
    expect(aboveSlope(down, 2, 0)).toBe(true);
  });

  it("is the mirror of withinSlope at the same threshold", () => {
    // Both true exactly at the boundary, so a band of [x, x] admits only a
    // line at exactly that slope rather than nothing at all.
    expect(aboveSlope(line, 2, 0.5)).toBe(true);
    expect(withinSlope(line, 2, 0.5)).toBe(true);
    expect(aboveSlope(line, 2, 0.51)).toBe(false);
  });

  it("drops falling lines under a positive floor, caps them under a negative one", () => {
    expect(aboveSlope(down, 2, 0.01)).toBe(false);
    expect(aboveSlope(down, 2, -0.5)).toBe(true);
    expect(aboveSlope(down, 2, -0.49)).toBe(false);
  });
});

describe("signed slope range at seed time", () => {
  // Three rising lows (or their mirror, three falling highs) in a flat
  // corridor; every line the fixture seeds runs the one way.
  const rising = () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 98.5, 100.5);
    return bars;
  };
  const falling = () => {
    const bars = flat(80);
    bars[20] = bar(20, 99.5, 110);
    bars[40] = bar(40, 99.5, 106);
    bars[60] = bar(60, 99.5, 101.5);
    return bars;
  };
  const last = (bars: KLineData[], over: Partial<TrendlinesConfig>) =>
    computeTrendlines(bars, cfg({ mergeAtr: 0, ...over })).points[79];

  it("a positive floor keeps rising lines and drops falling ones", () => {
    expect(last(rising(), { minSlopeAtr: 0.01 }).tl_1).toBeDefined();
    expect(last(falling(), { minSlopeAtr: 0.01 }).tl_1).toBeUndefined();
  });

  it("a negative ceiling keeps falling lines and drops rising ones", () => {
    expect(last(falling(), { maxSlopeAtr: -0.01 }).tl_1).toBeDefined();
    expect(last(rising(), { maxSlopeAtr: -0.01 }).tl_1).toBeUndefined();
  });

  it("a symmetric band caps steepness both ways", () => {
    expect(last(rising(), { minSlopeAtr: -0.5, maxSlopeAtr: 0.5 }).tl_1).toBeDefined();
    expect(last(falling(), { minSlopeAtr: -0.5, maxSlopeAtr: 0.5 }).tl_1).toBeDefined();
    expect(last(rising(), { minSlopeAtr: -0.05, maxSlopeAtr: 0.05 }).tl_1).toBeUndefined();
    expect(last(falling(), { minSlopeAtr: -0.05, maxSlopeAtr: 0.05 }).tl_1).toBeUndefined();
  });
});

describe("hasSwingReach", () => {
  // A low of 6 with 10s to its left: it beats every one of them.
  const lows = [10, 10, 10, 10, 6];
  const highs = [10, 10, 10, 10, 14];

  it("passes everything at zero, without reading a bar", () => {
    expect(hasSwingReach([], 0, "low", 0)).toBe(true);
  });

  it("counts only the bars to the LEFT", () => {
    // Nothing to the right of index 4 exists, and asking for 4 still passes:
    // right reach is deliberately not part of this.
    expect(hasSwingReach(lows, 4, "low", 4)).toBe(true);
    expect(hasSwingReach(highs, 4, "high", 4)).toBe(true);
  });

  it("rejects rather than truncating when it runs off the start", () => {
    // Same as isPivotAt: a window that does not fit is not a smaller window.
    expect(hasSwingReach(lows, 4, "low", 5)).toBe(false);
  });

  it("stops at the first bar that is not beyond the pivot", () => {
    expect(hasSwingReach([10, 5, 10, 10, 6], 4, "low", 2)).toBe(true);
    expect(hasSwingReach([10, 5, 10, 10, 6], 4, "low", 3)).toBe(false);
  });

  it("treats an equal bar as not beaten", () => {
    // Strict, matching isPivotAt's strict mode: a flat stretch is not reach.
    expect(hasSwingReach([10, 10, 10, 6, 6], 4, "low", 1)).toBe(false);
  });
});

describe("computeTrendlines", () => {
  it("returns one point per bar and emits nothing before warm-up", () => {
    const { points } = computeTrendlines(flat(30), cfg());
    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({});
  });

  it("finds a rising line through two swing lows", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect([l!.k1, l!.k2, l!.p1, l!.p2]).toEqual(["low", "low", 90, 94]);
  });

  it("connects a swing HIGH to a later swing LOW: the sideless case", () => {
    // A high poking above the corridor at 20 and a low poking below at 40,
    // the line falls from 110 to 90. Price between them sits ~100, i.e. BELOW
    // the line near 20 and ABOVE it near 40, so it also crosses once.
    const bars = flat(60);
    bars[20] = bar(20, 99.5, 110);
    bars[40] = bar(40, 90, 100.5);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect([l!.k1, l!.k2, l!.p1, l!.p2]).toEqual(["high", "low", 110, 90]);
    expect(l!.crossings).toBe(1);
  });

  it("never pairs a bar's own high with its own low (span would be 0)", () => {
    // A lone spike is a strict high AND a strict low pivot on one bar.
    const bars = flat(60);
    bars[20] = bar(20, 90, 110);
    bars[40] = bar(40, 92, 108);
    const { lines, pivots } = computeTrendlines(bars, cfg());
    // Both kinds of pivot at 20 exist, high first.
    const at20 = pivots.idxs.map((idx, q) => [idx, pivots.kinds[q]]).filter(([idx]) => idx === 20);
    expect(at20).toEqual([[20, "high"], [20, "low"]]);
    for (const l of lines) expect(l.i2).toBeGreaterThan(l.i1);
  });

  it("does not break a line when price runs far beyond it; it counts crossings", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 90, 100.5); // flat support-shaped line at 90
    for (let j = 60; j < 70; j++) bars[j] = bar(j, 80, 81); // close 80.5, far below
    for (let j = 70; j < 80; j++) bars[j] = bar(j, 99.5, 100.5); // back above
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l).toBeDefined();
    expect(l!.crossings).toBe(2); // above -> below at 60, below -> above at 70
  });

  it("counts a later pivot of EITHER kind that pierces the line as a full touch", () => {
    const bars = flat(100);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 90, 100.5);
    // A swing HIGH poking 0.2 THROUGH the flat line at 90 (ATR is 1, so Max
    // Pierce 0.25 covers it). A high above the line it tests is a pierce.
    for (let j = 55; j < 66; j++) bars[j] = bar(j, 85, 86);
    bars[60] = bar(60, 85, 90.2);
    const { lines } = computeTrendlines(bars, cfg());
    const l = lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(l!.touches).toBe(3);
    expect(l!.touchIdxs).toContain(60);
    expect(l!.touchKinds[l!.touchIdxs.indexOf(60)]).toBe("high");
    expect(l!.lastTouchIdx).toBe(60);
  });

  it("counts a pivot that stops SHORT as half a touch, and only if a gap is allowed", () => {
    const bars = flat(100);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 90, 100.5);
    // Same swing high, now stopping 0.3 below the line at 90 rather than
    // poking through it.
    for (let j = 55; j < 66; j++) bars[j] = bar(j, 85, 86);
    bars[60] = bar(60, 85, 89.7);
    // At the shipped default (Max Touch Gap 0) the pivot is not a touch at all.
    const tight = computeTrendlines(bars, cfg()).lines.find((x) => x.i1 === 20 && x.i2 === 40);
    expect(tight!.touches).toBe(2);
    expect(tight!.lastTouchIdx).toBe(40);
    // Allow a 0.3 ATR gap and it counts, at HALF the weight of a pierce.
    const loose = computeTrendlines(bars, cfg({ touchMult: 0.3 })).lines
      .find((x) => x.i1 === 20 && x.i2 === 40);
    expect(loose!.touches).toBe(2.5);
    expect(loose!.touchIdxs).toContain(60);
    expect(loose!.lastTouchIdx).toBe(60);
  });

  it("emits tl_1..tl_N by rank and tl_nearest by distance to the close", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5); // rising line, projects ABOVE the close later
    bars[25] = bar(25, 99.5, 108);
    bars[45] = bar(45, 99.5, 104); // falling line
    // Merge off, so the drawn set is the top maxLines majors by rank.
    const c = { ...cfg(), maxLines: 2, mergeAtr: 0 };
    const { points, lines } = computeTrendlines(bars, c);
    const last = points[79];
    const majors = lines.filter((l) => isMajor(l, 79, c)).sort(rankLines);
    expect(majors.length).toBeGreaterThanOrEqual(3);
    expect(last.tl_1).toBe(projectAt(majors[0], 79));
    expect(last.tl_2).toBe(projectAt(majors[1], 79));
    expect(last.tl_3).toBeUndefined();
    const close = bars[79].close;
    const dist = (l: TrendLine) => Math.abs(projectAt(l, 79) - close);
    // tl_nearest is the nearest AMONG THE DRAWN lines: only what is on the
    // chart takes part in a rule, and a third major ranked past the budget
    // is not on the chart, however close it sits.
    const nearest = majors.slice(0, 2).reduce((b, l) => (dist(l) < dist(b) ? l : b));
    expect(last.tl_nearest).toBe(projectAt(nearest, 79));
    expect(Math.min(...majors.slice(2).map(dist))).toBeLessThan(dist(nearest));
  });

  // Three lows at 20 (90), 40 (94) and 60 (98.5): the pairs 20-40, 20-60 and
  // 40-60 seed three lines that project within 1 ATR of each other at bar 79
  // and share pivots, so the merge pass keeps one. Mirrored in Python.
  const fan = () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 98.5, 100.5);
    return bars;
  };

  it("merges in the emit step: a merged-away line reports nothing", () => {
    const off = computeTrendlines(fan(), cfg({ mergeAtr: 0 })).points[79];
    expect(off.tl_1).toBeDefined();
    expect(off.tl_2).toBeDefined();
    expect(off.tl_3).toBeDefined();
    const on = computeTrendlines(fan(), cfg({ mergeAtr: 1 })).points[79];
    expect(on.tl_1).toBeDefined();
    expect(on.tl_2).toBeUndefined();
    expect(on.tl_nearest).toBe(on.tl_1);
    const pivot = computeTrendlines(fan(), cfg({ mergeAtr: 0, maxPerPivot: 1 })).points[79];
    expect(pivot.tl_1).toBeDefined();
    expect(pivot.tl_2).toBeUndefined();
    // At 2 per pivot the fan keeps two: the third shares a pivot with both.
    const two = computeTrendlines(fan(), cfg({ mergeAtr: 0, maxPerPivot: 2 })).points[79];
    expect(two.tl_2).toBeDefined();
    expect(two.tl_3).toBeUndefined();
  });

  it("the drawn set IS the emitted set under merging", () => {
    const c = cfg();
    const { points, lines, atr } = computeTrendlines(fan(), c);
    const eligible = lines.filter((l) => isMajor(l, 79, c));
    const drawn = selectDrawnLines(eligible, 79, 100, c.maxLines, {
      tol: mergeTolerance(c, atr[79], 100),
      keep: new Set(),
    });
    expect(drawn.map((l) => projectAt(l, 79))).toEqual(
      [points[79].tl_1, points[79].tl_2, points[79].tl_3].filter((v) => v !== undefined),
    );
  });

  it("stops projecting past Max Projection", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const c = { ...cfg(), maxProjBars: 30 };
    const { points } = computeTrendlines(bars, c);
    expect(points[70].tl_1).toBeDefined(); // 40 + 30
    expect(points[71].tl_1).toBeUndefined();
  });

  it("is causal: a prefix computes the same values as the full series", () => {
    const bars = flat(120);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 99.5, 108);
    const full = computeTrendlines(bars, cfg()).points;
    const pre = computeTrendlines(bars.slice(0, 80), cfg()).points;
    for (let i = 0; i < 80; i++) expect(pre[i]).toEqual(full[i]);
  });

  it("keeps a fresh long uncrossed line alive against a crowd of crossed ones", () => {
    // The defect this ordering exists for: a line is CONSTRUCTED ONCE, at its
    // second anchor's confirm bar, so losing the cap that bar is permanent. A
    // trader's line is born with two touches and earns the rest over years,
    // into a crowd that already has three or more. Ordering survival by
    // touches evicts it at birth; ordering by crossings keeps it, because
    // price has never been on both sides of it.
    const bars = walk(240);
    const floorPx = Math.min(...bars.map((b) => b.low));
    // Two lows under the whole walk, 140 bars apart. Every close sits above
    // the line they define, from bar 20 to the end, so it never crosses.
    bars[20] = bar(20, floorPx - 20, floorPx - 19);
    bars[160] = bar(160, floorPx - 10, floorPx - 9);
    // pairPivots wide enough that the two deep lows, 140 noisy bars apart,
    // actually pair: the reach, not the cap, would otherwise be the subject.
    const c = { ...cfg(), maxLines: 1, minSpanBars: 5, pairPivots: 200 };
    const deep = (l: TrendLine) => l.i1 === 20 && l.i2 === 160;

    const { lines } = computeTrendlines(bars, c);
    expect(lines.find(deep)!.touches).toBe(2);
    expect(lines.find(deep)!.crossings).toBe(0);
    // Non-vacuous: "the cap binds," not "nothing needed to be evicted." MAX_LIVE
    // is fixed regardless of maxLines, so there is no longer an "uncapped"
    // maxLines value to compare a crowd against (100_000 saturates the live
    // set at MAX_LIVE same as any other value); this walk saturates the live
    // set at exactly 256 == MAX_LIVE instead (measured 2026-09-23), proving
    // eviction pressure here was real, not vacuous.
    expect(lines.length).toBe(MAX_LIVE);
    expect(lines.find(deep), "the long uncrossed line was evicted at birth").toBeDefined();
  });

  it("caps live state at MAX_LIVE in total, whatever Max Trendlines is", () => {
    // A zigzag with many pivots seeds far more than the cap.
    const bars = flat(400).map((_, i) =>
      bar(i, 99.5 + Math.sin(i / 3) * 4, 100.5 + Math.sin(i / 3) * 4));
    const one = computeTrendlines(bars, { ...cfg(), maxLines: 1, minSpanBars: 3 }).lines;
    const fifty = computeTrendlines(bars, { ...cfg(), maxLines: 50, minSpanBars: 3 }).lines;
    expect(one.length).toBeLessThanOrEqual(MAX_LIVE);
    expect(one.length).toBeGreaterThan(16); // non-vacuous: more than the old 16 x 1
    const key = (l: TrendLine) => `${l.i1}:${l.k1}:${l.i2}:${l.k2}`;
    expect(one.map(key)).toEqual(fifty.map(key));
  });
});

// THE SORT, and the reason touchGaps copies before it. touchIdxs is in
// INSERTION order (the retro pass appends touches found between the anchors
// AFTER i2), so a walk over it as given would measure negative gaps and report
// the anchor gap unsplit, rejecting exactly the well-spaced lines the Spacing
// settings exist to keep.
describe("computeTrendlines max distance", () => {
  // Flat bars close at 100 with ATR 1, so an ATR cut and a percent cut read
  // in the same units here: 1 ATR is 1% of price.
  //
  // A rising line through two swing LOWS at 90 and 94 (0.2 per bar) projects
  // to 94.4 on its confirm bar (42): 5.6 under the close, and it closes in
  // by 0.2 a bar, inside 3 by bar 55. THE LINE IS BUILT AND STAYS LIVE
  // THROUGHOUT; the cut only decides which bars it takes part on.
  const farLows = () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    return bars;
  };
  const has = (lines: TrendLine[], i1: number, i2: number) =>
    lines.some((l) => l.i1 === i1 && l.i2 === i2);

  // The spike bars at 20 and 40 lift ATR(14) well above 1 for a while, so the
  // ATR case reads its expectation off the ATR series bar by bar rather than
  // off the round numbers the percent case can use.
  it("keeps a far line live, and emits it only on the bars it is within the ATR cut", () => {
    const c = cfg({ maxDistAtr: 0.5 });
    const { lines, points, atr } = computeTrendlines(flat(80).map((b, i) => farLows()[i] ?? b), c);
    const line = lines.find((l) => l.i1 === 20 && l.i2 === 40)!;
    expect(line).toBeDefined();
    let hidden = 0;
    let shown = 0;
    for (let i = 42; i < 80; i++) {
      const within = Math.abs(projectAt(line, i) - 100) <= 0.5 * atr[i];
      expect(points[i].tl_1 !== undefined, `bar ${i}`).toBe(within);
      if (within) shown++;
      else hidden++;
    }
    expect(hidden).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
  });

  it("the percent cut reads the same way", () => {
    const { points } = computeTrendlines(farLows(), cfg({ maxDistPct: 3 }));
    expect(points[52].tl_1).toBeUndefined();
    expect(points[55].tl_1).toBeDefined();
  });

  it("applies the two cuts separately: the tighter one decides", () => {
    // At bar 42 the line is 5.6 away and ATR is about 9, so a wide ATR cut
    // admits it while a 3% cut does not, and a tight 0.5 ATR cut (about 4.6)
    // holds it back under a 6% cut that would admit it.
    expect(computeTrendlines(farLows(), cfg({ maxDistAtr: 6 })).points[42].tl_1).toBeDefined();
    expect(computeTrendlines(farLows(), cfg({ maxDistAtr: 6, maxDistPct: 3 })).points[42].tl_1).toBeUndefined();
    expect(computeTrendlines(farLows(), cfg({ maxDistAtr: 0.5, maxDistPct: 6 })).points[42].tl_1).toBeUndefined();
    expect(computeTrendlines(farLows(), cfg({ maxDistAtr: 6, maxDistPct: 6 })).points[42].tl_1).toBeDefined();
  });

  it("zero is off on both", () => {
    expect(computeTrendlines(farLows(), cfg({ maxDistAtr: 0, maxDistPct: 0 })).points[42].tl_1).toBeDefined();
  });

  // A rising line through two swing HIGHS at 101 and 103 (0.1 per bar) sits
  // 3.2 above the close on its confirm bar and runs away from flat price after
  // that: 5 above at bar 60. It leaves the emitted set the bar it strays past
  // the cut and is STILL LIVE, so price coming back would find it.
  const runaway = (n: number) => {
    const bars = flat(n);
    bars[20] = bar(20, 99.5, 101);
    bars[40] = bar(40, 99.5, 103);
    return bars;
  };

  it("stops emitting a line while it is past the cut, without dropping it", () => {
    const { lines, points } = computeTrendlines(runaway(61), cfg({ maxDistAtr: 4 }));
    expect(points[44].tl_1).toBeDefined();
    expect(points[60].tl_1).toBeUndefined();
    expect(has(lines, 20, 40)).toBe(true);
    // Off: Max Projection alone decides.
    expect(computeTrendlines(runaway(61), cfg()).points[60].tl_1).toBeDefined();
  });

  it("gates the drawn set the same way", () => {
    const c = cfg({ maxDistAtr: 4 });
    const { lines, atr } = computeTrendlines(runaway(61), c);
    const tol = maxDistanceTol(c, atr[60], 100);
    expect(lines.filter((l) => withinDistance(l, 60, 100, tol))).toHaveLength(0);
    expect(lines.filter((l) => withinDistance(l, 44, 100, maxDistanceTol(c, atr[44], 100)))).toHaveLength(1);
  });
});

describe("touchGaps", () => {
  it("measures the gaps in BAR order, not insertion order", () => {
    expect(touchGaps([10, 50])).toEqual({ widest: 40, narrowest: 40 });
    // Out of bar order, the way the detector records them: 20 and 20, not 40
    // and -20.
    expect(touchGaps([10, 50, 30])).toEqual({ widest: 20, narrowest: 20 });
    expect(touchGaps([10, 12, 50])).toEqual({ widest: 38, narrowest: 2 });
  });

  it("does not reorder the array it was given", () => {
    const idxs = [10, 50, 30];
    touchGaps(idxs);
    expect(idxs).toEqual([10, 50, 30]);
  });

  // THE GUARD THAT MUST NOT BE ZERO. No-gap is widest 0 and narrowest Infinity,
  // because a floor compares the other way round: 0 would be under every floor
  // above zero and would silence every line that took the guard path.
  it("reports fewer than two touches as widest 0 and narrowest Infinity, never 0 for both", () => {
    expect(touchGaps([])).toEqual({ widest: 0, narrowest: Infinity });
    expect(touchGaps([7])).toEqual({ widest: 0, narrowest: Infinity });
  });
});

// END TO END through the detector, not through isMajor alone: a ceiling
// SILENCES a line (no operand reads it, nothing is drawn) but must leave it in
// live state, where it goes on collecting touches for the lines around it.
// touches and span only ever grow, so a deleted line could never come back.
describe("the ceilings silence without destroying", () => {
  const emits = (bars: KLineData[], c: TrendlinesConfig): boolean =>
    computeTrendlines(bars, c).points.some((p) => p.tl_1 !== undefined);

  it("silences a line past Max Span without destroying it", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    expect(emits(bars, cfg())).toBe(true);
    expect(emits(bars, cfg({ maxSpanBars: 40 }))).toBe(true);
    expect(emits(bars, cfg({ maxSpanBars: 39 }))).toBe(false);
    const { lines } = computeTrendlines(bars, cfg({ maxSpanBars: 39 }));
    const over = lines.find((l) => l.lastTouchIdx - l.i1 >= 40);
    expect(over, "the 40-bar line must still be in live state").toBeDefined();
    expect(isMajor(over as TrendLine, bars.length - 1, cfg({ maxSpanBars: 39 }))).toBe(false);
  });

  // Lookback DROPS rather than silences: age only grows, so a line past it
  // can never qualify again, and no older pivot may seed a new one.
  it("drops a line once its first anchor is older than Lookback", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    const L = 50;
    const { points, lines } = computeTrendlines(bars, cfg({ lookbackBars: L }));
    expect(lines.some((l) => l.i1 === 20)).toBe(false);
    // The bar-60 low confirms at 62, when bar 20 is already 42 bars back, so
    // the line emits until bar 20 + L and never after.
    expect(points[20 + L].tl_1).toBeDefined();
    expect(points.slice(20 + L + 1).every((p) => p.tl_1 === undefined)).toBe(true);
    expect(computeTrendlines(bars, cfg({ lookbackBars: 30 })).points.some((p) => p.tl_1 !== undefined)).toBe(false);
    expect(computeTrendlines(bars, cfg({ lookbackBars: 0 })).lines.some((l) => l.i1 === 20)).toBe(true);
  });

  it("matches the incremental session under Lookback", () => {
    const bars = walk(400);
    const c = cfg({ lookbackBars: 60, maxLines: 6 });
    const ref = computeTrendlines(bars, c);
    const inc = createTrendlinesSession().compute(bars, c);
    expect(inc.lines).toEqual(ref.lines);
    expect(inc.points).toEqual(ref.points);
    expect(ref.lines.every((l) => bars.length - 1 - l.i1 <= 60)).toBe(true);
  });

  it("silences a line past Max Touches without destroying it", () => {
    // Three dips on one rising line: the pair plus a third pivot touching it.
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 92, 100.5);
    bars[60] = bar(60, 94, 100.5);
    expect(emits(bars, cfg({ minTouches: 3 }))).toBe(true);
    expect(emits(bars, cfg({ minTouches: 3, maxTouches: 3 }))).toBe(true);
    expect(emits(bars, cfg({ minTouches: 3, maxTouches: 2 }))).toBe(false);
    const c = cfg({ minTouches: 3, maxTouches: 2 });
    const { lines } = computeTrendlines(bars, c);
    const over = lines.find((l) => l.touches >= 3);
    expect(over, "the three-touch line must still be in live state").toBeDefined();
    expect(overCeilings(over as TrendLine, c)).toBe(true);
    expect(isMajor(over as TrendLine, bars.length - 1, c)).toBe(false);
  });

  it("silences a line whose touches sit further apart than Max Touch Spacing", () => {
    // One pair, 40 bars apart and nothing in between, so the spacing IS the
    // anchor gap.
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[60] = bar(60, 94, 100.5);
    expect(emits(bars, cfg())).toBe(true);
    expect(emits(bars, cfg({ maxTouchSpacing: 40 }))).toBe(true);
    expect(emits(bars, cfg({ maxTouchSpacing: 39 }))).toBe(false);
    const c = cfg({ maxTouchSpacing: 39 });
    const { lines } = computeTrendlines(bars, c);
    const over = lines.find((l) => l.maxTouchGap === 40);
    expect(over, "the wide-gap line must still be in live state").toBeDefined();
    expect(isMajor(over as TrendLine, bars.length - 1, c)).toBe(false);
  });
});

describe("selectDrawnLines", () => {
  const mk = (i1: number, i2: number, p1: number, p2: number, touches = 2): TrendLine => ({
    i1, p1, k1: "low", i2, p2, k2: "low", touches,
    touchIdxs: [i1, i2], touchKinds: ["low", "low"], lastTouchIdx: i2,
    crossings: 0, crossIdxs: [], lastSign: 0, maxTouchGap: i2 - i1, minTouchGap: i2 - i1, maxTouchIdx: i2,
  });
  const rank = (ls: TrendLine[]) => ls.slice().sort(rankLines);
  const strong = mk(0, 40, 100, 100, 5);
  const mid = mk(0, 40, 90, 90, 3);
  const weak = mk(0, 40, 80, 80, 2);
  const lines = [weak, strong, mid];

  it("draws the top maxLines by rank, in rank order", () => {
    expect(selectDrawnLines(lines, 50, 79, 2, null)).toEqual([strong, mid]);
  });
  // THE DRAWN SET IS THE EMITTED SET. With no declutter and no merge, the two
  // cuts read the same rank order with the same budget, so `weak` being the
  // nearest-to-close operand buys it nothing: it is outside maxLines 1 and it
  // does not draw. The exemption that used to add it back is gone, because it
  // made the budget a floor rather than a cap.
  it("does not add back an operand's line that falls outside the budget", () => {
    expect(selectDrawnLines(lines, 50, 79, 1, null)).toEqual([strong]);
  });
  it("keeps a pinned line whatever its rank", () => {
    expect(selectDrawnLines(lines, 50, 79, 1, { tol: 0, keep: new Set([weak]) })).toEqual([strong, weak]);
  });
  // MONOTONE IN THE MERGE TOLERANCE. The cap reads a FIXED per-bar ordering,
  // so removing a line can only move the rest UP their bars' orderings.
  // Widening the tolerance therefore removes the twin it targets and nothing
  // else: D, which shares no bar with the twin, does not move.
  it("widening the merge tolerance never removes a line that is not near a kept one", () => {
    const a = mk(0, 40, 100, 100, 5);
    const bTwin = mk(10, 50, 100.2, 100.2, 4);
    const c = mk(10, 60, 80, 80, 3);
    const d = mk(70, 90, 70, 70, 2);
    const ranked = [a, bTwin, c, d];
    // C is second at bar 10, so a cap of 1 drops it; A, its twin and D pass.
    expect(selectLevels(ranked, 100, 0, 1, 0)).toEqual([a, bTwin, d]);
    // Merging the twin into A leaves bar 10 to C alone, so C comes back and D,
    // which shares no bar with the twin, does not move. Widening the merge
    // moves the cap's orderings UP and never down.
    expect(selectLevels(ranked, 100, 1, 1, 0)).toEqual([a, c, d]);
  });
  // RELAXING THE CAP ONLY EVER ADDS. The greedy tally it replaced was not
  // monotone: L5 below survives a cap of 1 and is lost at a cap of 2, because
  // L2 and L4, both capped out at 1, jointly fill bar 60 at 2.
  it("raising the per-pivot cap never removes a level", () => {
    const l1 = mk(0, 40, 100, 100, 5);
    const l2 = mk(0, 60, 90, 90, 4);
    const l3 = mk(10, 50, 80, 80, 3);
    const l4 = mk(10, 60, 70, 70, 2);
    const l5 = mk(60, 90, 60, 60, 2);
    const ranked = [l1, l2, l3, l4, l5];
    const one = selectLevels(ranked, 100, 0, 1, 0);
    const two = selectLevels(ranked, 100, 0, 2, 0);
    const three = selectLevels(ranked, 100, 0, 3, 0);
    // The greedy tally kept L1, L3, L5 at 1 and lost L5 at 2, because L2 and
    // L4 (both capped out at 1) jointly filled bar 60. Under the top-N test
    // L5 is third at bar 60 at every cap below 3, so it is never taken away.
    expect(one).toEqual([l1, l3]);
    expect(two).toEqual([l1, l2, l3, l4]);
    expect(three).toEqual([l1, l2, l3, l4, l5]);
    for (const line of one) expect(two).toContain(line);
    for (const line of two) expect(three).toContain(line);
  });
  // A LEVEL ALWAYS DRAWS ITS BEST-RANKED MEMBER, whatever the cap. `best`
  // outranks `standIn` and they are the same level, so the level is `best`
  // and needs the cap `best` needs: third at bar 20, so 3. Picking whichever
  // member fits soonest would redraw the level at 3, moving a line already on
  // screen: on GOLD 1D the resistance into 2026-08-25 jumped its left anchor
  // between a cap of 3 and 4 that way.
  it("a level draws its best-ranked member at every cap", () => {
    const x1 = mk(20, 40, 50, 50, 5);
    const x2 = mk(20, 50, 40, 40, 4);
    const best = mk(20, 60, 100, 100, 3);
    const standIn = mk(30, 70, 100.2, 100.2, 2);
    const ranked = [x1, x2, best, standIn];
    expect(selectLevels(ranked, 100, 1, 2, 0)).toEqual([x1, x2]);
    expect(selectLevels(ranked, 100, 1, 3, 0)).toEqual([x1, x2, best]);
    expect(selectLevels(ranked, 100, 1, 9, 0)).toEqual([x1, x2, best]);
    // Cap off: same line, nothing to compare.
    expect(selectLevels(ranked, 100, 1, 0, 0)).toEqual([x1, x2, best]);
  });
  // A DEAD LINE IS NOT IN THE POOL. Past Max Projection a line is gone rather
  // than hidden, so it must not take a slot: capped with the stale line still
  // in the pool, A took bar 40 and D vanished with it, and a busy pivot whose
  // best lines had gone stale showed nothing at all.
  it("a stale line does not hold its pivots' slots against a drawable one", () => {
    const a = mk(0, 40, 100, 100, 5);
    const d = mk(40, 90, 101, 101, 2);
    const c = cfg({ maxPerPivot: 1, maxProjBars: 100, maxLines: 5 });
    const stale = rank(poolable([d, a], 150, c));
    expect(stale).toEqual([d]);
    expect(selectLevels(stale, 150, 0, 1, 0)).toEqual([d]);
    const live = rank(poolable([d, a], 100, c));
    expect(live).toEqual([a, d]);
    expect(selectLevels(live, 100, 0, 1, 0)).toEqual([a]);
  });
  // VISIBLE LINES ONLY. A (bars 0,40) outranks C (40,60) which outranks D
  // (60,90); a cap of 1 leaves A alone. Tightening Max Distance onto A removes
  // A and promotes C into the slot it left: the cap counts only gate-passing
  // levels. The price is the other direction, where relaxing the cut takes C
  // away again.
  it("tightening Max Distance promotes a line the cap had dropped", () => {
    const a = mk(0, 40, 150, 150, 5);
    const c = mk(40, 60, 100, 100, 3);
    const d = mk(60, 90, 101, 101, 2);
    const wide = cfg({ maxPerPivot: 1, maxDistAtr: 0, maxLines: 5 });
    const pool = rank([d, c, a]);
    expect(pool).toEqual([a, c, d]);
    expect(selectLevels(pool.filter(trendlineGate(100, 100, 1, wide)), 100, 0, 1, 0)).toEqual([a]);
    const tight = { ...wide, maxDistAtr: 2 };
    expect(selectLevels(pool.filter(trendlineGate(100, 100, 1, tight)), 100, 0, 1, 0)).toEqual([c]);
  });
  it("a filtered-out level holds no per-pivot slot", () => {
    // A outranks B and shares its only bar, but A fails the gate, so B draws
    // at a cap of 1. Under pool-counting B would need a cap of 2.
    const a = mk(0, 40, 150, 150, 5);
    const b = mk(0, 40, 100, 100, 2);
    const wide = cfg({ maxPerPivot: 1, maxDistAtr: 0, maxLines: 5 });
    const pool = rank([b, a]);
    expect(pool).toEqual([a, b]);
    const tight = { ...wide, maxDistAtr: 2 };
    expect(selectLevels(pool.filter(trendlineGate(100, 100, 1, tight)), 100, 0, 1, 0)).toEqual([b]);
  });
  it("a pinned level that fails the gate holds no slot either", () => {
    // Pinning A keeps it on the chart, but the emit step knows nothing of
    // pins and emits B. If the pin held A's slot, B would be capped off the
    // chart while still emitting: the drawn set minus pins must equal the
    // emitted set.
    const a = mk(0, 40, 150, 150, 5);
    const b = mk(0, 40, 100, 100, 2);
    const tight = cfg({ maxPerPivot: 1, maxDistAtr: 2, maxLines: 5 });
    const pool = rank([b, a]);
    const gate = trendlineGate(100, 100, 1, tight);
    const emitted = selectDrawnLines(pool, 100, 100, 5, { tol: 0, keep: new Set(), perPivot: 1, pass: gate });
    expect(emitted).toEqual([b]);
    const drawn = selectDrawnLines(pool, 100, 100, 5, { tol: 0, keep: new Set([a]), perPivot: 1, pass: gate });
    expect(drawn).toEqual([a, b]);
    expect(drawn.filter((l) => l !== a)).toEqual(emitted);
    expect(pivotDepths(pool.filter(gate), 100, 0).get(40)).toBe(1);
  });
  describe("pivotDepths", () => {
    // The debug number counts what the cap reads: gate-passing levels only,
    // one slot per level no matter how many members it merged.
    it("counts counted levels per bar, and nothing else", () => {
      const a = mk(0, 40, 150, 150, 5);
      const c = mk(40, 60, 100, 100, 3);
      const d = mk(60, 90, 101, 101, 2);
      const wide = cfg({ maxPerPivot: 1, maxDistAtr: 0, maxLines: 5 });
      const pool = rank([d, c, a]);
      const pass = trendlineGate(100, 100, 1, wide);
      const depths = pivotDepths(pool.filter(pass), 100, 0);
      // Bar 40 carries A and C; bar 60 carries C and D; the anchors stand alone.
      expect(depths.get(0)).toBe(1);
      expect(depths.get(40)).toBe(2);
      expect(depths.get(60)).toBe(2);
      expect(depths.get(90)).toBe(1);
      expect(depths.has(100)).toBe(false);
    });
    it("a filtered-out level leaves no depth behind", () => {
      const a = mk(0, 40, 150, 150, 5);
      const b = mk(0, 40, 100, 100, 2);
      const wide = cfg({ maxPerPivot: 1, maxDistAtr: 0, maxLines: 5 });
      const pool = rank([b, a]);
      const tight = { ...wide, maxDistAtr: 2 };
      const depths = pivotDepths(pool.filter(trendlineGate(100, 100, 1, tight)), 100, 0);
      expect(depths.get(0)).toBe(1);
      expect(depths.get(40)).toBe(1);
    });
    it("a merged-away member adds no depth of its own", () => {
      // Twin of mid within tolerance: one level, so depth 1 at the shared bars
      // even though two lines run through them.
      const twin = { ...mid, i1: 0, p1: 90, i2: 40, p2: 90.5, touches: 3 };
      const pool = rank([twin, mid, strong]);
      const depths = pivotDepths(pool, 50, 1);
      expect(depths.get(0)).toBe(2);
      expect(depths.get(40)).toBe(2);
    });
    it("a bar named twice by one line counts once", () => {
      const twice: TrendLine = { ...strong, touchIdxs: [0, 40, 40], touchKinds: ["low", "low", "low"] };
      const pool = rank([twice]);
      expect(pivotDepths(pool, 50, 0).get(40)).toBe(1);
    });
  });
  it("Max Trendlines caps drawn lines, not candidates", () => {
    const ls = [mk(0, 40, 100, 100, 6), mk(0, 40, 90, 90, 5), mk(0, 40, 80, 80, 4), mk(0, 40, 70, 70, 3), mk(0, 40, 60, 60, 2)];
    expect(selectDrawnLines(ls, 50, 79, 3, { tol: 0, keep: new Set() })).toEqual(ls.slice(0, 3));
    expect(selectDrawnLines(ls, 50, 79, 9, { tol: 0, keep: new Set() })).toEqual(ls);
  });

  it("a line failing the gate never takes a slot, whatever its rank", () => {
    const far = mk(0, 40, 150, 150, 9);
    const near1 = mk(0, 40, 101, 101, 3);
    const near2 = mk(10, 50, 99, 99, 2);
    const c = cfg({ maxDistAtr: 2, maxLines: 2 });
    const pass = trendlineGate(100, 100, 1, c);
    expect(selectDrawnLines([far, near1, near2], 100, 100, 2, { tol: 0, keep: new Set(), pass })).toEqual([near1, near2]);
  });

  it("a gate-failing pin does not swallow a passing twin", () => {
    // Twins at merge tol 1 (0.7 apart, flat, same start). The pin is 2.5 from
    // the close and fails Max Distance 2; the twin is 1.8 away and passes.
    const pin = mk(0, 40, 102.5, 102.5, 5);
    const twin = mk(0, 40, 101.8, 101.8, 2);
    const pass = trendlineGate(100, 100, 1, cfg({ maxDistAtr: 2 }));
    const emitted = selectDrawnLines([pin, twin], 100, 100, 5, { tol: 1, keep: new Set(), pass });
    expect(emitted).toEqual([twin]);
    const drawn = selectDrawnLines([pin, twin], 100, 100, 5, { tol: 1, keep: new Set([pin]), pass });
    expect(drawn).toEqual([pin, twin]);
    expect(drawn.filter((l) => l !== pin)).toEqual(emitted);
  });

  it("the early stop equals the full walk cut to Max Trendlines", () => {
    let s = 7;
    const rnd = (n: number) => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s % n;
    };
    for (let trial = 0; trial < 200; trial++) {
      const ls: TrendLine[] = [];
      for (let k = 0; k < 30; k++) {
        const i1 = rnd(8) * 5;
        const i2 = i1 + 5 + rnd(8) * 5;
        ls.push(mk(i1, i2, 90 + rnd(20), 90 + rnd(20), 2 + rnd(4)));
      }
      const ranked = rank(ls);
      const tol = rnd(3);
      const perPivot = rnd(4);
      const full = selectLevels(ranked, 100, tol, perPivot, 0);
      for (const n of [1, 2, 3, 5, 8]) {
        expect(selectLevels(ranked, 100, tol, perPivot, n)).toEqual(full.slice(0, n));
      }
    }
  });

  it("merges near-twins through a shared pivot before the budget", () => {
    const twin = { ...mid, i1: 0, p1: 90, i2: 40, p2: 90.5, touches: 3 };
    const out = selectDrawnLines([strong, mid, twin], 50, 79, 3, { tol: 1, keep: new Set() });
    expect(out).toEqual([strong, mid]);
  });

  // THE ONE PLACE THE DRAWN SET AND THE EMITTED SET DIVERGE, and it is the
  // user's own doing. Max lines per pivot 1 is the old "One line per pivot",
  // so a twin sharing a pivot goes even though it sits inside maxLines and is
  // therefore one of the ranked operands on this bar. The operand keeps
  // emitting; only the line leaves the chart.
  it("declutter by pivot removes a twin that is itself an emitted operand", () => {
    // Anchored off `strong`'s bars, so the only shared pivot on the pane is
    // the one these two have with each other.
    const pair = mk(5, 45, 90, 90, 3);
    const twin = { ...pair, p2: 95 };
    const all = [strong, pair, twin];
    // Premise: with no declutter all three draw, so the twin IS an emitted
    // rank (tl_1..tl_3 at maxLines 3), not a line nobody reads.
    expect(selectDrawnLines(all, 50, 79, 3, null)).toHaveLength(3);
    expect(
      selectDrawnLines(all, 50, 79, 3, { tol: 0, keep: new Set(), perPivot: 1 }),
    ).toEqual([strong, pair]);
  });

});

describe("selectDrawnLines dedup", () => {
  const NONE: ReadonlySet<TrendLine> = new Set();
  // A fan out of one pivot: both start at bar 0 / price 90, which is what a
  // swing pairing with two later swings produces. Read at bar 100. fanA
  // outranks fanB on touches alone, so which one survives a merge is
  // unambiguous under the rank-ordered budget.
  const fanA: TrendLine = {
    ...sup,
    i1: 0,
    p1: 90,
    i2: 50,
    p2: 94,
    touches: 5,
    touchIdxs: [0, 50],
    lastTouchIdx: 50,
  };
  const fanB: TrendLine = {
    ...sup,
    i1: 0,
    p1: 90,
    i2: 40,
    p2: 93.3,
    touches: 3,
    touchIdxs: [0, 40],
    lastTouchIdx: 40,
  };

  it("merges two lines out of the same pivot that land together", () => {
    expect(projectAt(fanA, 100)).toBeCloseTo(98, 6);
    expect(projectAt(fanB, 100)).toBeCloseTo(98.25, 6);
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toEqual([fanA]);
  });

  it("with a per-pivot cap of one, keeps one line per pivot: the top-ranked survivor", () => {
    // What Max lines per pivot 1 runs: the three-through-one-swing case no
    // tolerance a pane can afford would collapse.
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touches: 5, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const mid: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 86, touches: 3, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touches: 2, touchIdxs: [0, 50], lastTouchIdx: 50 };
    expect(
      selectDrawnLines([mid, far, near], 100, 100, 3, { tol: 0, keep: NONE, perPivot: 1 }),
    ).toEqual([near]);
    // A cap of two keeps the best two through the swing.
    expect(
      selectDrawnLines([mid, far, near], 100, 100, 3, { tol: 0, keep: NONE, perPivot: 2 }),
    ).toEqual([near, mid]);
  });

  it("the cap counts a pinned line, and composes with the tolerance", () => {
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touches: 5, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const mid: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 86, touches: 3, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touches: 2, touchIdxs: [0, 50], lastTouchIdx: 50 };
    // near is pinned: exempt from the drop, but it still fills one of the
    // two seats at bar 0, so far (third through it) goes.
    expect(
      selectDrawnLines([near, mid, far], 100, 100, 3, { tol: 0, keep: new Set([near]), perPivot: 2 }),
    ).toEqual([near, mid]);
    // Cap 2 alone keeps fanA and fanB; with a 1-point tolerance they are the
    // same trend and fanB goes: both cuts apply.
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, { tol: 0, keep: NONE, perPivot: 2 }),
    ).toEqual([fanA, fanB]);
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, { tol: 1, keep: NONE, perPivot: 2 }),
    ).toEqual([fanA]);
  });

  it("with no tolerance, still spares a pinned line", () => {
    const near: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touches: 3, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const far: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 81, touches: 2, touchIdxs: [0, 50], lastTouchIdx: 50 };
    expect(
      selectDrawnLines([near, far], 100, 100, 3, { tol: 0, keep: new Set([far]), perPivot: 1 }),
    ).toEqual([near, far]);
  });

  it("with no tolerance, leaves lines that share no pivot alone", () => {
    // Not a distance cut: two unrelated levels both stay, however far apart.
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touches: 3, touchIdxs: [0, 50], lastTouchIdx: 50 };
    const b: TrendLine = { ...sup, i1: 10, p1: 60, i2: 60, p2: 62, touches: 2, touchIdxs: [10, 60], lastTouchIdx: 60 };
    expect(
      selectDrawnLines([a, b], 100, 100, 3, { tol: 0, keep: NONE, perPivot: 1 }),
    ).toEqual([a, b]);
  });

  it("merges a fan that closes onto a shared second pivot", () => {
    // Different starts, same end: they meet at bar 50 and separate again after
    // it. Same clutter, so the same treatment.
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 94, touchIdxs: [0, 50] };
    const b: TrendLine = { ...sup, i1: 20, p1: 92, i2: 50, p2: 94, touchIdxs: [20, 50] };
    expect(
      selectDrawnLines([a, b], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("merges a chain, where one line's end is the other's start", () => {
    const a: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 94, touchIdxs: [0, 50] };
    const b: TrendLine = { ...sup, i1: 50, p1: 94, i2: 70, p2: 95.6, touchIdxs: [50, 70] };
    expect(projectAt(a, 100)).toBeCloseTo(98, 6);
    expect(projectAt(b, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines([a, b], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("leaves two lines alone that only cross today, however close they land", () => {
    // Identical projection at the last bar, but far apart where the younger
    // one started: two trends meeting, not one trend drawn twice.
    const other: TrendLine = { ...sup, i1: 20, p1: 70, i2: 60, p2: 84, touchIdxs: [20, 60] };
    expect(projectAt(other, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines([fanA, other], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
    // Sharing a bar does not change that: fanA and this line both start at
    // bar 0, twenty points apart, and only converge on today's bar.
    const sameBar: TrendLine = { ...sup, i1: 0, p1: 70, i2: 50, p2: 84, touchIdxs: [0, 50] };
    expect(projectAt(sameBar, 100)).toBeCloseTo(98, 6);
    expect(
      selectDrawnLines([fanA, sameBar], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
  });

  // THE RULE: the same trend drawn twice. Close where the younger line starts
  // and close today, so close everywhere between; a shared pivot is neither
  // needed nor enough.
  it("merges two near-parallel lines out of different swings", () => {
    const parallel: TrendLine = {
      ...sup,
      i1: 10,
      p1: 91.3,
      i2: 60,
      p2: 95.3,
      touches: 2,
      touchIdxs: [10, 60],
      lastTouchIdx: 60,
    };
    expect(sameTrend(fanA, parallel, 100, 1)).toBe(true);
    expect(sameTrend(fanA, parallel, 100, 0.4)).toBe(false);
    expect(
      selectDrawnLines([fanA, parallel], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toEqual([fanA]);
  });

  it("merges two lines that touch the same pivot and run together", () => {
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
      selectDrawnLines([a, b], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(1);
  });

  it("stops merging once the two ends are further apart than tol", () => {
    const wide: TrendLine = { ...sup, i1: 0, p1: 90, i2: 50, p2: 95, touchIdxs: [0, 50] };
    expect(projectAt(wide, 100)).toBeCloseTo(100, 6);
    expect(
      selectDrawnLines([fanA, wide], 100, 100, 3, { tol: 1, keep: NONE }),
    ).toHaveLength(2);
  });

  it("a merged-away line frees its Max Trendlines slot for a different line", () => {
    const other: TrendLine = {
      ...sup,
      i1: 5,
      p1: 60,
      i2: 55,
      p2: 60,
      touches: 1,
      touchIdxs: [5, 55],
      lastTouchIdx: 55,
    };
    // Max Trendlines is the LAST cut, after the merge. With no merge the two
    // fan lines fill both slots. Merged, they are one level, so the second
    // slot goes to `other`.
    expect(
      selectDrawnLines([fanA, fanB, other], 100, 100, 2, null),
    ).toEqual([fanA, fanB]);
    expect(
      selectDrawnLines(
        [fanA, fanB, other],
        100,
        100,
        2,
        { tol: 1, keep: NONE },
      ),
    ).toEqual([fanA, other]);
  });

  it("never merges away a pinned line, which owns the only handle to undo it", () => {
    // fanB is pinned here: it would otherwise merge into the higher-ranked
    // fanA, and the pin is what spares it.
    expect(
      selectDrawnLines(
        [fanA, fanB],
        100,
        100,
        3,
        { tol: 1, keep: new Set([fanB]) },
      ),
    ).toEqual([fanA, fanB]);
  });

  it("is off at tol 0, so an unwarmed ATR cannot silently thin the chart", () => {
    expect(
      selectDrawnLines([fanA, fanB], 100, 100, 3, { tol: 0, keep: NONE }),
    ).toHaveLength(2);
    expect(mergeTolerance(cfg(), undefined, 100)).toBe(0);
    expect(mergeTolerance(cfg(), null, 100)).toBe(0);
    expect(mergeTolerance(cfg(), NaN, 100)).toBe(0);
    expect(mergeTolerance(cfg({ mergeAtr: 0 }), 4, 100)).toBe(0);
    expect(mergeTolerance(cfg(), 4, 100)).toBe(4 * TL_DEDUPE_ATR);
  });

  // THE SLOTS. mergeAtr scales the bar's ATR, mergePct the close, and the
  // tighter one is the band; Max lines per pivot is not a tolerance and
  // leaves the band alone.
  it("takes the band from the config, the tighter of ATR and percent", () => {
    expect(mergeTolerance(cfg({ mergeAtr: 2 }), 4, 100)).toBe(8);
    expect(mergeTolerance(cfg({ mergeAtr: 0, mergePct: 2 }), 4, 100)).toBe(2);
    expect(mergeTolerance(cfg({ mergeAtr: 2, mergePct: 2 }), 4, 100)).toBe(2);
    expect(mergeTolerance(cfg({ mergeAtr: 2, mergePct: 10 }), 4, 100)).toBe(8);
    expect(mergeTolerance(cfg({ mergeAtr: 0, mergePct: 2 }), undefined, 100)).toBe(2);
    expect(mergeTolerance(cfg({ maxPerPivot: 1 }), 4, 100)).toBe(4 * TL_DEDUPE_ATR);
    expect(mergeTolerance(cfg({ maxPerPivot: 1, mergeAtr: 0 }), undefined, 100)).toBe(0);
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
  it("defaults to a quarter ATR, never more than half the near-price band", () => {
    expect(TL_DEDUPE_ATR).toBe(0.25);
    expect(TL_DEDUPE_ATR).toBeLessThanOrEqual(TL_NEAR_PRICE_ATR / 2);
  });
});

describe("TRENDLINES_TEMPLATE", () => {
  it("declares the seventeen calcParams in TRENDLINES_DEFAULTS key order", () => {
    expect(TRENDLINES_TEMPLATE.calcParams).toEqual(Object.values(TRENDLINES_DEFAULTS));
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
      calcParams: [2, 0.75, 2, 5, 250, 3],
      extendData: {},
    } as never) as TrendlinesCalcPoint[];
    expect(rows).toHaveLength(60);
    expect(rows[rows.length - 1].lines).toBeDefined();
    expect(rows[0].lines).toBeUndefined();
  });

  // A hidden instance is dead weight: klinecharts re-runs calc on EVERY tick
  // regardless of `visible` (it gates the draw pass alone), and this detector is
  // the most expensive calc on the chart.
  it("computes nothing while the indicator is hidden", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const prior = [{ timestamp: 1 }] as unknown as TrendlinesCalcPoint[];
    const rows = hiddenAware(TRENDLINES_TEMPLATE).calc!(bars, {
      calcParams: [2, 0.75, 2, 5, 250, 3],
      extendData: {},
      visible: false,
      result: prior,
    } as never) as TrendlinesCalcPoint[];
    // The PRIOR rows, by identity: calcImp reassigns whatever calc returns, so
    // returning the same array leaves .result untouched. Returning [] instead
    // would wipe an indicator that is merely out of sight.
    expect(rows).toBe(prior);
  });

  // The other half of the gate: unhiding has to produce the same rows an
  // always-visible instance would have. klinecharts recalcs on any
  // overrideIndicator (its deep-cloned _prevIndicator makes the default
  // shouldUpdate's `prev.figures !== current.figures` always true), so the eye
  // click itself is the trigger -- no stale pane after a hidden stretch.
  it("catches up to a visible twin's rows once shown again", () => {
    const bars = flat(60);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    const params = [2, 0.75, 2, 5, 250, 3];
    const calc = hiddenAware(TRENDLINES_TEMPLATE).calc!;
    const hidden = { calcParams: params, extendData: {}, visible: false, result: [] };
    const shown = { calcParams: params, extendData: {}, visible: true, result: [] };
    // Ticks arrive while it is hidden: same instance object each time, which is
    // what the per-instance session cache is keyed on.
    for (let i = 10; i <= 60; i += 10) {
      calc(bars.slice(0, i), hidden as never);
      calc(bars.slice(0, i), shown as never);
    }
    hidden.visible = true;
    const after = calc(bars, hidden as never) as TrendlinesCalcPoint[];
    const twin = calc(bars, shown as never) as TrendlinesCalcPoint[];
    expect(after.filter((p) => p.tl_1 !== undefined).length).toBeGreaterThan(5);
    expect(after).toEqual(twin);
  });

  // THE constraint that makes `extend` safe to expose. Decluttering the chart
  // must not silently change a strategy that reads a ranked operand, so calc
  // reads calcParams and NOTHING from extendData. Worth pinning rather than
  // assuming:
  // SR_LEVELS' calc does pass its extendData into compute, so the pattern next
  // door is exactly the one that would break this.
  it("emits identical values under every extend mode", () => {
    const bars = flat(80);
    bars[20] = bar(20, 90, 100.5);
    bars[40] = bar(40, 94, 100.5);
    bars[60] = bar(60, 80, 100.5);
    const params = [2, 0.75, 2, 5, 250, 3];
    const run = (extend?: string): TrendlinesCalcPoint[] =>
      TRENDLINES_TEMPLATE.calc!(bars, {
        calcParams: params,
        extendData: { extend },
      } as never) as TrendlinesCalcPoint[];
    const ray = run("ray");
    // Non-triviality: an all-empty series would compare equal while proving
    // nothing.
    expect(
      ray.filter((p) => p.tl_1 !== undefined).length,
    ).toBeGreaterThan(10);
    expect(run("segment")).toEqual(ray);
    expect(run("extended")).toEqual(ray);
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
  width?: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dashed: boolean;
  /** The opacity the stroke was painted at: full for a live line, the dim
   * alpha for a stale or well-touched one. */
  alpha: number;
}

/** A recorded fillText call: the ×N tag and where it landed. */
interface Tag {
  text: string;
  x: number;
  y: number;
}

/** A recorded arc call other than a touch ring. Nothing in the draw path
 * paints one any more (there is no break dot), so this stays empty; kept for
 * structural equality against the Painted shape below. */
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
  /** ctx.strokeStyle read back at every stroke() call: the line itself, its
   * touch rings, and its handle. One colour for the whole pane now, so every
   * entry should read TL_LINE_COLOR. */
  strokeColors: string[];
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
  // The Declutter select. Absent leaves the key off entirely, which is how the
  // tests above exercise the legacy `nearPrice` fallback the draw path keeps.
  declutter?: "off" | "near" | "pivot",
  // The two dim thresholds. Absent leaves both keys off, so every test above
  // paints at the alphas it always did.
  dim?: {
    dimTouches?: number;
    dimStaleBars?: number;
    dimOpacity?: number;
  },
  // OFF by default here, ON in the app — the same deal dedupe and nearPrice
  // have, and for the same reason: the carets are strokes, so with them on
  // every segment count below would be counting pivots as well as lines.
  // "default" omits the key, which is how the test for the default-off
  // behaviour exercises the draw path's own fallback.
  showPivots: boolean | "default" = false,
  // The line-pivot marks (showLinePivots). OFF by default here but ON in the
  // app, the mirror of showPivots above; "default" omits the key so the draw
  // path's own fallback is what the default test exercises.
  showLinePivots: boolean | "default" = false,
  // Simulates the shared canvas context arriving already dashed, the way a
  // price line or alert line leaves it: OFF by default (a fresh dash-free
  // ctx, same as every test above), ON exercises the one test that checks
  // drawTrendlines resets it itself rather than inheriting the leftover state.
  arriveDashed = false,
  // extendData.lineColor: render-only override for every stroke/fill this
  // instance paints. Absent leaves the key off entirely, exercising the draw
  // path's own TL_LINE_COLOR fallback.
  lineColor?: string,
  // extendData.lineWidth / lineStyle / lineOpacity: the rest of the
  // render-only style block, spread in as given.
  styleExt: Record<string, unknown> = {},
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
  const strokeColors: string[] = [];
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
    stroke: () => {
      strokeColors.push(ctx.strokeStyle as string);
    },
    setLineDash: (d: number[]) => {
      dashed = d.length > 0;
    },
    moveTo: (x: number, y: number) => {
      cur = { x, y };
      start = { x, y };
    },
    lineTo: (x: number, y: number) => {
      const seg = { x0: cur.x, y0: cur.y, x1: x, y1: y, dashed, alpha: ctx.globalAlpha, width: ctx.lineWidth };
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
    // The tag's halo. Recorded nowhere: fillText is the tag's position of
    // record, and the halo lands at the same point.
    strokeText: () => {},
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
  // Leave the ctx dashed BEFORE draw runs, exactly as the previous drawer
  // (a price line or alert line) would: this only proves anything if
  // drawTrendlines resets it itself.
  if (arriveDashed) ctx.setLineDash([4, 3]);
  const ext = {
    extend,
    pinned,
    ...(dedupe === "default" ? {} : { dedupe }),
    ...(nearPrice === "default" ? {} : { nearPrice }),
    ...(declutter ? { declutter } : {}),
    ...(dim ?? {}),
    ...(showPivots === "default" ? {} : { showPivots }),
    ...(showLinePivots === "default" ? {} : { showLinePivots }),
    ...(lineColor ? { lineColor } : {}),
    ...styleExt,
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
  return { segments, tags, marks, touchMarks, handleStrokes, strokeColors };
}

describe("TRENDLINES_TEMPLATE.draw", () => {
  const bars = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };
  const params = (maxLines: number): number[] => [2, 0.75, 2, 5, 250, maxLines];

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
      2, 0.75, minTouches, minSpanBars, 250, 5,
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
  // The shared canvas context arrives with whatever dash pattern the
  // previous drawer left (price lines and alert lines are dashed), so a
  // trendline stroke rendered without an explicit reset would inherit it and
  // paint dotted on the live chart.
  it("resets the dash even when the ctx arrives already dashed", () => {
    const live = record(
      bars(),
      params(1),
      "lastbar",
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      false,
      false,
      true,
    );
    expect(live.segments.length, "fixture must draw a line").toBeGreaterThan(0);
    expect(live.segments.every((sg) => sg.dashed === false)).toBe(true);
  });

  // A pane saved under a mode this build no longer offers must not reach
  // lineExtent as an unhandled string: it draws as a ray, the standing default.
  it("normalises an unknown saved extend mode to a ray", () => {
    const b = bars();
    expect(record(b, params(1), "apex").segments).toEqual(
      record(b, params(1), "ray").segments,
    );
  });

  it("stops drawing a line past Max Span", () => {
    const b = flat(80);
    b[20] = bar(20, 90, 100.5);
    b[60] = bar(60, 94, 100.5);
    const withCeiling = (maxSpanBars: number): number[] => [
      2, 0.75, 2, 5, 250, 5, 0, 0, 20, 0, maxSpanBars,
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
    expect(live.segments.length, "fixture must draw a line").toBeGreaterThan(0);
    expect(live.segments.every((sg) => sg.alpha === 1)).toBe(true);

    const dimmed = record(b, params(1), "lastbar", undefined, undefined, false, false, undefined, {
      dimTouches: 2,
    });
    expect(dimmed.segments.length).toBe(live.segments.length);
    expect(dimmed.segments.every((sg) => sg.alpha === TL_DIM_ALPHA)).toBe(true);
    // THE RINGS TOO. The alpha is restored at the pin-handle site in the draw
    // loop, and a stroke that fades while its touch rings stay opaque is the
    // failure this pins: it looks right on the line and wrong everywhere
    // else. Every drawn line here meets the threshold, so no ring is left
    // opaque.
    expect(dimmed.touchMarks.length).toBeGreaterThan(0);
    expect(dimmed.touchMarks.every((m) => m.alpha === TL_DIM_ALPHA)).toBe(true);
  });

  it("paints the dim at the pane's own opacity, clamped", () => {
    const b = bars();
    const solidAt = (dim: Record<string, unknown>) =>
      record(b, params(1), "lastbar", undefined, undefined, false, false, undefined, dim)
        .segments.map((sg) => sg.alpha);
    expect(solidAt({ dimTouches: 2, dimOpacity: 25 }).every((a) => a === 0.25)).toBe(true);
    // Floored: a fade that reached invisible would hide a line with no row
    // saying so.
    expect(solidAt({ dimTouches: 2, dimOpacity: 0 }).every((a) => a === 0.1)).toBe(true);
    // An opacity alone dims nothing — it is a depth, not a switch.
    expect(solidAt({ dimOpacity: 25 }).every((a) => a === 1)).toBe(true);
  });

  it("rings every touch, on the line and not at the candle's own extreme", () => {
    const b = bars();
    // touchMult 0.75 matches this block's `params`, and is what makes this
    // fixture produce a line with a third, half-weight touch at all: Max Touch
    // Gap ships at 0, so at the defaults these three lows only pair.
    const { lines } = computeTrendlines(b, cfg({ touchMult: 0.75 }));
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

  // "Only lines near price" is retired and its cut lives in the calc as Max
  // Distance (calcParams 19/20). A pane saved with the checkbox-era
  // `nearPrice: true` and NO slot 19 keeps the cut through the parser's
  // migration, which is what makes the old choice survive a reload; an
  // absent key is off, because a pane that never chose the rule gets no cut.
  it("keeps the cut for a saved checkbox-era near-price pane, and none for an absent key", () => {
    const b = flat(80);
    // A distant pair 8+ ATR under the close and a near pair 1 ATR under it.
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 91, 100.5);
    b[62] = bar(62, 99, 100.5);
    b[70] = bar(70, 99.2, 100.5);
    const cp = params(8);
    const on = record(b, cp, undefined, undefined, undefined, false, true);
    const off = record(b, cp, undefined, undefined, undefined, false, "default");
    expect(on.segments.length).toBeGreaterThan(0);
    expect(on.segments.length).toBeLessThan(off.segments.length);
  });

  // maxLines is the drawn set's CAP as well as the operand count: the drawn
  // set IS the emitted set unless the user asks to declutter or merge.
  it("budgets the drawn set at maxLines", () => {
    const b = bars();
    const live = computeTrendlines(b, cfg()).lines;
    expect(live.length).toBeGreaterThan(1);
    // Uncapped: maxLines above the live count draws everything.
    expect(record(b, params(live.length)).segments).toHaveLength(live.length);
    // Budgeted: maxLines 1 picks ONE by rank. The live set itself is
    // unchanged (its cap is MAX_LIVE, 256 IN TOTAL whatever maxLines is), so
    // this really is the drawing budget and not the detector's.
    const one = computeTrendlines(b, cfg({ maxLines: 1 }));
    expect(one.lines).toHaveLength(live.length);
    const lastIdx = b.length - 1;
    const close = b[lastIdx].close;
    const budgeted = selectDrawnLines(one.lines, lastIdx, close, 1, null);
    expect(budgeted).toHaveLength(1);
    expect(record(b, params(1)).segments).toHaveLength(budgeted.length);
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
    const res = computeTrendlines(b, cfg());
    const drawnLines = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      3,
      null,
    );
    ray.forEach((r, i) => {
      const l = drawnLines[i];
      // Same left anchor as the ray, stopping at the last touch instead of
      // the horizon.
      expect(segment[i].x0).toBe(r.x0);
      expect(segment[i].x1).toBe(l.lastTouchIdx);
      // Extended reaches maxProjBars back before the first anchor.
      expect(extended[i].x0).toBe(r.x0 - 250);
      expect(extended[i].x1).toBe(r.x1);
    });
  });

  it("paints nothing when there are no lines", () => {
    expect(record(flat(30), params(3))).toEqual({
      segments: [],
      tags: [],
      marks: [],
      touchMarks: [],
      handleStrokes: [],
      strokeColors: [],
    });
  });

  it("strokes every line, ring and handle in the one line colour", () => {
    const b = bars();
    const { strokeColors } = record(b, params(3), "lastbar");
    expect(strokeColors.length).toBeGreaterThan(0);
    expect(strokeColors.every((c) => c === TL_LINE_COLOR)).toBe(true);
  });

  // extendData.lineColor is a render-only override: it recolours every stroke
  // and fill this instance paints (lines, rings, handles, tags, pivot marks)
  // without touching calc or the Python twin.
  it("recolours every stroke, ring and handle when extendData.lineColor is set", () => {
    const b = bars();
    const { strokeColors } = record(
      b,
      params(3),
      "lastbar",
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      false,
      false,
      false,
      "#ff0000",
    );
    expect(strokeColors.length).toBeGreaterThan(0);
    expect(strokeColors.every((c) => c === "#ff0000")).toBe(true);
  });

  it("keeps TL_LINE_COLOR when extendData.lineColor is absent", () => {
    const b = bars();
    const { strokeColors } = record(b, params(3), "lastbar");
    expect(strokeColors.length).toBeGreaterThan(0);
    expect(strokeColors.every((c) => c === TL_LINE_COLOR)).toBe(true);
  });

  // The rest of the Style tab: width and dash are the LINE's alone (the
  // handle keeps its own weight and stays solid), opacity fades the group.
  const styled = (styleExt: Record<string, unknown>) =>
    record(bars(), params(3), "lastbar", undefined, undefined, false, false, undefined, undefined, false, false, false, undefined, styleExt);
  it("strokes the line at extendData.lineWidth and the handle at its own weight", () => {
    const { segments, handleStrokes } = styled({ lineWidth: 3 });
    const lines = segments.filter((s) => s.width === 3);
    expect(lines.length).toBeGreaterThan(0);
    expect(handleStrokes.length).toBeGreaterThan(0);
    expect(handleStrokes.every((s) => s.width === TL_HANDLE_STROKE)).toBe(true);
  });
  it("dashes the line under extendData.lineStyle and leaves the handle solid", () => {
    const { segments, handleStrokes } = styled({ lineStyle: "dashed" });
    expect(segments.some((s) => s.dashed)).toBe(true);
    expect(handleStrokes.every((s) => !s.dashed)).toBe(true);
    const plain = styled({});
    expect(plain.segments.some((s) => s.dashed)).toBe(false);
  });
  it("fades the line and its rings by extendData.lineOpacity", () => {
    const { segments, touchMarks } = styled({ lineOpacity: 0.5 });
    expect(segments.some((s) => s.alpha === 0.5)).toBe(true);
    expect(touchMarks.length).toBeGreaterThan(0);
    expect(touchMarks.every((m) => m.alpha === 0.5)).toBe(true);
  });
  it("resolves the style block with defaults, a width floor and an opacity clamp", () => {
    expect(trendlineStyleOf(undefined)).toEqual({ color: TL_LINE_COLOR, width: 1, style: "solid", opacity: 1 });
    expect(trendlineStyleOf({ lineWidth: 0.2, lineOpacity: 4, lineStyle: "apex" as never })).toEqual({
      color: TL_LINE_COLOR, width: 1, style: "solid", opacity: 1,
    });
    expect(trendlineStyleOf({ lineColor: "#123456", lineWidth: 2, lineStyle: "dotted", lineOpacity: 0.3 })).toEqual({
      color: "#123456", width: 2, style: "dotted", opacity: 0.3,
    });
    expect(trendlineDash("solid")).toEqual([]);
    expect(trendlineDash("dashed")).toEqual([5, 4]);
    expect(trendlineDash("dotted")).toEqual([1, 3]);
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
      // ON the segment, to within a pixel, or stepped off it by whole tag
      // rows where clearTagRow moved it clear of an earlier tag.
      const onLine = s.y0 + ((s.y1 - s.y0) * (tag.x - s.x0)) / (s.x1 - s.x0);
      const off = Math.abs(tag.y - onLine);
      expect(Math.abs(off - Math.round(off / TL_TAG_ROW) * TL_TAG_ROW)).toBeLessThan(1);
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
      null,
    );
    expect(tags.map((t) => t.text)).toEqual(drawn.map((l) => `${l.touches} ○`));
  });

  it("adds the crossings count to the label once a line has been crossed", () => {
    const b = flat(120);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 90, 100.5); // flat line at 90, two anchors, no extra touch
    for (let j = 60; j < 70; j++) b[j] = bar(j, 80, 81); // dips below the line
    for (let j = 70; j < 80; j++) b[j] = bar(j, 99.5, 100.5); // and back above
    const res = computeTrendlines(b, cfg({ pivotLen: 2 }));
    const line = res.lines.find((l) => l.i1 === 20 && l.i2 === 40);
    expect(line).toBeDefined();
    expect(line!.touches).toBe(2);
    expect(line!.crossings).toBe(2);
    const drawn = selectDrawnLines(
      res.lines,
      b.length - 1,
      b[b.length - 1].close,
      1,
      null,
    );
    const idx = drawn.indexOf(line!);
    expect(idx).toBeGreaterThanOrEqual(0);
    const { tags } = record(b, params(1));
    expect(tags[idx].text).toBe("2 ○ 2 ●");
  });

  it("draws no stats tag when showStats is off", () => {
    const b = flat(120);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 90, 100.5);
    const on = record(b, params(1));
    expect(on.tags.length).toBeGreaterThan(0);
    const off = record(
      b, params(1), undefined, IDENTITY_VIEW, undefined, false, false, undefined,
      undefined, false, false, false, undefined, { showStats: false },
    );
    expect(off.tags).toEqual([]);
    expect(off.segments.length).toBe(on.segments.length);
  });

  it("shows a half touch as a fraction on the label", () => {
    // A swing high stopping 0.3 short of the flat line at 90 scores a half,
    // so the tag reads 2.5 Pivots rather than rounding either way.
    const b = flat(100);
    b[20] = bar(20, 90, 100.5);
    b[40] = bar(40, 90, 100.5);
    for (let j = 55; j < 66; j++) b[j] = bar(j, 85, 86);
    b[60] = bar(60, 85, 89.7);
    // calcParams: pivotLen 2, Max Touch Gap 0.3, the rest default.
    const gapParams = [2, 0.3, 2, 5, 250, 1];
    const res = computeTrendlines(b, cfg({ touchMult: 0.3, maxLines: 1 }));
    const line = res.lines.find((l) => l.i1 === 20 && l.i2 === 40);
    expect(line!.touches).toBe(2.5);
    const drawn = selectDrawnLines(res.lines, b.length - 1, b[b.length - 1].close, 1, null);
    const idx = drawn.indexOf(line!);
    expect(idx).toBeGreaterThanOrEqual(0);
    const { tags } = record(b, gapParams);
    // The corridor dips below the line and comes back, so the tag carries the
    // crossings too; the point here is the FRACTION.
    expect(tags[idx].text).toBe("2.5 ○ 2 ●");
  });
});

describe("TRENDLINES_TEMPLATE.draw break marker and meeting modes", () => {
  const params = (maxLines: number): number[] => [2, 0.75, 2, 5, 250, maxLines];

  /** Three rising lows. */
  const dips = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };

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
    // Three rising lows only, and every crossing among the lines they anchor
    // sits at or behind the anchors, so no forward meeting exists.
    const b = dips();
    const lastIdx = b.length - 1;
    const ray = record(b, params(3), "ray").segments;
    // The ray horizon really is far past the newest bar, or this proves nothing.
    for (const seg of ray) expect(seg.x1).toBeGreaterThan(lastIdx + 200);
    for (const mode of ["cross"]) {
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
      `${bars[10].timestamp}:${bars[30].timestamp}`,
    );
    // The same line after 5 older bars load: indices shift by 5, the key does not.
    const shifted = [...flat(5, -5), ...bars];
    const moved: TrendLine = { ...line, i1: 15, i2: 35 };
    expect(lineKey(moved, shifted)).toBe(lineKey(line, bars));
  });
});

describe("lineExtent", () => {
  const line: TrendLine = {
    ...sup,
    i1: 0,
    i2: 10,
    lastTouchIdx: 10,
  };
  const c = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig =>
    cfg(over);

  it("lets a pin outrun whatever the mode says", () => {
    for (const mode of [
      "ray",
      "segment",
      "extended",
      "lastbar",
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
  const params = (maxLines: number): number[] => [2, 0.75, 2, 5, 250, maxLines];
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
    // The natural end moves with the mode (last touch in segment, a meeting
    // in cross), but the handle must not: it sits on the line's projection at
    // the newest bar, one column beside price. In segment mode that is PAST
    // the drawn stroke, on the line's invisible extension.
    const b = dips();
    const lastIdx = b.length - 1;
    const OUT = TL_HANDLE_RADIUS + 0.5;
    for (const mode of ["segment", "lastbar", "cross"] as const) {
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
  const params = (maxLines: number): number[] => [2, 0.75, 2, 5, 250, maxLines];
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
      "1:2",
    ]).segments;
    expect(held).toEqual(free);
  });
});

describe("hitAnyTrendlineHandle", () => {
  const params = (maxLines: number): number[] => [2, 0.75, 2, 5, 250, maxLines];
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
  const line = (touches: number, lastTouchIdx: number, crossings = 0) =>
    ({ touches, crossings, lastTouchIdx }) as const;

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

  it("dims AT the crossing threshold, and 0 is off", () => {
    expect(trendlineDimmed(line(2, 100, 2), 100, { dimCrossings: 3 })).toBe(false);
    expect(trendlineDimmed(line(2, 100, 3), 100, { dimCrossings: 3 })).toBe(true);
    expect(trendlineDimmed(line(2, 100, 9), 100, { dimCrossings: 0 })).toBe(false);
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
    // line at 0 is gone, and removing a line is what Declutter is for.
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
      undefined,
      undefined,
      showPivots,
      showLinePivots,
    ).segments;
  const passing = (calcParams: number[]) =>
    computeTrendlines(bars(), parseTrendlinesConfig(calcParams)).pivots;
  const LINES = [2, 0.75, 2, 5, 250, 3];
  // Min Touches one above anything this fixture reaches: not a line survives,
  // which is the case the marks have to keep working in.
  const NO_LINES = [2, 0.75, 4, 5, 250, 3];

  it("marks every passing pivot when asked, and not by default", () => {
    const off = paint(LINES, false);
    const on = paint(LINES, true);
    // Absent key === off: the meta row's default and the draw path's fallback
    // have to agree, or the panel shows an unticked box over a marked pane.
    expect(paint(LINES, "default")).toEqual(off);
    const pv = passing(LINES);
    const total = pv.idxs.length;
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
    const total = pv.idxs.length;
    expect(total).toBeGreaterThan(0);
    expect(paint(NO_LINES, true)).toHaveLength(3 * total);
    // ...but only when asked: the absent key is off, on this pane like any
    // other.
    expect(paint(NO_LINES, "default")).toHaveLength(0);
  });

  it("points the arrow at price, clear of the wick", () => {
    // The recorder stamps each edge with the stroke width; a fill's edges
    // carry whatever width was last set, which is not what this pins.
    const marks = paint(NO_LINES, true).map(({ width: _w, ...m }) => m);
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
    const lowQ = pv.kinds.findIndex((k) => k === "low");
    const highQ = pv.kinds.findIndex((k) => k === "high");
    expect(lowQ).toBeGreaterThanOrEqual(0);
    expect(highQ).toBeGreaterThanOrEqual(0);
    const lowIdx = pv.idxs[lowQ];
    const highIdx = pv.idxs[highQ];
    for (const arm of caret(lowIdx, pv.lows[lowIdx], 1))
      expect(marks).toContainEqual(arm);
    for (const arm of caret(highIdx, pv.highs[highIdx], -1))
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
      undefined,
      undefined,
      showPivots,
      showLinePivots,
    ).segments;
  const LINES = [2, 0.75, 2, 5, 250, 3];
  // Min Touches one above anything this fixture reaches: not a line survives,
  // so nothing can be "used" and the stemmed batch must come out empty.
  const NO_LINES = [2, 0.75, 4, 5, 250, 3];
  const passing = (calcParams: number[]) =>
    computeTrendlines(bars(), parseTrendlinesConfig(calcParams)).pivots;
  // A stemmed arrow closes over 7 points.
  const STEMMED_EDGES = 7;

  it("is on unless switched off: absent key paints exactly what true does", () => {
    expect(paint(LINES, false, "default")).toEqual(paint(LINES, false, true));
    expect(paint(LINES, true, "default")).toEqual(paint(LINES, true, true));
  });

  it("marks the used pivots with a stemmed arrow and leaves the rest alone", () => {
    const linesOnly = paint(LINES, false, false);
    const stemmed = paint(LINES, false, true).slice(linesOnly.length);
    const used = drawnPivotIdxs(
      computeTrendlines(bars(), parseTrendlinesConfig(LINES)).lines,
    );
    const pv = passing(LINES);
    // Only the pivots a line rests on, and only those the pivot pool holds —
    // a line's touch can be an opposite-kind pivot, but it is a pivot either
    // way, so every mark still stands on one.
    const marked = pv.idxs.filter((i) => used.has(i));
    expect(marked.length).toBeGreaterThan(0);
    expect(stemmed).toHaveLength(STEMMED_EDGES * marked.length);
    // Every mark sits on a used pivot's x, so the stem cannot have wandered.
    const xs = new Set(marked.map((i) => view.toX(i)));
    for (const sg of stemmed)
      expect([...xs].some((x) => Math.abs(x - sg.x0) <= TL_PIVOT_ARM)).toBe(true);
  });

  it("stands clear of the ring and the price label the swing already carries", () => {
    const linesOnly = paint(LINES, false, false);
    const stemmed = paint(LINES, false, true).slice(linesOnly.length);
    const ys = stemmed.flatMap((sg) => [sg.y0, sg.y1]);
    const pv = passing(LINES);
    const used = drawnPivotIdxs(
      computeTrendlines(bars(), parseTrendlinesConfig(LINES)).lines,
    );
    // A used-low mark hangs BELOW its low (larger y here) and reaches exactly
    // usedGap + arm + stem past it. Take the deepest used low pivot so the
    // extreme below is unambiguously its.
    const lows = pv.idxs.filter((i, q) => pv.kinds[q] === "low" && used.has(i));
    expect(lows.length).toBeGreaterThan(0);
    const deepest = Math.max(...lows.map((i) => view.toY(pv.lows[i])));
    expect(Math.max(...ys)).toBeCloseTo(
      deepest + TL_PIVOT_USED_GAP + TL_PIVOT_ARM + TL_PIVOT_STEM,
      6,
    );
    // The whole glyph starts BEYOND the ring and the price label that sit on
    // this very bar — the reason it uses its own gap and not TL_PIVOT_GAP.
    // TL_TOUCH_RADIUS is the ring; the label reaches further, which is what
    // TL_PIVOT_USED_GAP is actually sized against.
    expect(TL_PIVOT_USED_GAP).toBeGreaterThan(TL_TOUCH_RADIUS);
    expect(TL_PIVOT_USED_GAP).toBeGreaterThan(TL_PIVOT_GAP);
    // Nothing of that glyph comes NEARER the wick than its gap. Filtered to
    // the points at or below the deepest low, which are only its own — `ys`
    // also holds the high marks, and those sit above everything.
    const own = ys.filter((v) => v >= deepest);
    expect(Math.min(...own)).toBeCloseTo(deepest + TL_PIVOT_USED_GAP, 6);
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

// "Show pivot depth": the debugging number beside each contested pivot —
// what Max lines per pivot counts, next to what survived it.
describe("TRENDLINES pivot depth labels", () => {
  const bars = (): KLineData[] => {
    const out = flat(80);
    out[20] = bar(20, 90, 100.5);
    out[40] = bar(40, 94, 100.5);
    out[60] = bar(60, 96, 100.5);
    return out;
  };
  const view: View = {
    width: 900,
    height: 400,
    axis: 60,
    toX: (i) => i * 10,
    toY: (p) => (110 - p) * 15 + 40,
  };
  const LINES = [2, 0.75, 2, 5, 250, 3];
  const tags = (depth: boolean | "default"): Tag[] =>
    record(
      bars(),
      LINES,
      undefined,
      view,
      undefined,
      false,
      false,
      undefined,
      undefined,
      false,
      false,
      false,
      undefined,
      depth === "default" ? {} : { showPivotDepth: depth },
    ).tags;
  // Depth labels are bare numbers; the ×N stats tags always carry glyphs.
  const bare = (ts: Tag[]): Tag[] => ts.filter((t) => /^\d+$/.test(t.text));

  it("is off unless switched on: absent key paints no numbers", () => {
    expect(bare(tags(false))).toHaveLength(0);
    expect(bare(tags("default"))).toHaveLength(0);
  });

  it("writes the counted depth beside each contested pivot", () => {
    const numbered = bare(tags(true));
    expect(numbered.length).toBeGreaterThan(0);
    // Every number stands just right of a real pivot bar's mark.
    const pv = computeTrendlines(bars(), parseTrendlinesConfig(LINES)).pivots;
    const xs = new Set(pv.idxs.map((i) => view.toX(i)));
    for (const t of numbered) {
      expect([...xs].some((x) => Math.abs(x + 4 - t.x) < 1e-6)).toBe(true);
      expect(Number(t.text)).toBeGreaterThanOrEqual(1);
    }
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
    expect(late!.crossings).toBe(twin!.crossings);
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
