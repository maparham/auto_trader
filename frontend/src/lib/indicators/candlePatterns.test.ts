import { describe, it, expect } from "vitest";
import {
  CANDLE_PATTERN_DEFS,
  CANDLE_PATTERN_TOGGLES,
  ANY_BULL_LINE,
  ANY_BEAR_LINE,
  detectAllPatterns,
  patternLineSeries,
  defaultMembers,
  type PatternBar,
} from "./candlePatterns";

const B = (open: number, high: number, low: number, close: number): PatternBar => ({ open, high, low, close });

// 20 flat lead-in bars so eps uses the ATR14 path (TR=2 each -> ATR14=2, eps=0.1).
const pad = Array.from({ length: 20 }, () => B(100, 101, 99, 100));
const withPad = (...seq: PatternBar[]): PatternBar[] => [...pad, ...seq];
const lastSet = (bars: PatternBar[]): Set<string> => {
  const hits = detectAllPatterns(bars);
  return hits[hits.length - 1];
};

// Sanity: every triggering fixture must be internally consistent OHLC.
const assertConsistent = (bars: PatternBar[]) => {
  for (const b of bars) {
    expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
    expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
  }
};

// A hit/near-miss pair for one pattern id. `hitSeq`/`missSeq` are appended to pad.
const patternCase = (id: string, hitSeq: PatternBar[], missSeq: PatternBar[]) => {
  it(id, () => {
    const hit = withPad(...hitSeq);
    const miss = withPad(...missSeq);
    assertConsistent(hit);
    assertConsistent(miss);
    expect(lastSet(hit).has(id)).toBe(true);
    expect(lastSet(miss).has(id)).toBe(false);
  });
};

describe("registry shape", () => {
  it("24 defs in canonical order", () => {
    expect(CANDLE_PATTERN_DEFS.length).toBe(24);
    expect(CANDLE_PATTERN_DEFS.map((d) => d.id)).toEqual([
      "bull_engulfing", "bear_engulfing", "pin_top", "pin_bottom", "doji", "inside", "outside",
      "bull_harami", "bear_harami", "piercing_line", "dark_cloud_cover", "morning_star",
      "evening_star", "bull_belt_hold", "bear_belt_hold", "three_white_soldiers",
      "three_black_crows", "three_stars_south", "stick_sandwich", "bull_meeting_line",
      "bear_meeting_line", "bull_kicking", "bear_kicking", "ladder_bottom",
    ]);
  });
  it("16 toggles, aggregate lines, member counts", () => {
    expect(CANDLE_PATTERN_TOGGLES.length).toBe(16);
    expect(ANY_BULL_LINE).toBe(24);
    expect(ANY_BEAR_LINE).toBe(25);
    expect(defaultMembers("bull").length).toBe(12);
    expect(defaultMembers("bear").length).toBe(9);
  });
});

