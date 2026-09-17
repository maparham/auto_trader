// ACCEPTANCE test: does TRENDLINES find the lines a human draws?
//
// Every other test in this feature checks a mechanism (pivot geometry, break
// detection, config parsing) against synthetic data. This one is the only test
// that checks the thing the user actually asked for, against real DXY monthly
// bars captured from the running app (490 bars, 1985-11 to 2026-08). If this
// file stops passing honestly, the feature does not work no matter how green
// the rest of the suite is.

import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { isPivotAt } from "./pivots";
import {
  computeTrendlines,
  isMajor,
  projectAt,
  selectDrawnLines,
  TL_DEDUPE_ATR,
  TL_NEAR_PRICE_ATR,
  type TrendLine,
} from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesDxy.fixture.json";

// Lines a human draws on DXY monthly. Anchors are the bar's own high/low, so
// they are exact, not eyeballed. Kinds replace the old sided "support" /
// "resistance" label: the detector no longer has sides, only the kind (high
// or low) of each anchor.
//
// A third hand-drawn line, resistance 2002-03 (119.61) -> 2007-08 (82.132),
// is NOT listed here and is NOT expected: neither anchor is a fractal pivot at
// any lookback, so the detector cannot construct it. See the dedicated test
// below, which pins that cause rather than hiding it.
const EXPECTED = [
  // The secular support off the 2011 low, as the detector pairs it AT THE PANE
  // DEFAULT: the second anchor is the 2026-01 low, not the 2021-01 one a human
  // would pick. Same first anchor, same secular line, a shallower slope
  // (0.128/month against 0.142). The exact human pairing is asserted in its own
  // test below, at the cap it needs.
  { k1: "low", k2: "low", from: "2011-05", fromPrice: 72.696, to: "2026-01", toPrice: 95.226 },
  { k1: "high", k2: "high", from: "2022-09", fromPrice: 114.687, to: "2025-01", toPrice: 109.879 },
] as const;

// THE PANE DEFAULT. Both EXPECTED rows survive the live cap at maxLines 3
// (measured by bisection: the 2011-05 row needs maxLines 1 and the 2022-09 row
// 2, i.e. live caps of 16 and 32 against the 48 that MAX_LIVE_MULT 16 gives at
// 3), so this file no longer raises maxLines to make its acceptance pass. The one line that still needs a raised
// cap is the exact 2011-05 -> 2021-01 pairing, and it says so where it is
// asserted. See the "Survival vs rank" section of
// docs/superpowers/specs/2026-09-16-sideless-trendlines-design.md for the
// measured cap numbers behind this.
const CFG = TRENDLINES_DEFAULTS;

const bars = fixture as unknown as KLineData[];
const month = (t: number): string => new Date(t).toISOString().slice(0, 7);
const indexOfMonth = (m: string): number => bars.findIndex((b) => month(b.timestamp) === m);

