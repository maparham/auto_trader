// The incremental calc session: per-tick recompute of only the forming bar,
// bit-identical to computeTrendlines from scratch. The live chart re-runs calc
// on EVERY tick (klinecharts _addData -> _calcIndicator over the full series),
// and a from-scratch run costs ~30ms at BTCUSD bar counts — the session is what
// makes that tick path O(last bar) instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { Indicator } from "klinecharts";
import {
  computeTrendlines,
  createTrendlinesSession,
  pivotPriceAt,
  registerTrendlinesChart,
  TRENDLINES_TEMPLATE,
  type TrendlinesCalcPoint,
} from "./trendlines";
import {
  parseTrendlinesConfig,
  TRENDLINES_DEFAULTS,
} from "./trendlinesOutputs";
import { isIndicatorBusy } from "../indicatorBusy";

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
    expect(pv.idxs.length).toBeGreaterThan(0);
    expect(pv.kinds).toContain("high");
    expect(pv.kinds).toContain("low");
    // The marks carry the prices the swings turned at, which is what the draw
    // path paints against instead of re-reading the chart's own bars.
    for (let q = 0; q < pv.idxs.length; q++) {
      const idx = pv.idxs[q];
      const expected = pv.kinds[q] === "high" ? bars[idx].high : bars[idx].low;
      expect(pivotPriceAt(pv, q)).toBe(expected);
    }
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

  // THE FORK COPIES THE SPACING SCALARS. cloneTrendLine spreads, so they ride
  // along for free — and that is exactly why this needs its own test: a future
  // rewrite that lists fields explicitly (the way touchIdxs already has to,
  // being an array) would drop them silently, and `undefined > n` is false, so
  // the ceiling would quietly stop firing on the live chart while every
  // from-scratch test stayed green.
  it("carries touch spacing through the fork, with the ceiling ON", () => {
    const bars = synthBars(400);
    // calcParams order: [pivotLen, touchMult, minTouches, minSpanBars,
    // maxProjBars, maxLines, minSwingAtr, minSwingReach, pairPivots,
    // maxTouches, maxSpanBars, maxSlopeAtr, minSlopeAtr, maxTouchSpacing,
    // minTouchSpacing, minCrossings, maxCrossings].
    const gated = parseTrendlinesConfig([
      5, 0.75, 2, 20, 250, 10, 0, 0, 20, 0, 0, 0, 0, 30, 0, 0, 0,
    ]);
    expect(gated.maxTouchSpacing).toBe(30);
    const session = createTrendlinesSession();
    const rand = lcg(11);
    for (let i = 0; i < 25; i++) {
      if (i > 0) tick(bars, rand);
      const inc = session.compute(bars, gated);
      const ref = computeTrendlines(bars, gated);
      expect(inc.lines).toEqual(ref.lines);
      expect(inc.points).toEqual(ref.points);
    }
    // Not vacuous twice over: lines exist, and the ceiling actually bites on
    // this walk rather than passing because nothing reached it.
    const { lines, points } = computeTrendlines(bars, gated);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.maxTouchGap > 30)).toBe(true);
    const ungated = computeTrendlines(bars, parseTrendlinesConfig(undefined));
    expect(JSON.stringify(points)).not.toBe(JSON.stringify(ungated.points));
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
    expect(last.tl_1).toEqual(ref.points[ref.points.length - 1].tl_1);
    expect(last.tl_nearest).toEqual(
      ref.points[ref.points.length - 1].tl_nearest,
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
      pivots: { idxs: [], kinds: [], highs: [], lows: [] },
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

describe("TRENDLINES_TEMPLATE.calc rebuild coalescing", () => {
  type Rows = TrendlinesCalcPoint[];
  const calc = TRENDLINES_TEMPLATE.calc as (d: KLineData[], i: Indicator) => Rows;
  // A prepend: klinecharts builds a NEW list with older bars in front.
  const prepended = (bars: KLineData[], k: number): KLineData[] => {
    const older = synthBars(k, 11).map((b, j) => ({
      ...b,
      timestamp: bars[0].timestamp - (k - j) * 60_000,
    }));
    return [...older, ...bars];
  };
  // A stand-in for klinecharts: whatever calc returns becomes ind.result, and
  // the out-of-band rebuild asks for its recalc through overrideIndicator.
  const unregister: (() => void)[] = [];
  const harness = (bars: KLineData[]) => {
    const ind = { name: "TL", calcParams: [], extendData: undefined, result: [] } as unknown as Indicator;
    const h = {
      ind,
      list: bars,
      recalcs: 0,
      run: (): Rows => {
        ind.result = calc(h.list, ind);
        return ind.result as Rows;
      },
      setFloor: (ts: number) => {
        (ind as { extendData: unknown }).extendData = { tlFloorTs: ts };
      },
    };
    const chart = {
      getIndicators: () => [ind],
      overrideIndicator: () => {
        h.recalcs++;
        h.run();
        return true;
      },
    };
    unregister.push(registerTrendlinesChart(chart as never));
    return h;
  };
  const lastLines = (rows: Rows) => rows[rows.length - 1].lines;
  const build = async (h: ReturnType<typeof harness>) => {
    h.run();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.recalcs).toBe(1);
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    unregister.splice(0).forEach((u) => u());
    vi.useRealTimers();
  });

  it("a 400-bar first compute runs inline with no busy mark", () => {
    const h = harness(synthBars(400));
    expect(h.run()).toHaveLength(400);
    expect(isIndicatorBusy(h.ind)).toBe(false);
  });

  it("a 600-bar rebuild returns at once, then computes after the settle window", async () => {
    const bars = synthBars(600);
    const h = harness(bars);
    expect(h.run()).toEqual([]);
    expect(isIndicatorBusy(h.ind)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.recalcs).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.recalcs).toBe(1);
    expect(isIndicatorBusy(h.ind)).toBe(false);
    expect(lastLines(h.ind.result as Rows)).toEqual(computeTrendlines(bars, cfg).lines);
  });

  it("an append-only calc on a big built list stays inline", async () => {
    const h = harness(synthBars(2500));
    await build(h);
    tick(h.list, lcg(3));
    expect(h.run()).toHaveLength(2500);
    expect(isIndicatorBusy(h.ind)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.recalcs).toBe(1);
  });

  it("a prepend then a floor stamp 200 ms later compute once, from the newest inputs", async () => {
    const h = harness(synthBars(1500));
    await build(h);
    h.list = prepended(h.list, 300);
    // A prepend shifts every index, so the old rows are blanked, not kept.
    expect(h.run()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    h.setFloor(h.list[100].timestamp);
    h.run();
    // 300 ms after the prepend: the floor stamp pushed the window.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.recalcs).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.recalcs).toBe(2);
    expect(h.ind.result).toHaveLength(h.list.length);
    expect(isIndicatorBusy(h.ind)).toBe(false);
  });

  it("prepend then tick computes once from the newest list", async () => {
    const h = harness(synthBars(1500));
    await build(h);
    h.list = prepended(h.list, 300);
    h.run();
    tick(h.list, lcg(9));
    h.run();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.recalcs).toBe(2);
    expect(lastLines(h.ind.result as Rows)).toEqual(computeTrendlines(h.list, cfg).lines);
  });

  it("ticks do not starve the rebuild", async () => {
    const h = harness(synthBars(1500));
    h.run();
    const rand = lcg(4);
    for (let t = 0; t < 3; t++) {
      await vi.advanceTimersByTimeAsync(100);
      tick(h.list, rand);
      h.run();
    }
    // 300 ms in: the ticks did not push the 250 ms window.
    expect(h.recalcs).toBe(1);
  });

  it("a prepend burst is capped at TL_SETTLE_MAX_MS", async () => {
    const h = harness(synthBars(1500));
    h.run();
    let t = 0;
    for (; t < 20; t++) {
      await vi.advanceTimersByTimeAsync(100);
      if (h.recalcs) break;
      h.list = prepended(h.list, 50);
      h.run();
    }
    // Prepends every 100 ms would slide a pure 250 ms window forever; the cap
    // lands the compute at about 1 s, on the newest list.
    expect(h.recalcs).toBe(1);
    expect(t).toBeLessThanOrEqual(10);
    expect(lastLines(h.ind.result as Rows)).toEqual(computeTrendlines(h.list, cfg).lines);
  });

  it("a config change during the window pushes it and computes with the new config", async () => {
    const h = harness(synthBars(1500));
    await build(h);
    h.list = prepended(h.list, 300);
    h.run();
    await vi.advanceTimersByTimeAsync(200);
    const params = Object.values({ ...TRENDLINES_DEFAULTS, minTouches: 3 });
    (h.ind as { calcParams: unknown }).calcParams = params;
    h.run();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.recalcs).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.recalcs).toBe(2);
    const ref = computeTrendlines(h.list, parseTrendlinesConfig(params as never));
    expect(lastLines(h.ind.result as Rows)).toEqual(ref.lines);
  });

  it("a failed compute neither loops nor leaves a stale window behind", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(synthBars(600));
    h.run();
    h.list.push(null as never); // the compute throws on this bar
    await vi.advanceTimersByTimeAsync(2000);
    expect(errs).toHaveBeenCalled();
    expect(h.recalcs).toBe(0);
    expect(isIndicatorBusy(h.ind)).toBe(false);
    h.list.pop();
    h.list = prepended(h.list, 100);
    h.run();
    // The next burst still waits its full window.
    await vi.advanceTimersByTimeAsync(200);
    expect(h.recalcs).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.recalcs).toBe(1);
    errs.mockRestore();
  });
});