describe("per-pattern hit + near-miss", () => {
  // Analysis-7 (ported from classify_candle)
  patternCase(
    "bull_engulfing",
    [B(100, 101, 97, 98), B(97, 102, 96, 101)], // prev down, cur up body-engulfs
    [B(100, 101, 97, 98), B(97, 102, 96, 99)], // cur body top 99 < prev body top 100
  );
  patternCase(
    "bear_engulfing",
    [B(98, 101, 97, 100), B(101, 102, 96, 97)], // prev up, cur down body-engulfs
    [B(98, 101, 97, 100), B(99, 102, 96, 97)], // cur body top 99 < prev body top 100
  );
  patternCase(
    "pin_top",
    [B(100, 110, 99.5, 100.5)], // tiny body near low, long upper wick
    [B(100, 110, 99.5, 105)], // body too large -> upper_wick < 2*body
  );
  patternCase(
    "pin_bottom",
    [B(100, 100.5, 90, 99.5)], // tiny body near high, long lower wick
    [B(100, 100.5, 90, 95)], // body too large -> lower_wick < 2*body
  );
  patternCase(
    "doji",
    [B(100, 101, 99, 100.1)], // body 0.1 <= 0.1*rng(2)
    [B(100, 101.5, 99, 101)], // body 1 > 0.1*rng
  );
  patternCase(
    "inside",
    [B(96, 105, 95, 104), B(100, 103, 97, 101)],
    [B(96, 105, 95, 104), B(100, 106, 97, 101)], // high 106 > prev high 105
  );
  patternCase(
    "outside",
    [B(98, 103, 97, 102), B(100, 105, 95, 101)],
    [B(98, 103, 97, 102), B(100, 102, 95, 101)], // high 102 < prev high 103
  );

  // TV ports
  patternCase(
    "bull_harami",
    [B(108, 112, 107, 110), B(108, 109, 95, 100), B(101, 106, 100, 105)],
    [B(108, 112, 107, 110), B(108, 109, 95, 100), B(101, 110, 100, 105)], // h0 110 not < h1 109
  );
  patternCase(
    "bear_harami",
    [B(88, 92, 87, 90), B(92, 105, 91, 100), B(98, 99, 93, 95)],
    [B(88, 92, 87, 90), B(92, 105, 91, 100), B(98, 99, 90, 95)], // l0 90 not > l1 91
  );
  patternCase(
    "piercing_line",
    [B(108, 112, 107, 110), B(105, 106, 99, 100), B(98, 104, 97, 103)],
    [B(108, 112, 107, 110), B(105, 106, 99, 100), B(100, 104, 97, 103)], // o0 100 not < l1 99
  );
  patternCase(
    "dark_cloud_cover",
    [B(88, 92, 87, 90), B(95, 101, 94, 100), B(103, 104, 95.5, 96)],
    [B(88, 92, 87, 90), B(95, 101, 94, 100), B(100, 104, 95.5, 96)], // o0 100 not > h1 101
  );
  patternCase(
    "morning_star",
    [B(98, 101, 97, 100), B(99, 100, 89, 90), B(88, 89, 86, 87), B(91, 98, 90, 97)],
    [B(98, 101, 97, 100), B(99, 100, 89, 90), B(88, 89, 86, 87), B(91, 98, 88, 89)], // c0 89 not > c2 90
  );
  patternCase(
    "evening_star",
    [B(88, 92, 87, 90), B(91, 101, 90, 100), B(102, 104, 101, 103), B(99, 100, 93, 94)],
    [B(88, 92, 87, 90), B(91, 101, 90, 100), B(102, 104, 101, 103), B(99, 102, 93, 101)], // c0 101 not < c2 100
  );
  patternCase(
    "bull_belt_hold",
    [B(105, 106, 99, 100), B(95, 101, 95, 100)], // cur opens exactly at low, closes up
    [B(105, 106, 99, 100), B(95, 101, 90, 100)], // open not == low
  );
  patternCase(
    "bear_belt_hold",
    [B(100, 106, 100, 105), B(110, 110, 104, 105)], // cur opens exactly at high, closes down
    [B(100, 106, 100, 105), B(110, 115, 104, 105)], // open not == high
  );
  patternCase(
    "three_white_soldiers",
    [B(100, 101, 97, 98), B(97, 103, 96, 102), B(99, 106, 98, 105), B(102, 109, 101, 108)],
    [B(100, 101, 97, 98), B(97, 103, 96, 102), B(99, 106, 98, 105), B(106, 109, 101, 108)], // o0 106 not < c1 105
  );
  patternCase(
    "three_black_crows",
    [B(98, 101, 97, 100), B(102, 103, 95, 96), B(100, 101, 92, 93), B(97, 98, 89, 90)],
    [B(98, 101, 97, 100), B(102, 103, 95, 96), B(100, 101, 92, 93), B(92, 98, 89, 90)], // o0 92 not > c1 93
  );
  patternCase(
    "three_stars_south",
    [B(110, 111, 94, 95), B(108, 108, 88, 92), B(105, 105, 90, 93), B(100, 100, 95, 95)],
    [B(110, 111, 94, 95), B(108, 108, 88, 92), B(105, 105, 90, 93), B(100, 100, 90, 95)], // c0 95 not == l0 90
  );
  patternCase(
    "stick_sandwich",
    [B(105, 106, 99, 100), B(101, 107, 100, 106), B(108, 109, 99, 100)], // c0 == c2 (100)
    [B(105, 106, 99, 100), B(101, 107, 100, 106), B(108, 109, 94, 95)], // c0 95 != c2 100
  );
  patternCase(
    "bull_meeting_line",
    [B(105, 106, 99, 100), B(110, 111, 94, 95), B(90, 96, 89, 95)], // c0 == c1 (95)
    [B(105, 106, 99, 100), B(110, 111, 94, 95), B(90, 115, 89, 95)], // o1 110 not >= h0 115
  );
  patternCase(
    "bear_meeting_line",
    [B(100, 106, 99, 105), B(95, 111, 94, 110), B(115, 116, 109, 110)], // c0 == c1 (110)
    [B(100, 106, 99, 105), B(95, 111, 94, 110), B(115, 116, 90, 110)], // o1 95 not <= l0 90
  );
  patternCase(
    "bull_kicking",
    [B(100, 100, 95, 95), B(110, 120, 110, 120)], // black marubozu then white marubozu gap up
    [B(100, 100, 95, 95), B(99, 109, 99, 109)], // o0 99 not > o1 100
  );
  patternCase(
    "bear_kicking",
    [B(100, 105, 100, 105), B(95, 95, 85, 85)], // white marubozu then black marubozu gap down
    [B(100, 105, 100, 105), B(101, 101, 91, 91)], // o0 101 not < o1 100
  );
  patternCase(
    "ladder_bottom",
    [B(120, 121, 114, 115), B(115, 116, 109, 110), B(110, 111, 104, 105), B(105, 106, 99, 100), B(106, 113, 105, 112)],
    [B(120, 121, 114, 115), B(115, 116, 109, 110), B(110, 111, 104, 105), B(105, 106, 99, 100), B(104, 113, 103, 112)], // o0 104 not > o1 105
  );
});

