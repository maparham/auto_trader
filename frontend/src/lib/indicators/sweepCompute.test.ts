// SWEEP frontend series. Mirrors backend/tests/test_sweep.py: same rows, same
// expectations, per the parity contract in indicators/core.py.
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { atrSeries } from "../atr";
import { computeSweep, sweepScore, type SweepPoint } from "./sweepCompute";
import type { SweepConfig } from "./sweepOutputs";

const T0 = Date.UTC(2024, 0, 1, 20);
const HOUR = 3_600_000;

function bars(rows: Array<[number, number, number, number]>, step = HOUR): KLineData[] {
  return rows.map(([open, high, low, close], k) => ({ timestamp: T0 + k * step, open, high, low, close, volume: 1 }));
}

const CFG: SweepConfig = {
  pivotLeft: 1, pivotRight: 1, levelMaxAge: 10, minWickPct: 50, atrLen: 2, minRangeAtr: 1,
  volLen: 20, volZ: 2, minScore: 70, confirmBars: 2, usePrevDay: false, useVolume: false,
  usePrevBar: true, reversalsOnly: false, tz: "UTC",
};

const col = (cfg: SweepConfig, data: KLineData[], key: keyof SweepPoint) =>
  computeSweep(data, cfg).map((p) => p[key] ?? null);

const SWEEP_ROWS: Array<[number, number, number, number]> = [
  [100, 101, 99, 100],
  [100, 103, 99.5, 102],
  [102, 102, 100, 101],
  [101, 102, 100, 101],
  [101, 106, 100.5, 101],
  [101, 102, 100, 101],
  [101, 102, 100.5, 101.5],
];

const zeros = (n: number) => new Array(n).fill(0);
const nulls = (n: number) => new Array(n).fill(null);

describe("computeSweep", () => {
  it("flags and confirms a bear sweep", () => {
    const b = bars(SWEEP_ROWS);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(col(CFG, b, "bullSweep")).toEqual(zeros(7));
    expect(col(CFG, b, "bearConfirmed")).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(col(CFG, b, "score")[4]).toBe(100);
    expect(col(CFG, b, "sweptLevel")).toEqual([...nulls(4), 103, 103, 103]);
    expect(col(CFG, b, "barsSince")).toEqual([...nulls(4), 0, 1, 2]);
    expect(computeSweep(b, CFG)[4].levelFrom).toBe(1);
    expect(computeSweep(b, CFG)[4].src).toBe("pivot");
  });

  it("emits 0 events from bar 0", () => {
    const b = bars(SWEEP_ROWS.slice(0, 2));
    for (const k of ["bearSweep", "bullSweep", "bearConfirmed", "bullConfirmed"] as const) {
      expect(col(CFG, b, k)).toEqual([0, 0]);
    }
  });

  it("lets a breakout kill the level", () => {
    const rows = [...SWEEP_ROWS.slice(0, 4), [101, 106, 100.5, 104], [104, 104.5, 101, 102]] as Array<[number, number, number, number]>;
    expect(col(CFG, bars(rows), "bearSweep")).toEqual(zeros(6));
  });

  it("drops a pending sweep on a close back through", () => {
    const rows = [...SWEEP_ROWS.slice(0, 5), [101, 104, 100.5, 103.5], [101, 102, 100.5, 101.5]] as Array<[number, number, number, number]>;
    const b = bars(rows);
    expect(col(CFG, b, "bearSweep")[4]).toBe(1);
    expect(col(CFG, b, "bearConfirmed")).toEqual(zeros(7));
  });

  it("takes the highest crossed level and kills every crossed one", () => {
    const b = bars([
      [100, 101, 99, 100],
      [100, 104, 99.5, 102],
      [102, 102, 100, 101],
      [101, 103, 100, 101],
      [101, 102, 100, 101],
      [101, 106, 100.5, 101],
      [101, 103.5, 100.5, 101],
    ]);
    expect(col(CFG, b, "sweptLevel")[5]).toBe(104);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0, 0, 0, 0, 1, 0]);
  });

  it("flags neither side on an outside-bar tie", () => {
    const b = bars([
      [100, 101, 99, 100],
      [100, 103, 99.5, 102],
      [102, 102, 97, 99],
      [99, 101, 98, 100],
      [100, 106, 94, 100],
      [100, 104, 96, 100],
    ]);
    expect(col(CFG, b, "bearSweep")).toEqual(zeros(6));
    expect(col(CFG, b, "bullSweep")).toEqual(zeros(6));
  });

  it("expires a level after levelMaxAge", () => {
    const b = bars(SWEEP_ROWS);
    expect(col({ ...CFG, levelMaxAge: 2 }, b, "bearSweep")[4]).toBe(1);
    expect(col({ ...CFG, levelMaxAge: 1 }, b, "bearSweep")).toEqual(zeros(7));
  });

  it("never treats an unconfirmed pivot as a level", () => {
    expect(col({ ...CFG, pivotRight: 3 }, bars(SWEEP_ROWS), "bearSweep")).toEqual(zeros(7));
  });

  it("replaces a pending sweep with a new flag", () => {
    const b = bars([
      [100, 101, 99, 100],
      [100, 103, 99.5, 102],
      [102, 102, 98, 101],
      [101, 102, 99, 101],
      [101, 106, 100.5, 101],
      [101, 101.5, 97, 101.2],
      [101, 102, 100.5, 101.5],
      [101, 102, 100.5, 101.5],
    ]);
    expect(col(CFG, b, "bearSweep")[4]).toBe(1);
    expect(col(CFG, b, "bullSweep")[5]).toBe(1);
    expect(col(CFG, b, "sweptLevel")[5]).toBe(98);
    expect(col(CFG, b, "bearConfirmed")).toEqual(zeros(8));
    expect(col(CFG, b, "bullConfirmed")).toEqual([...zeros(7), 1]);
  });

  it("keeps wick and close without range credit under minScore", () => {
    const b = bars(SWEEP_ROWS);
    const cfg = { ...CFG, minRangeAtr: 1000 };
    expect(col(cfg, b, "bearSweep")).toEqual(zeros(7));
    expect(col(cfg, b, "sweptLevel")).toEqual(nulls(7));
  });

  const PREV_DAY_ROWS: Array<[number, number, number, number]> = [
    [100, 101, 100, 101],
    [101, 102, 101, 102],
    [102, 103, 102, 103],
    [103, 105, 103, 105],
    [104, 107, 103, 104],
  ];

  it("treats the previous day's high as a level", () => {
    const cfg = { ...CFG, usePrevDay: true };
    const pts = computeSweep(bars(PREV_DAY_ROWS), cfg);
    expect(pts.map((p) => p.bearSweep)).toEqual([0, 0, 0, 0, 1]);
    expect(pts[4].sweptLevel).toBe(105);
    expect(pts[4].src).toBe("day");
  });

  it("buckets days in the pane tz", () => {
    const cfg = { ...CFG, usePrevDay: true, tz: "Asia/Tokyo" };
    expect(col(cfg, bars(PREV_DAY_ROWS), "bearSweep")).toEqual(zeros(5));
  });

  it("blanks previous-day levels on weekly bars", () => {
    const cfg = { ...CFG, usePrevDay: true };
    expect(col(cfg, bars(PREV_DAY_ROWS, 7 * 24 * HOUR), "bearSweep")).toEqual(zeros(5));
  });
});