describe("TRENDLINES on DXY monthly", () => {
  it("has the fixture it expects", () => {
    expect(bars.length).toBeGreaterThan(400);
    expect(month(bars[bars.length - 1].timestamp)).toBe("2026-08");
  });

  it.each(EXPECTED)("surfaces the $from to $to line ($k1 -> $k2)", (want) => {
    const { lines } = computeTrendlines(bars, CFG);
    const found = lines.find(
      (l) =>
        l.k1 === want.k1 &&
        l.k2 === want.k2 &&
        month(bars[l.i1].timestamp) === want.from &&
        month(bars[l.i2].timestamp) === want.to,
    );
    expect(found, `no ${want.k1}->${want.k2} line ${want.from} -> ${want.to}`).toBeDefined();
    // Exact, not toleranced: these are the fixture bars' own high and low.
    expect(found!.p1).toBe(want.fromPrice);
    expect(found!.p2).toBe(want.toPrice);
    // Surviving the live cap is not enough: the line has to still be one the
    // operand path would read on the last bar.
    expect(isMajor(found!, bars.length - 1, CFG)).toBe(true);
  });

  // WHY THE THIRD HAND-DRAWN LINE IS ABSENT, pinned as a passing assertion
  // rather than left as a mystery or papered over by relaxing an anchor.
  //
  // A human anchors the 2002-2007 decline on 2002-03 (119.61), the visually
  // dominant top of a rounded three-month cluster, and on 2007-08 (82.132), a
  // pause inside the slide. Fractal detection picks neither:
  //   - 2002-03 is beaten by its IMMEDIATE left neighbour 2002-02 (120.4), so
  //     it fails at every lookback >= 1 and in non-strict mode too. No tuning
  //     of pivotLen or tie handling rescues it. The pool gets 2002-01 (120.51).
  //   - 2007-08 is a pivot at lookback 1 only (2007-07 81.946, 2007-09 81.136
  //     are lower); 2007-06 (83.272) kills it from lookback 2 up.
  // Consequence: no line spans the 2002-2007 decline at all. The pool offers
  // 2001-07 -> 2002-01 and then nothing until 2009-03.
  //
  // If this test starts failing, the detector CAN now reach those anchors and
  // the EXPECTED table above should regain its third row.
  it("cannot reach the 2002-03 / 2007-08 anchors, because neither is a pivot", () => {
    const highs = bars.map((b) => b.high);
    const i2002 = indexOfMonth("2002-03");
    const i2007 = indexOfMonth("2007-08");
    const iRealPivot = indexOfMonth("2002-01");
    // Guard the lookups so the isPivotAt assertions below cannot pass on a -1.
    expect(i2002).toBeGreaterThan(0);
    expect(i2007).toBeGreaterThan(0);
    expect(highs[i2002]).toBeCloseTo(119.61, 3);
    expect(highs[i2007]).toBeCloseTo(82.132, 3);
    // Control: the pivot the detector DOES take from that cluster, so a
    // uniformly-false isPivotAt could not make this test pass.
    expect(isPivotAt(highs, iRealPivot, 5, 5, "high", true)).toBe(true);
    expect(highs[iRealPivot]).toBeCloseTo(120.51, 3);
    // 2002-03 fails at every lookback, strict or not: 2002-02 is higher.
    expect(highs[i2002 - 1]).toBeGreaterThan(highs[i2002]);
    for (const len of [1, 2, 3, 5, 10]) {
      expect(isPivotAt(highs, i2002, len, len, "high", true), `2002-03 strict len ${len}`).toBe(false);
      expect(isPivotAt(highs, i2002, len, len, "high", false), `2002-03 loose len ${len}`).toBe(false);
    }
    // 2007-08 survives lookback 1 and nothing wider.
    expect(isPivotAt(highs, i2007, 1, 1, "high", true)).toBe(true);
    for (const len of [2, 3, 5, 10]) {
      expect(isPivotAt(highs, i2007, len, len, "high", true), `2007-08 strict len ${len}`).toBe(false);
    }
  });

  // THE PAIRING A HUMAN DRAWS, 2011-05 -> 2021-01, which is NOT what survives
  // at the pane default. It is a weak specimen by every measure the cap can
  // see (2 touches, 6 crossings over 116 months) and sits deep in the ~1000
  // lines the detector builds on this fixture, so it needs a live cap of 224,
  // i.e. maxLines 14 at MAX_LIVE_MULT 16 (bisected; 13 fails). Re-measured
  // when the touch rule split into Max Touch Gap and Max Pierce: the third
  // touch it used to be credited with was a near miss on the old symmetric
  // band, and the cap it needs fell from 256.
  // Asserted at that setting
  // rather than dropped, because it is the line the fixture was captured for.
  it("still builds the exact 2011-05 -> 2021-01 human pairing, at the cap it needs", () => {
    const wide = { ...TRENDLINES_DEFAULTS, maxLines: 14 };
    const { lines } = computeTrendlines(bars, wide);
    const human = lines.find(
      (l: TrendLine) =>
        l.k1 === "low" &&
        l.k2 === "low" &&
        month(bars[l.i1].timestamp) === "2011-05" &&
        month(bars[l.i2].timestamp) === "2021-01",
    );
    expect(human, "no low->low line 2011-05 -> 2021-01").toBeDefined();
    expect(human!.p1).toBe(72.696);
    expect(human!.p2).toBe(89.203);
    expect(isMajor(human!, bars.length - 1, wide)).toBe(true);
    // And it is genuinely absent at the default, which is what makes the
    // raised cap above a measurement rather than a precaution.
    const atDefault = computeTrendlines(bars, CFG).lines.some(
      (l: TrendLine) =>
        l.k1 === "low" && l.k2 === "low" &&
        month(bars[l.i1].timestamp) === "2011-05" &&
        month(bars[l.i2].timestamp) === "2021-01",
    );
    expect(atDefault).toBe(false);
  });

  // The secular support the detector DOES carry at the pane default is the
  // 2011-05 -> 2026-01 pairing, which projects just under spot. Re-measured
  // for the sideless detector at MAX_LIVE_MULT 16: 96.122 against a 99.267
  // close, 3.145 under it (the human 2021-01 pairing projected 98.737, 0.53
  // under, which is where the old "within a point" bound came from).
  it("projects the secular low-to-low line just under spot", () => {
    const { lines } = computeTrendlines(bars, CFG);
    const last = bars.length - 1;
    const lineB = lines.find(
      (l: TrendLine) =>
        l.k1 === "low" &&
        l.k2 === "low" &&
        month(bars[l.i1].timestamp) === "2011-05" &&
        month(bars[l.i2].timestamp) === "2026-01",
    );
    expect(lineB, "no low->low line 2011-05 -> 2026-01").toBeDefined();
    const proj = projectAt(lineB!, last);
    const close = bars[last].close;
    expect(proj).toBeLessThan(close);
    expect(close - proj).toBeLessThan(3.5);
  });

  // The nearest-to-close operand reads real, current geometry rather than
  // stale far-off-screen lines: within a few points under the close. It is
  // the nearest AMONG THE DRAWN lines (the merged top maxLines), which is why
  // the band is wider than the hand-drawn lines' own neighbourhood.
  it("emits a tl_nearest value a few points under the close on the last bar", () => {
    const { points } = computeTrendlines(bars, CFG);
    const last = points[points.length - 1];
    const close = bars[bars.length - 1].close;
    expect(last.tl_nearest).toBeLessThan(close);
    expect(close - (last.tl_nearest as number)).toBeLessThan(5);
  });

  // THE CEILINGS USED TO STARVE THE LIVE SET. The cap's first key is
  // overCeilings, and it exists because the rest of the survival order rewards
  // exactly what Max Touches and Max Span disqualify: without it the rejects
  // took the front of the MAX_LIVE_MULT x maxLines slots and evicted the lines
  // still able to emit. Measured on this fixture before that fix, the top
  // operand fired on 246 bars at maxLines 3 against 442 at maxLines 12.
  //
  // The invariant, stated so it cannot regress quietly: a ceiling's effect must
  // not depend on maxLines, which is a DRAWING budget. Read through tl_nearest,
  // which is present whenever any line qualifies, so the count is the number of
  // bars the detector had something to say at all.
  it.each([
    { name: "Max Touches", patch: { maxTouches: 2 } },
    { name: "Max Span", patch: { maxSpanBars: 40 } },
  ])("keeps $name from starving the live cap", ({ patch }) => {
    const fires = (maxLines: number) =>
      computeTrendlines(bars, {
        ...TRENDLINES_DEFAULTS,
        ...patch,
        maxLines,
      }).points.filter((p) => p.tl_nearest !== undefined).length;
    const tight = fires(3);
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBe(fires(12));
  });

  // WHAT THE PANE ACTUALLY SHOWS. computeTrendlines keeps MAX_LIVE_MULT x
  // maxLines lines alive IN TOTAL, which on this fixture at the pane default is
  // 48, and their projections on the last bar run from -58.9 to 207.5 against a
  // close of 99.27: valid geometry, and nowhere near the chart. Max Distance
  // is the cut for that, and it runs INSIDE the calc: a candidate too far from
  // the close on its confirm bar is never built, and a live line is dropped
  // the bar it strays. The drawn set is then rank order, merged, budgeted.
  it("draws only the lines in play, not the 1990s geometry", () => {
    const { lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = bars.length - 1;
    const close = bars[last].close;
    expect(lines.length).toBeGreaterThan(20); // the live set really is crowded
    const stale = [13.277, 15.777, 31.833, 57.364, 61.796, 207.503];
    // Pinned by value, so a drift in the geometry shows up here as a real
    // failure rather than a vacuously empty filter. Re-measured when the touch
    // rule split into Max Touch Gap and Max Pierce: 13.277 took 10.987's place
    // in the live set, the other five are unchanged.
    for (const v of stale) {
      expect(
        lines.some((l) => Math.abs(projectAt(l, last) - v) < 0.01),
        `live set lost the ${v} line`,
      ).toBe(true);
    }
    const cut = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, maxDistAtr: TL_NEAR_PRICE_ATR });
    const a = cut.atr[last] as number;
    expect(cut.lines.length).toBeGreaterThan(0);
    expect(cut.lines.length).toBeLessThan(lines.length);
    const projections = cut.lines.map((l) => projectAt(l, last));
    for (const v of stale) expect(projections.some((p) => Math.abs(p - v) < 0.01)).toBe(false);
    // Every live line is within the cut at the last bar, and every drawn
    // anchor is 2000 or later: no 1990s line resurfaces.
    for (const p of projections) expect(Math.abs(p - close)).toBeLessThanOrEqual(a * TL_NEAR_PRICE_ATR);
    const drawn = selectDrawnLines(cut.lines, last, close, TRENDLINES_DEFAULTS.maxLines, {
      tol: a * TL_DEDUPE_ATR,
      keep: new Set(),
    });
    expect(drawn.length).toBeGreaterThan(0);
    for (const l of drawn) expect(month(bars[l.i1].timestamp) >= "2000-01").toBe(true);
  });

  // maxLines is not just a drawing budget: it sizes live state, so it changes
  // WHAT A RULE READS. Pinned so that "maxLines does not affect operands" can
  // never be written in user-facing copy. Re-measured for the sideless
  // detector at MAX_LIVE_MULT 16: 422 differing points, of which 130 differ in
  // tl_nearest (the rest gain a tl_3 the two-line config has no slot for).
  it("changes an emitted value between maxLines 2 and 3", () => {
    const two = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, maxLines: 2 }).points;
    const three = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, maxLines: 3 }).points;
    const differing = two.filter((p, i) => JSON.stringify(p) !== JSON.stringify(three[i]));
    expect(differing).toHaveLength(422);
    // A named bar, so a drift is diagnosable rather than just red: at 1995-03
    // the third drawn line is the nearest, and tl_nearest reads only the
    // drawn set, so the two-line pane reports a farther line there.
    expect(month(bars[112].timestamp)).toBe("1995-03");
    expect(two[112].tl_nearest).toBeCloseTo(96.327, 3);
    expect(three[112].tl_nearest).toBeCloseTo(70.29, 3);
  });

  // The invariant that lets the seed loop carry no duplicate check: a line is
  // identified by (i1, k1, i2, k2) and cannot be built twice, because every
  // stored i2 is an earlier confirm bar and this bar's pool entries are
  // distinct. (i1, i2) alone is not enough: a lone spike bar can be both a
  // strict high pivot and a strict low pivot, so it seeds two distinct lines
  // against the same other anchor, one per kind.) Asserted here rather than
  // defended with a per-candidate scan of live state, which fired zero times
  // and cost a quarter of the run.
  it("never builds the same (i1, k1, i2, k2) line twice", () => {
    const seen = new Set<string>();
    const { lines } = computeTrendlines(bars, {
      ...TRENDLINES_DEFAULTS,
      pivotLen: 2,
      pairPivots: 100,
      // Nothing is ever pruned, so the final list is every line the detector
      // built across the whole series, not just the survivors.
      maxLines: 100_000,
      maxProjBars: 100_000,
    });
    expect(lines.length).toBeGreaterThan(20);
    for (const l of lines) {
      const key = `${l.i1}:${l.k1}:${l.i2}:${l.k2}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
