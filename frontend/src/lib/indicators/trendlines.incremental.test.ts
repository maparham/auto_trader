// The incremental calc session: per-tick recompute of only the forming bar,
// bit-identical to computeTrendlines from scratch. The live chart re-runs calc
// on EVERY tick (klinecharts _addData -> _calcIndicator over the full series),
// and a from-scratch run costs ~30ms at BTCUSD bar counts — the session is what
// makes that tick path O(last bar) instead.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import type { Indicator } from "klinecharts";
import {
  computeTrendlines,
  createTrendlinesSession,
  pivotPrice,
  TRENDLINES_TEMPLATE,
  type TrendlinesCalcPoint,
} from "./trendlines";
import {
  parseTrendlinesConfig,
  TRENDLINES_DEFAULTS,
} from "./trendlinesOutputs";

// Deterministic random walk with enough wiggle to confirm pivots and seed
// lines (asserted below, so the equivalence checks are never vacuous).
function synthBars(n: number, seed = 7): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const bars: KLineData[] = [];
  let price = 50_000;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * price * 0.004;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + rand() * price * 0.002;
    const low = Math.min(open, close) - rand() * price * 0.002;
    bars.push({ timestamp: t, open, high, low, close, volume: 1 + rand() * 10 });
    price = close;
    t += 60_000;
  }
  return bars;
}

/** Replace the last bar in place, the way klinecharts applies a same-timestamp
 * tick (`this._dataList[dataCount - 1] = data` — same array, new element). */
