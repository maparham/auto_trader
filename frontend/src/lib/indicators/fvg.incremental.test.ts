// The incremental FVG calc session: per-tick recompute of only the forming bar
// (plain path) and a full reuse of the aligned series (MTF path), each equal to
// computeFvg from scratch. klinecharts re-runs calc on EVERY tick over the full
// loaded series, and three FVG instances at BTCUSD 1m bar counts made computeFvg
// the heaviest function on the tick path — the session is what makes it O(1)
// per tick instead of O(series).
import { describe, expect, it, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { Indicator, KLineData } from "klinecharts";
import {
  computeFvg,
  createFvgSession,
  FVG_TEMPLATE,
  type FvgCalcPoint,
  type FvgExtend,
} from "./fvg";
import { FVG_DEFAULTS, parseFvgConfig } from "./fvgOutputs";

const CFG = { ...FVG_DEFAULTS, minSize: 0.25 };

// Deterministic random walk with gaps frequent enough that live zones exist,
// get mitigated and expire (asserted below, so equivalence is never vacuous).
function synthBars(n: number, seed = 11): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const bars: KLineData[] = [];
  let price = 50_000;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    // Every 9th bar jumps hard enough to open a gap against bar i-2.
    const jump = i % 9 === 0 ? (rand() - 0.5) * price * 0.02 : 0;
    const open = price;
    const close = price + (rand() - 0.5) * price * 0.004 + jump;
    const high = Math.max(open, close) + rand() * price * 0.001;
    const low = Math.min(open, close) - rand() * price * 0.001;
    bars.push({ timestamp: t, open, high, low, close, volume: 1 });
    price = close;
    t += 60_000;
  }
  return bars;
}

/** Replace the last bar in place, the way klinecharts applies a same-timestamp
 * tick (`this._dataList[dataCount - 1] = data` — same array, new element). */
