// Golden-master generator for backend/tests/test_sweep_parity.py. Runs the
// SAME computeSweep the chart uses over a deterministic random walk and
// writes backend/tests/fixtures/sweep_golden.json; Python must reproduce
// every value exactly. Re-run after changing sweepCompute.ts math.
/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { KLineData } from "klinecharts";
import { computeSweep } from "./sweepCompute";
import { parseSweepConfig, SWEEP_OUTPUTS } from "./sweepOutputs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../../backend/tests/fixtures/sweep_golden.json");

/** Deterministic LCG (Numerical Recipes constants), no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCandles(n: number): KLineData[] {
  const rnd = lcg(7);
  const out: KLineData[] = [];
  let close = 100;
  const startMs = 1700000000000; // hourly bars
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(1, open + (rnd() - 0.5) * 2);
    // Occasional long wicks so sweeps actually happen.
    const spike = rnd() < 0.08 ? rnd() * 3 : 0;
    const high = Math.max(open, close) + rnd() * 0.5 + (rnd() < 0.5 ? spike : 0);
    const low = Math.min(open, close) - rnd() * 0.5 - (rnd() < 0.5 ? spike : 0);
    const volume = Math.floor(rnd() * 1000) + 1 + (spike ? 2000 : 0);
    out.push({ timestamp: startMs + i * 3600_000, open, high, low, close, volume });
  }
  return out;
}

const CASES: Array<{ name: string; calcParams: number[]; extendData: Record<string, unknown> }> = [
  { name: "defaults", calcParams: [], extendData: { tz: "UTC", usePrevBar: false } },
  {
    name: "loose_ny_volume",
    calcParams: [2, 2, 60, 40, 14, 1, 20, 1.5, 50, 2],
    extendData: { tz: "America/New_York", useVolume: true, usePrevBar: false },
  },
  {
    name: "no_prev_day",
    calcParams: [3, 3, 100, 50, 14, 1.2, 20, 2, 60, 3],
    extendData: { usePrevDay: false, usePrevBar: false },
  },
  { name: "prev_bar", calcParams: [], extendData: { tz: "UTC", usePrevBar: true } },
  { name: "reversals_only", calcParams: [], extendData: { tz: "UTC", reversalsOnly: true } },
];

describe("sweep golden", () => {
  it("writes the fixture", () => {
    const candles = makeCandles(1200);
    const ptsByName = new Map<string, ReturnType<typeof computeSweep>>();
    const cases = CASES.map((c) => {
      const pts = computeSweep(candles, parseSweepConfig(c.calcParams, c.extendData));
      ptsByName.set(c.name, pts);
      const series: Record<string, Array<number | null>> = {};
      for (const o of SWEEP_OUTPUTS) series[o] = pts.map((p) => p[o] ?? null);
      return { ...c, series };
    });
    // The loose case must exercise both sides, or the fixture proves little.
    const loose = cases[1].series;
    expect(loose.bearSweep.some((v) => v === 1)).toBe(true);
    expect(loose.bullSweep.some((v) => v === 1)).toBe(true);
    expect(loose.bearConfirmed.some((v) => v === 1) || loose.bullConfirmed.some((v) => v === 1)).toBe(true);
    // The prev_bar case must exercise the reversal path at least once, or
    // the fixture proves nothing about usePrevBar.
    const prevBarPts = ptsByName.get("prev_bar")!;
    expect(prevBarPts.some((p) => p.src === "bar")).toBe(true);
    // The reversals_only case must exercise the reversal path too, and
    // never a stored level, or the fixture proves nothing about the option.
    const reversalsOnlyPts = ptsByName.get("reversals_only")!;
    expect(reversalsOnlyPts.some((p) => p.src === "bar")).toBe(true);
    expect(reversalsOnlyPts.every((p) => p.src !== "pivot" && p.src !== "day")).toBe(true);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({
      candles: candles.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
      cases,
    }));
  });
});