function tick(bars: KLineData[], rand: () => number): void {
  const last = bars[bars.length - 1];
  const close = last.close + (rand() - 0.5) * last.close * 0.003;
  bars[bars.length - 1] = {
    ...last,
    close,
    high: Math.max(last.high, close),
    low: Math.min(last.low, close),
  };
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const cfg = parseTrendlinesConfig(undefined);

describe("createTrendlinesSession", () => {
  it("matches computeTrendlines across in-place tick updates", () => {
    const bars = synthBars(400);
    const session = createTrendlinesSession();
    const rand = lcg(1);
    // First compute establishes the cached base; every tick after must agree
    // with a from-scratch run over the same data.
    for (let i = 0; i < 25; i++) {
      if (i > 0) tick(bars, rand);
      const inc = session.compute(bars, cfg);
      const ref = computeTrendlines(bars, cfg);
      expect(inc.points).toEqual(ref.points);
      expect(inc.lines).toEqual(ref.lines);
      expect(inc.atr).toEqual(ref.atr);
      // The pivot marks come off the forked pool, so they get the same
      // bit-for-bit parity check the lines do: a mark that appeared or moved
      // on the incremental path would be a pool the fork mutated wrongly.
      expect(inc.pivots).toEqual(ref.pivots);
    }
    // Not vacuous: the fixture actually produces lines.
    expect(computeTrendlines(bars, cfg).lines.length).toBeGreaterThan(0);
    const pv = computeTrendlines(bars, cfg).pivots;
    expect(pv.support.length).toBeGreaterThan(0);
    expect(pv.resistance.length).toBeGreaterThan(0);
    // The marks carry the prices the swings turned at, which is what the draw
    // path paints against instead of re-reading the chart's own bars.
    for (const i of pv.support) expect(pivotPrice(pv, "support", i)).toBe(bars[i].low);
    for (const i of pv.resistance)
      expect(pivotPrice(pv, "resistance", i)).toBe(bars[i].high);
  });

  it("reuses prefix point rows by identity across ticks (proves the fast path ran)", () => {
    const bars = synthBars(400);
    const session = createTrendlinesSession();
    const rand = lcg(2);
    const first = session.compute(bars, cfg);
    tick(bars, rand);
    const second = session.compute(bars, cfg);
    // A from-scratch run allocates every row anew; the session must hand back
    // the SAME prefix row objects, which is what makes a tick O(last bar).
    expect(second.points[100]).toBe(first.points[100]);
    expect(second.points[bars.length - 2]).toBe(first.points[bars.length - 2]);
    // The forming bar's row is fresh each tick.
    expect(second.points[bars.length - 1]).not.toBe(first.points[bars.length - 1]);
  });

  it("matches computeTrendlines when bars are appended in place", () => {
    const all = synthBars(450);
    const bars = all.slice(0, 400);
    const session = createTrendlinesSession();
    const rand = lcg(3);
    session.compute(bars, cfg);
    for (let i = 400; i < 450; i++) {
      bars.push(all[i]); // same array ref, the way klinecharts appends
      tick(bars, rand);
      const inc = session.compute(bars, cfg);
      const ref = computeTrendlines(bars, cfg);
      expect(inc.points).toEqual(ref.points);
      expect(inc.lines).toEqual(ref.lines);
      expect(inc.atr).toEqual(ref.atr);
      // The pivot marks come off the forked pool, so they get the same
      // bit-for-bit parity check the lines do: a mark that appeared or moved
      // on the incremental path would be a pool the fork mutated wrongly.
      expect(inc.pivots).toEqual(ref.pivots);
    }
  });

  it("matches computeTrendlines after a history prepend (new array ref)", () => {
    const all = synthBars(600);
    let bars = all.slice(200); // newest 400
    const session = createTrendlinesSession();
    session.compute(bars, cfg);
    // klinecharts 'forward' load: data.concat(this._dataList) — a NEW array.
    bars = all.slice(0, 200).concat(bars);
    const inc = session.compute(bars, cfg);
    const ref = computeTrendlines(bars, cfg);
    expect(inc.points).toEqual(ref.points);
    expect(inc.lines).toEqual(ref.lines);
    expect(inc.atr).toEqual(ref.atr);
  });

  it("matches computeTrendlines after a config change", () => {
    const bars = synthBars(400);
    const session = createTrendlinesSession();
    session.compute(bars, cfg);
    const cfg2 = parseTrendlinesConfig([
      3, // pivotLen changed
      TRENDLINES_DEFAULTS.violMult,
      TRENDLINES_DEFAULTS.touchMult,
    ]);
    const inc = session.compute(bars, cfg2);
    const ref = computeTrendlines(bars, cfg2);
    expect(inc.points).toEqual(ref.points);
    expect(inc.lines).toEqual(ref.lines);
    expect(inc.atr).toEqual(ref.atr);
  });

  it("is used by TRENDLINES_TEMPLATE.calc: prefix rows shared across ticks, last row decorated", () => {
    const bars = synthBars(400);
    const rand = lcg(5);
    // The minimal Indicator surface calc reads: calcParams + extendData. The
    // same object across calls is the contract (klinecharts passes `this`).
    const ind = { calcParams: [], extendData: undefined } as unknown as Indicator;
    const calc = TRENDLINES_TEMPLATE.calc as (
      d: KLineData[],
      i: Indicator,
    ) => TrendlinesCalcPoint[];
    const first = calc(bars, ind);
    tick(bars, rand);
    const second = calc(bars, ind);
    // Fast path proof: shared prefix row objects (a from-scratch clone-per-row
    // calc allocates all 400 anew).
    expect(second[100]).toBe(first[100]);
    // The decorated last row still matches a from-scratch run bit for bit.
    const ref = computeTrendlines(bars, cfg);
    const last = second[second.length - 1];
    expect(last.lines).toEqual(ref.lines);
    expect(last.atr).toEqual(ref.atr[ref.atr.length - 1]);
    expect(last.lineIdx).toBe(bars.length - 1);
    expect(second.slice(0, -1)).toEqual(ref.points.slice(0, -1));
    expect(last.tl_support).toEqual(ref.points[ref.points.length - 1].tl_support);
    expect(last.tl_resistance).toEqual(
      ref.points[ref.points.length - 1].tl_resistance,
    );
    // Two indicator instances must not share a session (independent charts).
    const ind2 = { calcParams: [], extendData: undefined } as unknown as Indicator;
    const other = calc(bars, ind2);
    expect(other.length).toBe(bars.length);
    expect(other.slice(0, -1)).toEqual(ref.points.slice(0, -1));
  });

  it("handles short series (below ATR warm-up) and empty input", () => {
    const session = createTrendlinesSession();
    expect(session.compute([], cfg)).toEqual({
      points: [],
      lines: [],
      atr: [],
      pivots: { resistance: [], support: [], highs: [], lows: [] },
    });
    const bars = synthBars(10);
    const rand = lcg(4);
    for (let i = 0; i < 3; i++) {
      if (i > 0) tick(bars, rand);
      const inc = session.compute(bars, cfg);
      const ref = computeTrendlines(bars, cfg);
      expect(inc.points).toEqual(ref.points);
      expect(inc.atr).toEqual(ref.atr);
      // The pivot marks come off the forked pool, so they get the same
      // bit-for-bit parity check the lines do: a mark that appeared or moved
      // on the incremental path would be a pool the fork mutated wrongly.
      expect(inc.pivots).toEqual(ref.pivots);
    }
  });
});