function tick(bars: KLineData[], rand: () => number): void {
  const last = bars[bars.length - 1];
  const close = last.close + (rand() - 0.5) * last.close * 0.004;
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

const scratch = (bars: KLineData[]) => computeFvg(bars, CFG);

describe("createFvgSession equivalence", () => {
  it("matches a from-scratch run tick after tick", () => {
    const bars = synthBars(400);
    const session = createFvgSession();
    const rand = lcg(3);
    let sawGaps = false;
    for (let k = 0; k < 40; k++) {
      tick(bars, rand);
      const inc = session.compute(bars, CFG);
      const ref = scratch(bars);
      expect(inc.points).toEqual(ref.points);
      expect(inc.gaps).toEqual(ref.gaps);
      if (ref.gaps.length) sawGaps = true;
    }
    expect(sawGaps).toBe(true); // the equivalence above is not vacuous
  });

  it("matches from scratch as bars close (append) and after a config change", () => {
    const bars = synthBars(200);
    const session = createFvgSession();
    const rand = lcg(5);
    for (let k = 0; k < 30; k++) {
      // A closed bar plus a fresh forming bar, appended in place.
      const last = bars[bars.length - 1];
      bars.push({
        ...last,
        timestamp: last.timestamp + 60_000,
        open: last.close,
        close: last.close * (1 + (rand() - 0.5) * 0.01),
      });
      expect(session.compute(bars, CFG)).toEqual(scratch(bars));
    }
    const other = { ...CFG, maxGaps: 1 };
    expect(session.compute(bars, other)).toEqual(computeFvg(bars, other));
    expect(session.compute(bars, CFG)).toEqual(scratch(bars));
  });

  it("matches from scratch after a history prepend (new array identity)", () => {
    const bars = synthBars(150);
    const session = createFvgSession();
    session.compute(bars, CFG);
    const prepended = [...synthBars(80, 29), ...bars];
    expect(session.compute(prepended, CFG)).toEqual(scratch(prepended));
  });

  it("reuses the closed-bar prefix rather than rebuilding it", () => {
    // The saving itself: after a tick, rows for closed bars are the SAME
    // objects, so no per-tick clone of the series happened.
    const bars = synthBars(120);
    const session = createFvgSession();
    const first = session.compute(bars, CFG).points;
    const before = first.slice(0, bars.length - 1);
    tick(bars, lcg(9));
    const after = session.compute(bars, CFG).points;
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
  });

  it("handles an empty and a too-short series", () => {
    const session = createFvgSession();
    expect(session.compute([], CFG)).toEqual(computeFvg([], CFG));
    const two = synthBars(2);
    expect(session.compute(two, CFG)).toEqual(scratch(two));
  });
});

describe("createFvgSession MTF path", () => {
  const chartBars = synthBars(300);
  const htfStarts = chartBars.filter((_, i) => i % 20 === 0).map((b) => b.timestamp);
  const mtf: FvgExtend["mtf"] = {
    timeframe: "HOUR",
    htfStarts,
    htfMs: 20 * 60_000,
    htfBullTop: htfStarts.map((_, i) => 100 + i),
    htfBullBottom: htfStarts.map((_, i) => 90 + i),
    htfBearTop: htfStarts.map((_, i) => 200 + i),
    htfBearBottom: htfStarts.map((_, i) => 190 + i),
    htfGaps: [{ side: "bull", top: 105, bottom: 95, createdTs: htfStarts[3] }],
  };

  it("matches the from-scratch MTF alignment, tick after tick", () => {
    const bars = [...chartBars];
    const session = createFvgSession();
    const rand = lcg(13);
    for (let k = 0; k < 10; k++) {
      tick(bars, rand);
      expect(session.compute(bars, CFG, { mtf })).toEqual(computeFvg(bars, CFG, { mtf }));
    }
    // Not vacuous: the aligned series carries real values.
    expect(session.compute(bars, CFG, { mtf }).points.at(-1)?.bullTop).toBeDefined();
  });

  it("realigns when the MTF series is replaced", () => {
    const bars = [...chartBars];
    const session = createFvgSession();
    session.compute(bars, CFG, { mtf });
    const shifted = { ...mtf, htfBullTop: mtf!.htfBullTop!.map((v) => (v as number) + 1000) };
    expect(session.compute(bars, CFG, { mtf: shifted })).toEqual(
      computeFvg(bars, CFG, { mtf: shifted }),
    );
  });

  it("realigns when bars are prepended under the same MTF series", () => {
    const bars = [...chartBars];
    const session = createFvgSession();
    session.compute(bars, CFG, { mtf });
    const prepended = [...synthBars(40, 31), ...bars];
    expect(session.compute(prepended, CFG, { mtf })).toEqual(
      computeFvg(prepended, CFG, { mtf }),
    );
  });
});

describe("FVG_TEMPLATE calc wiring", () => {
  const indFor = (ext: FvgExtend = {}) =>
    ({
      calcParams: [CFG.minSize, CFG.maxBars, CFG.maxGaps],
      extendData: ext,
    }) as unknown as Indicator;

  it("returns rows equal to a from-scratch calc across ticks, gaps on the last row", () => {
    const bars = synthBars(250);
    const ind = indFor();
    const calc = FVG_TEMPLATE.calc as (d: KLineData[], i: Indicator) => FvgCalcPoint[];
    const rand = lcg(17);
    for (let k = 0; k < 20; k++) {
      tick(bars, rand);
      const rows = calc(bars, ind);
      const ref = computeFvg(bars, parseFvgConfig(ind.calcParams));
      expect(rows).toHaveLength(bars.length);
      expect(rows[rows.length - 1].gaps).toEqual(ref.gaps);
      // Rows speak the BACKEND output names (toCalcRow), not the camelCase the
      // compute layer uses — hence the cast.
      const keyed = rows as unknown as Array<Record<string, number | undefined>>;
      expect(keyed.map((r) => r.bull_top)).toEqual(ref.points.map((p) => p.bullTop));
      expect(keyed.map((r) => r.bear_bottom)).toEqual(ref.points.map((p) => p.bearBottom));
    }
  });

  it("keeps a separate session per indicator instance", () => {
    const bars = synthBars(120);
    const calc = FVG_TEMPLATE.calc as (d: KLineData[], i: Indicator) => FvgCalcPoint[];
    const a = indFor();
    const b = { ...indFor(), calcParams: [CFG.minSize, CFG.maxBars, 1] } as Indicator;
    const rowsA = calc(bars, a);
    const rowsB = calc(bars, b);
    expect(rowsA[rowsA.length - 1].gaps).toEqual(computeFvg(bars, CFG).gaps);
    expect(rowsB[rowsB.length - 1].gaps).toEqual(
      computeFvg(bars, { ...CFG, maxGaps: 1 }).gaps,
    );
  });
});
