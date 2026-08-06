import { describe, it, expect } from "vitest";
import {
  CANDLE_PATTERN_DEFS,
  CANDLE_PATTERN_TOGGLES,
  ANY_BULL_LINE,
  ANY_BEAR_LINE,
  detectAllPatterns,
  computeCandlePatterns,
  epsSeries,
  type PatternBar,
  pickLabelSlots,
  PATTERN_PREDICATE_FNS,
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
  it("16 toggles, aggregate lines, polarity split", () => {
    expect(CANDLE_PATTERN_TOGGLES.length).toBe(16);
    expect(ANY_BULL_LINE).toBe(24);
    expect(ANY_BEAR_LINE).toBe(25);
    // The bull/bear split defines what bullPattern/bearPattern mean. The
    // aggregates themselves live in Python (indicators/candle_patterns.py
    // _BULL_IDS/_BEAR_IDS); the golden fixture pins each def's polarity across
    // the two stacks, so this count and that fixture must agree.
    const byPolarity = (p: string) => CANDLE_PATTERN_DEFS.filter((d) => d.polarity === p).length;
    expect(byPolarity("bull")).toBe(12);
    expect(byPolarity("bear")).toBe(9);
    expect(byPolarity("neutral")).toBe(3);
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


describe("computeCandlePatterns (chart calc): enable filtering + canonical indices", () => {
  // pin_bottom (canonical index 3, toggle "pin_bottom") on a lone bar.
  const pinBottom = withPad(B(100, 100.5, 90, 99.5));
  // A bar that fires BOTH engulfing patterns' toggle group is hard to build in
  // one bar, so cover the two-patterns-one-toggle contract via bull_engulfing
  // (index 0) and its shared "engulfing" toggle also gating bear_engulfing (1).
  const bullEngulf = withPad(B(100, 101, 97, 98), B(97, 102, 96, 101));

  it("enabled hit carries its canonical index (pin_bottom -> 3)", () => {
    const pts = computeCandlePatterns(pinBottom, {});
    const last = pts[pts.length - 1];
    expect(last.hits).toContain(3);
  });

  it("disabling a toggle removes BOTH patterns it gates from hits", () => {
    // bull_engulfing (0) present when enabled.
    const on = computeCandlePatterns(bullEngulf, {});
    expect(on[on.length - 1].hits).toContain(0);
    // Disabling the "engulfing" toggle must drop index 0 AND index 1 everywhere.
    const off = computeCandlePatterns(bullEngulf, { disabled: { engulfing: true } });
    for (const pt of off) {
      expect(pt.hits ?? []).not.toContain(0);
      expect(pt.hits ?? []).not.toContain(1);
    }
  });

  it("disabling an unrelated toggle leaves the hit intact", () => {
    const pts = computeCandlePatterns(pinBottom, { disabled: { engulfing: true } });
    expect(pts[pts.length - 1].hits).toContain(3);
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

describe("epsSeries: independent hand-computed oracle", () => {
  it("ATR path: 20 identical gap-free bars with range 2 give eps exactly 0.05 * 2 from index 13", () => {
    // Every bar: high-low = 2, prev close inside [low, high] -> TR = 2 for all
    // bars (including bar 0, where TR = high-low). SMA14 of a constant 2 is 2,
    // so eps = 0.05 * 2 = 0.1 -- computed by hand, not via epsSeries itself.
    const bars = Array.from({ length: 20 }, () => B(100, 101, 99, 100));
    const eps = epsSeries(bars);
    for (let i = 13; i < 20; i++) expect(eps[i]).toBeCloseTo(0.1, 12);
  });
  it("fallback path: below 14 TRs eps is 1e-4 * close", () => {
    const bars = Array.from({ length: 20 }, () => B(100, 101, 99, 100));
    const eps = epsSeries(bars);
    for (let i = 0; i < 13; i++) expect(eps[i]).toBeCloseTo(1e-4 * 100, 12);
  });
  it("fallback eps gates a TV equality in short arrays", () => {
    // bull_belt_hold needs eq(o0, l0, e) with e = 1e-4 * close = ~0.00998 here.
    // Prev bar down, gapping fully above the current open.
    const prev = B(100, 100.5, 99.9, 99.95);
    const hit = [prev, B(99.8, 100.6, 99.799995, 100.4)]; // |o0-l0| = 5e-6 <= eps
    const miss = [prev, B(99.8, 100.6, 99.7, 100.4)]; // |o0-l0| = 0.1 > eps
    expect(detectAllPatterns(hit)[1].has("bull_belt_hold")).toBe(true);
    expect(detectAllPatterns(miss)[1].has("bull_belt_hold")).toBe(false);
  });
});

describe("detectAllPatterns memoization", () => {
  it("same array reference with unchanged bars returns the cached result", () => {
    const bars = [...pad, B(100, 102, 98, 101)];
    const first = detectAllPatterns(bars);
    expect(detectAllPatterns(bars)).toBe(first);
  });
  it("in-place append invalidates the cache", () => {
    const bars = [...pad];
    const first = detectAllPatterns(bars);
    bars.push(B(100, 102, 98, 101));
    const second = detectAllPatterns(bars);
    expect(second).not.toBe(first);
    expect(second.length).toBe(bars.length);
  });
  it("in-place forming-bar mutation invalidates the cache", () => {
    const bars = [...pad, B(100, 102, 98, 101)];
    const first = detectAllPatterns(bars);
    bars[bars.length - 1] = B(100, 103, 98, 102.5);
    const second = detectAllPatterns(bars);
    expect(second).not.toBe(first);
  });
  it("distinct arrays with equal content are computed independently", () => {
    const a = [...pad];
    const b = [...pad];
    expect(detectAllPatterns(a)).not.toBe(detectAllPatterns(b));
    expect(detectAllPatterns(a)).toEqual(detectAllPatterns(b));
  });
});

describe("pickLabelSlots: horizontal collision skipping", () => {
  it("keeps every label when the spans do not touch", () => {
    const slots = pickLabelSlots([
      { x: 0, halfWidth: 10 },
      { x: 40, halfWidth: 10 },
      { x: 80, halfWidth: 10 },
    ]);
    expect(slots).toEqual([true, true, true]);
  });

  it("skips a label whose span overlaps the last kept one", () => {
    const slots = pickLabelSlots([
      { x: 0, halfWidth: 10 },
      { x: 15, halfWidth: 10 },
      { x: 60, halfWidth: 10 },
    ]);
    expect(slots).toEqual([true, false, true]);
  });

  it("measures the gap from the last KEPT label, not the last candidate", () => {
    // 20 is skipped (overlaps 0); 30 must still be compared against 0's right
    // edge — comparing against 20 would wrongly keep it.
    const slots = pickLabelSlots([
      { x: 0, halfWidth: 20 },
      { x: 20, halfWidth: 20 },
      { x: 30, halfWidth: 20 },
      { x: 70, halfWidth: 20 },
    ]);
    expect(slots).toEqual([true, false, false, true]);
  });

  it("honours the pad between adjacent spans", () => {
    // right edge of #1 = 10, left edge of #2 = 14 -> 4px gap.
    const items = [{ x: 0, halfWidth: 10 }, { x: 24, halfWidth: 10 }];
    expect(pickLabelSlots(items, 2)).toEqual([true, true]);
    expect(pickLabelSlots(items, 6)).toEqual([true, false]);
  });

  it("returns an empty array for no items", () => {
    expect(pickLabelSlots([])).toEqual([]);
  });
});

describe("PATTERN_PREDICATE_FNS: the rule-operand interface", () => {
  it("names all 24 patterns plus the two aggregates", () => {
    expect(Object.keys(PATTERN_PREDICATE_FNS).length).toBe(26);
    expect(PATTERN_PREDICATE_FNS.bullEngulfing).toBe(0);
    expect(PATTERN_PREDICATE_FNS.bullPattern).toBe(ANY_BULL_LINE);
    expect(PATTERN_PREDICATE_FNS.bearPattern).toBe(ANY_BEAR_LINE);
  });

  it("maps every def's fn to that def's canonical index", () => {
    CANDLE_PATTERN_DEFS.forEach((def, i) => {
      expect(PATTERN_PREDICATE_FNS[def.fn]).toBe(i);
    });
  });

});