describe("tolerance boundary (bull_kicking eq(o0,l0))", () => {
  // eps replicates candlePatterns.epsSeries; ATR14 = eps / 0.05.
  const epsAtLast = (bars: PatternBar[]): number => {
    let sum = 0;
    const trs: number[] = [];
    let eps = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const pc = i > 0 ? bars[i - 1].close : b.close;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
      trs.push(tr);
      sum += tr;
      if (trs.length > 14) sum -= trs[trs.length - 15];
      eps = trs.length >= 14 ? 0.05 * (sum / 14) : 1e-4 * b.close;
    }
    return eps;
  };
  // o0 is the open; it does not enter TR, so eps is stable regardless of the offset.
  const build = (o0: number) => withPad(B(100, 100, 95, 95), B(o0, 120, 110, 120));
  const eps = epsAtLast(build(110));
  const atr14 = eps / 0.05;

  it("hits when o0-l0 = 0.04*ATR14", () => {
    const bars = build(110 + 0.04 * atr14);
    assertConsistent(bars);
    expect(lastSet(bars).has("bull_kicking")).toBe(true);
  });
  it("misses when o0-l0 = 0.5*ATR14", () => {
    const bars = build(110 + 0.5 * atr14);
    assertConsistent(bars);
    expect(lastSet(bars).has("bull_kicking")).toBe(false);
  });
});

describe("analysis parity: body-engulf ignores high/low", () => {
  it("bull_engulfing hits even when cur high/low are inside prev range", () => {
    // Body engulfs (cur body [97,101] covers prev body [98,100]) but cur high
    // 100.5 < prev high 105 and cur low 96.5 > prev low 95 -> TV engulf would
    // fail; the analysis body-engulf must still hit.
    const bars = withPad(B(100, 105, 95, 98), B(97, 104, 96.5, 101));
    assertConsistent(bars);
    expect(lastSet(bars).has("bull_engulfing")).toBe(true);
  });
  it("bear_engulfing hits even when cur high/low are inside prev range", () => {
    const bars = withPad(B(98, 105, 95, 100), B(101, 101.5, 96.5, 97));
    assertConsistent(bars);
    expect(lastSet(bars).has("bear_engulfing")).toBe(true);
  });
});

describe("aggregate lines", () => {
  it("bear_engulfing -> line 25 = 1, line 24 = 0 at that bar", () => {
    const bars = withPad(B(98, 101, 97, 100), B(101, 102, 96, 97));
    assertConsistent(bars);
    const bear = patternLineSeries(bars, ANY_BEAR_LINE);
    const bull = patternLineSeries(bars, ANY_BULL_LINE);
    const last = bars.length - 1;
    expect(bear[last]).toBe(1);
    expect(bull[last]).toBe(0);
  });
  it("restricted members ignore other bull hits", () => {
    // pin_bottom is a bull pattern; default any-bull = 1, but members ["bull_kicking"] = 0.
    const bars = withPad(B(100, 100.5, 90, 99.5));
    assertConsistent(bars);
    const last = bars.length - 1;
    expect(patternLineSeries(bars, ANY_BULL_LINE)[last]).toBe(1);
    expect(patternLineSeries(bars, ANY_BULL_LINE, ["bull_kicking"])[last]).toBe(0);
  });
  it("line < 24 maps to a single pattern id", () => {
    const bars = withPad(B(100, 100.5, 90, 99.5)); // pin_bottom is index 3
    assertConsistent(bars);
    const last = bars.length - 1;
    expect(patternLineSeries(bars, 3)[last]).toBe(1);
    expect(patternLineSeries(bars, 2)[last]).toBe(0); // pin_top not hit
  });
});

describe("warm-up: short arrays never crash or over-report", () => {
  it("3-bar array has no morning_star (needs 4 bars) and does not throw", () => {
    const bars = [B(100, 101, 99, 100), B(100, 101, 99, 100), B(100, 101, 99, 100)];
    const hits = detectAllPatterns(bars);
    // flat bars are dojis, so the set is not empty; morning_star must be absent.
    for (const set of hits) expect(set.has("morning_star")).toBe(false);
    expect(hits.length).toBe(3);
  });
  it("empty array returns empty", () => {
    expect(detectAllPatterns([]).length).toBe(0);
  });
});
