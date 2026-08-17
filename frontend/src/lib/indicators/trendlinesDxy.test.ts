// ACCEPTANCE test: does TRENDLINES find the lines a human draws?
//
// Every other test in this feature checks a mechanism (pivot geometry, break
// detection, config parsing) against synthetic data. This one is the only test
// that checks the thing the user actually asked for, against real DXY monthly
// bars captured from the running app (490 bars, 1985-11 to 2026-08). If this
// file stops passing honestly, the feature does not work no matter how green
// the rest of the suite is.
//
// This file is also the ONLY place tl_resistance / tl_broken_resistance are
// exercised: the synthetic fixtures elsewhere use flat highs, and strict
// fractal detection rejects flat extremes, so no resistance line ever forms
// there.

import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { isPivotAt } from "./pivots";
import { computeTrendlines, projectAt, selectDrawnLines, type TrendLine } from "./trendlines";
import { MAX_LIVE_MULT, TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesDxy.fixture.json";

// Lines a human draws on DXY monthly. Anchors are the bar's own high/low, so
// they are exact, not eyeballed.
//
// A third hand-drawn line, resistance 2002-03 (119.61) -> 2007-08 (82.132),
// is NOT listed here and is NOT expected: neither anchor is a fractal pivot at
// any lookback, so the detector cannot construct it. See the dedicated test
// below, which pins that cause rather than hiding it.
const EXPECTED = [
  { side: "support", from: "2011-05", fromPrice: 72.696, to: "2021-01", toPrice: 89.203 },
  { side: "resistance", from: "2022-09", fromPrice: 114.687, to: "2025-01", toPrice: 109.879 },
] as const;

const bars = fixture as unknown as KLineData[];
const month = (t: number): string => new Date(t).toISOString().slice(0, 7);
const indexOfMonth = (m: string): number => bars.findIndex((b) => month(b.timestamp) === m);

describe("TRENDLINES on DXY monthly", () => {
  it("has the fixture it expects", () => {
    expect(bars.length).toBeGreaterThan(400);
    expect(month(bars[bars.length - 1].timestamp)).toBe("2026-08");
  });

  it.each(EXPECTED)("surfaces the $from to $to $side line", (want) => {
    const { lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const found = lines.find(
      (l) =>
        l.side === want.side &&
        month(bars[l.i1].timestamp) === want.from &&
        month(bars[l.i2].timestamp) === want.to,
    );
    expect(found, `no ${want.side} line ${want.from} -> ${want.to}`).toBeDefined();
    expect(found!.p1).toBeCloseTo(want.fromPrice, 3);
    expect(found!.p2).toBeCloseTo(want.toPrice, 3);
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
  // Consequence: no resistance line spans the 2002-2007 decline at all. The
  // pool offers 2001-07 -> 2002-01 and then nothing until 2009-03.
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

  // The 2011 secular support projects to ~98.7 against a ~99.3 spot, i.e. just
  // under price. Asserted on the line itself: the emitted tl_support does NOT
  // carry that number (see the next test for what it does carry).
  it("projects the secular support line to within a point of spot", () => {
    const { lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = bars.length - 1;
    const lineB = lines.find(
      (l: TrendLine) =>
        l.side === "support" &&
        month(bars[l.i1].timestamp) === "2011-05" &&
        month(bars[l.i2].timestamp) === "2021-01",
    );
    expect(lineB, "no support line 2011-05 -> 2021-01").toBeDefined();
    const proj = projectAt(lineB!, last);
    const close = bars[last].close;
    expect(proj).toBeLessThan(close);
    expect(close - proj).toBeLessThan(1);
  });

  // The brief's original assertion, UNCHANGED. The emitted value comes from
  // 2011-05 -> 2026-01 at ~96.12, not from line B: line B broke in 2025-07, so
  // it can only reach tl_broken_support. Range kept as written so a drift in
  // either the projection or the selection still trips it.
  it("emits a support value in the high 90s on the last bar", () => {
    const { points } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = points[points.length - 1];
    expect(last.tl_support).toBeGreaterThan(96);
    expect(last.tl_support).toBeLessThan(100);
    // Line B, broken, still emits on the broken channel at its projection.
    expect(last.tl_broken_support).toBeCloseTo(98.737, 2);
  });

  // THE LOAD-BEARING RESISTANCE ASSERTION. A bare "tl_resistance is defined"
  // check passed even when the operand path emitted a 2009-03 -> 2017-01
  // artifact projecting 121.19 against a 99.27 close, i.e. it was green while
  // the pane showed a resistance 22 points above price and hid the live one.
  // So the value is pinned to line C's own projection instead: the emitted
  // number must BE the line a human would read off the chart.
  it("emits line C, not a stale artifact, as the last bar's resistance", () => {
    const { points, lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = bars.length - 1;
    const lineC = lines.find(
      (l: TrendLine) =>
        l.side === "resistance" &&
        month(bars[l.i1].timestamp) === "2022-09" &&
        month(bars[l.i2].timestamp) === "2025-01",
    );
    expect(lineC, "no resistance line 2022-09 -> 2025-01").toBeDefined();
    const want = projectAt(lineC!, last);
    expect(want).toBeCloseTo(106.616, 2); // pinned, so the line itself can't drift
    expect(points[last].tl_resistance).toBeCloseTo(want, 10);
  });

  // RESISTANCE COVERAGE. Nothing else in the suite reaches these two outputs
  // (see the file header), so they are asserted here on real data.
  it("emits resistance and broken-resistance values on real data", () => {
    const { points } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const res = points.filter((p) => p.tl_resistance !== undefined);
    const broken = points.filter((p) => p.tl_broken_resistance !== undefined);
    // Not a bare toBeDefined on a possibly-empty filter: both must cover a real
    // stretch of the series, and every emitted value must be a finite price.
    expect(res.length).toBeGreaterThan(100);
    expect(broken.length).toBeGreaterThan(20);
    for (const p of res) {
      expect(Number.isFinite(p.tl_resistance)).toBe(true);
      expect(p.tl_resistance).toBeGreaterThan(0);
    }
    for (const p of broken) {
      expect(Number.isFinite(p.tl_broken_resistance)).toBe(true);
      expect(p.tl_broken_resistance).toBeGreaterThan(0);
    }
    // An unbroken resistance sits at or above its bar's close, by construction.
    points.forEach((p, i) => {
      if (p.tl_resistance !== undefined) expect(p.tl_resistance).toBeGreaterThanOrEqual(bars[i].close);
    });
  });

  // WHAT THE PANE ACTUALLY SHOWS. computeTrendlines keeps MAX_LIVE_MULT (4) x
  // maxLines per side alive, which on this fixture is 22 lines, and four of the
  // support lines are 1990s geometry projecting to 10.99, 13.28, 31.83 and
  // 57.36 against a close of 99.27: valid, and nowhere near the chart. Drawing
  // the live set would bury the two lines a human reads. So the drawn set is
  // maxLines per side by proximity (plus the operands' own lines, which on THIS
  // bar all fall inside that budget, hence three a side), and this is the test
  // that proves the stale ones are gone.
  it("draws only the lines in play, not the 1990s geometry", () => {
    const { points, lines } = computeTrendlines(bars, TRENDLINES_DEFAULTS);
    const last = bars.length - 1;
    const close = bars[last].close;
    expect(lines.length).toBeGreaterThan(20); // the live set really is crowded
    const drawn = selectDrawnLines(lines, last, close, TRENDLINES_DEFAULTS.maxLines, points[last]);
    const projections = drawn.map((l) => projectAt(l, last));
    expect(drawn.filter((l) => l.side === "support")).toHaveLength(3);
    expect(drawn.filter((l) => l.side === "resistance")).toHaveLength(3);
    // The nearest pick per side, pinned. Not the whole six: resistance slot 3
    // (113.583) beats the first line out (113.587) by 0.004, so pinning all six
    // would be a hair-trigger on unrelated arithmetic.
    const nearestOf = (side: string): number =>
      drawn
        .filter((l) => l.side === side)
        .map((l) => projectAt(l, last))
        .sort((a, b) => Math.abs(a - close) - Math.abs(b - close))[0];
    expect(nearestOf("resistance")).toBeCloseTo(106.616, 2); // line C, 2022-09 -> 2025-01
    expect(nearestOf("support")).toBeCloseTo(98.737, 2); // line B, broken 2025-07
    // The four far-off-screen support projections must all be gone.
    for (const stale of [10.987, 13.277, 31.833, 57.364]) {
      expect(lines.some((l) => Math.abs(projectAt(l, last) - stale) < 0.01)).toBe(true);
      expect(projections.some((p) => Math.abs(p - stale) < 0.01)).toBe(false);
    }
    // Nothing drawn strays more than 15 points from spot on this fixture.
    for (const p of projections) expect(Math.abs(p - close)).toBeLessThan(15);
  });

  // THE CHART MUST NEVER HIDE AN OPERAND, checked on every chart state this
  // fixture can produce rather than on the last bar alone.
  //
  // Each prefix of the bars is a distinct chart state: what the pane showed the
  // day that bar closed. Emission makes four picks per bar (side x broken) but
  // the drawn budget is per SIDE, and a broken line sits nearest to price by
  // construction, so before selectDrawnLines unioned the emitting lines back in
  // this failed on 193 of 1286 emissions: tl_resistance invisible on 96 states,
  // tl_support on 73, tl_broken_resistance on 22, tl_broken_support on 2. An
  // isMajor gate does NOT fix it (measured: 96 -> 96); the union does, and this
  // is the test that keeps it fixed.
  //
  // Exact equality, not toBeCloseTo, on purpose: the emitted number IS
  // projectAt(line, i) from the same expression, so anything less than exact
  // would let a near-miss line stand in for the real one.
  it("draws a line at every emitted value, on every chart state", () => {
    const outputs = [
      { key: "tl_support", side: "support", broken: false },
      { key: "tl_resistance", side: "resistance", broken: false },
      { key: "tl_broken_support", side: "support", broken: true },
      { key: "tl_broken_resistance", side: "resistance", broken: true },
    ] as const;
    const seen: Record<string, number> = {};
    const invisible: string[] = [];
    for (let e = 0; e < bars.length; e++) {
      const { points, lines } = computeTrendlines(bars.slice(0, e + 1), TRENDLINES_DEFAULTS);
      const point = points[e] as Record<string, number | undefined>;
      const drawn = selectDrawnLines(
        lines,
        e,
        bars[e].close,
        TRENDLINES_DEFAULTS.maxLines,
        points[e],
      );
      for (const o of outputs) {
        const v = point[o.key];
        if (v === undefined) continue;
        seen[o.key] = (seen[o.key] ?? 0) + 1;
        const drawnAt = drawn.some(
          (l) => l.side === o.side && (l.brokenIdx !== null) === o.broken && projectAt(l, e) === v,
        );
        if (!drawnAt) invisible.push(`${o.key}@${e}=${v}`);
      }
    }
    // Guard the guard: a detector that emitted nothing would satisfy the
    // property vacuously, so every output must be exercised in bulk first.
    expect(seen.tl_support).toBeGreaterThan(300);
    expect(seen.tl_resistance).toBeGreaterThan(300);
    expect(seen.tl_broken_support).toBeGreaterThan(100);
    expect(seen.tl_broken_resistance).toBeGreaterThan(100);
    expect(invisible.slice(0, 10), `${invisible.length} invisible emissions`).toEqual([]);
  });

  // MAX_LIVE_MULT IS LOAD-BEARING, and nothing else pins it as BEHAVIOUR.
  // trendlinesOutputs.test.ts asserts the constant is 4; a suite that only does
  // that would stay green if the cap were deleted outright, because the cap
  // changes which lines survive, not how any one of them is computed.
  //
  // maxLines 2 is the setting where the bound bites on this fixture (the live
  // set really does reach 8 a side); at the default 3 it is slack for most of
  // the series.
  it("bounds live state at MAX_LIVE_MULT x maxLines per side", () => {
    const cfg = { ...TRENDLINES_DEFAULTS, maxLines: 2 };
    const bound = MAX_LIVE_MULT * cfg.maxLines;
    let worst = 0;
    for (let e = 0; e < bars.length; e++) {
      const { lines } = computeTrendlines(bars.slice(0, e + 1), cfg);
      for (const side of ["support", "resistance"] as const) {
        const n = lines.filter((l) => l.side === side).length;
        expect(n, `${side} live count at bar ${e}`).toBeLessThanOrEqual(bound);
        worst = Math.max(worst, n);
      }
    }
    // The cap is reached, so the assertion above is not vacuous.
    expect(worst).toBe(bound);
  });

  // ...and the cap CHANGES WHAT A RULE READS, which is the claim the settings
  // copy and the MAX_LIVE_MULT comment both make. Pinned as the count the spec
  // quotes plus one named bar, so a drift is diagnosable rather than just red.
  // At bar 171 the tighter setting drops tl_resistance entirely: a rule reading
  // it stops firing, which is exactly why "maxLines does not affect operands"
  // must never be written in user-facing copy.
  it("changes an emitted value between maxLines 2 and 3", () => {
    const two = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, maxLines: 2 }).points;
    const three = computeTrendlines(bars, { ...TRENDLINES_DEFAULTS, maxLines: 3 }).points;
    const differing = two.filter((p, i) => JSON.stringify(p) !== JSON.stringify(three[i]));
    expect(differing).toHaveLength(113);
    expect(two[171].tl_resistance).toBeUndefined();
    expect(three[171].tl_resistance).toBeCloseTo(134.604, 3);
  });
});