describe("previous-candle outside-bar reversal (usePrevBar)", () => {
  const REV_BULL_ROWS: Array<[number, number, number, number]> = [
    [102, 103, 100, 101], // bearish prev candle
    [101, 105, 99, 104], // low below prev low, close above prev high
  ];
  const REV_BEAR_ROWS: Array<[number, number, number, number]> = [
    [100, 103, 99, 102], // bullish prev candle
    [102, 106, 95, 97], // high above prev high, close below prev low
  ];

  it("flags a bull reversal", () => {
    const b = bars(REV_BULL_ROWS);
    expect(col(CFG, b, "bullSweep")).toEqual([0, 1]);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0]);
    expect(col(CFG, b, "sweptLevel")[1]).toBe(100);
    expect(computeSweep(b, CFG)[1].src).toBe("bar");
  });

  it("flags a bear reversal", () => {
    const b = bars(REV_BEAR_ROWS);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 1]);
    expect(col(CFG, b, "bullSweep")).toEqual([0, 0]);
    expect(col(CFG, b, "sweptLevel")[1]).toBe(103);
    expect(computeSweep(b, CFG)[1].src).toBe("bar");
  });

  it("gives no reversal on a doji prev candle", () => {
    const b = bars([
      [101, 103, 100, 101], // doji: close === open
      [101, 105, 99, 104], // same bull geometry as REV_BULL_ROWS
    ]);
    expect(col(CFG, b, "bullSweep")).toEqual([0, 0]);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0]);
  });

  it("yields to a more extreme stored level", () => {
    // A stored low pivot (90, born bar 2) is more extreme than the
    // previous-candle level (91, from bearish bar 3) and is also crossed
    // and reclaimed this bar: the stored level wins.
    const rows: Array<[number, number, number, number]> = [
      [100, 101, 99, 100.5],
      [95, 96, 90, 95.5], // pivot low at bar 1
      [95, 95.5, 94, 95], // confirms the pivot; level (90) born here
      [93, 94, 91, 92], // bearish: candle i-1 for bar 4's bull reversal
      [93, 97, 85, 96], // crosses both the stored level and prev low
    ];
    const b = bars(rows);
    expect(col(CFG, b, "bullSweep")[4]).toBe(1);
    expect(col(CFG, b, "bearSweep")[4]).toBe(0);
    expect(col(CFG, b, "sweptLevel")[4]).toBe(90);
    expect(computeSweep(b, CFG)[4].src).toBe("pivot");
  });

  it("gives neither reversal on the wrong-coloured prev candle", () => {
    const b = bars([
      [100, 103, 99, 102],
      [101, 105, 97, 104],
    ]);
    expect(col(CFG, b, "bullSweep")).toEqual([0, 0]);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0]);
  });

  it("creates no reversal level when the close is not beyond the opposite extreme", () => {
    const b = bars([
      [103, 104, 100, 101],
      [101, 103, 98, 102],
    ]);
    expect(col(CFG, b, "bullSweep")).toEqual([0, 0]);
    expect(col(CFG, b, "bearSweep")).toEqual([0, 0]);
  });

  it("always flags, even above the score gate", () => {
    const cfg = { ...CFG, minScore: 100, minRangeAtr: 1000 };
    const b = bars(REV_BULL_ROWS);
    expect(col(cfg, b, "bullSweep")).toEqual([0, 1]);
    expect((col(cfg, b, "score")[1] as number)).toBeLessThan(100);
  });

  it("does not flag with the toggle off", () => {
    const cfg = { ...CFG, usePrevBar: false };
    const b = bars(REV_BULL_ROWS);
    expect(col(cfg, b, "bullSweep")).toEqual([0, 0]);
    expect(col(cfg, b, "bullReversal")).toEqual([0, 0]);
  });

  it("reversal outputs mark only reversal bars", () => {
    expect(col(CFG, bars(REV_BULL_ROWS), "bullReversal")).toEqual([0, 1]);
    expect(col(CFG, bars(REV_BULL_ROWS), "bearReversal")).toEqual([0, 0]);
    expect(col(CFG, bars(REV_BEAR_ROWS), "bearReversal")).toEqual([0, 1]);
    expect(col(CFG, bars(REV_BEAR_ROWS), "bullReversal")).toEqual([0, 0]);
  });

  it("beats a normal opposite-side flag on the same bar", () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100.5, 99, 99.5],
      [105, 110, 104, 106], // pivot high at bar 1
      [105, 106, 104, 105], // confirms the pivot; level (110) born here
      [103, 104, 100, 101], // bearish: candle i-1 for bar 4's bull reversal
      [105, 112, 95, 107], // crosses stored 110 AND satisfies bull reversal
    ];
    const b = bars(rows);
    expect(col(CFG, b, "bullSweep")[4]).toBe(1);
    expect(col(CFG, b, "bearSweep")[4]).toBe(0);
    expect(col(CFG, b, "sweptLevel")[4]).toBe(100);
    expect(col(CFG, b, "bullReversal")[4]).toBe(1);
    const atrPrev = atrSeries(b, CFG.atrLen)[3];
    const s = sweepScore(CFG, true, 105, 112, 95, 107, atrPrev, null);
    expect(s).toBeGreaterThanOrEqual(CFG.minScore);
  });
});

describe("reversalsOnly", () => {
  const REV_BULL_ROWS: Array<[number, number, number, number]> = [
    [102, 103, 100, 101], // bearish prev candle
    [101, 105, 99, 104], // low below prev low, close above prev high
  ];

  it("skips pivot births entirely, so no stored level ever flags", () => {
    // SWEEP_ROWS flags a bear pivot sweep at bar 4 off reversalsOnly (see
    // the top-level "flags and confirms a bear sweep" test); on, no stored
    // level is ever born.
    const cfg = { ...CFG, reversalsOnly: true };
    const b = bars(SWEEP_ROWS);
    expect(col(cfg, b, "bearSweep")).toEqual(zeros(7));
    expect(col(cfg, b, "bullSweep")).toEqual(zeros(7));
  });

  it("evaluates the previous-candle reversal even with usePrevBar off", () => {
    const cfg = { ...CFG, reversalsOnly: true, usePrevBar: false };
    const b = bars(REV_BULL_ROWS);
    expect(col(cfg, b, "bullSweep")).toEqual([0, 1]);
    expect(col(cfg, b, "bullReversal")).toEqual([0, 1]);
    expect(col(cfg, b, "sweptLevel")[1]).toBe(100);
  });
});

describe("sweepScore", () => {
  it("scores range 0 as 0", () => {
    expect(sweepScore(CFG, true, 1, 1, 1, 1, 1, null)).toBe(0);
  });
  it("rescales weights when volume is on", () => {
    const cfg = { ...CFG, useVolume: true };
    expect(sweepScore(cfg, true, 101, 106, 100.5, 101, 1, null)).toBeCloseTo(75, 10);
    expect(sweepScore(cfg, true, 101, 106, 100.5, 101, 1, 4)).toBeCloseTo(100, 10);
  });
});
