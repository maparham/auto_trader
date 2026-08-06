// Golden-master generator for the Python slope parity suite. Runs the SAME TS
// functions the pane uses over deterministic synthetic candles and writes
// backend/tests/fixtures/slope_golden.json. Re-run to regenerate after changing
// TS slope math. Mirrors indicatorParityGolden.test.ts.
/// <reference types="node" />
import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { slopeLineSeries, accelLineSeries, type SlopeUnit, type SlopeSmoothing } from "./slope";
import type { MaKind, PriceSource } from "../mtf";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../../backend/tests/fixtures/slope_golden.json");

/** Deterministic LCG — NO Math.random/Date.now. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const START = 1700000000000;

function makeCandles(n: number, gapAt: number[] = []): KLineData[] {
  const rnd = lcg(7);
  const out: KLineData[] = [];
  let close = 100;
  let t = START;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(1, open + (rnd() - 0.5) * 2);
    const high = Math.max(open, close) + rnd() * 0.5;
    const low = Math.min(open, close) - rnd() * 0.5;
    // Bars 2-4 volumeless so vwma/evwma exercise their empty-window paths.
    const volume = i >= 2 && i <= 4 ? 0 : Math.floor(rnd() * 1000) + 1;
    out.push({ timestamp: t, open, high, low, close, volume });
    // An "irregular" series skips bars entirely at the given indices: the min
    // positive gap stays 1h but the series is no longer contiguous, which is
    // exactly where an inferred bar width and a nominal one used to diverge.
    t += (gapAt.includes(i) ? 3 : 1) * 3600_000;
  }
  return out;
}

const MA_KINDS: MaKind[] = ["ema", "sma", "vwma", "evwma"];
const SOURCES: PriceSource[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];
const UNITS: SlopeUnit[] = ["pctHr", "pctBar", "priceBar"];
const SMOOTHINGS: Array<SlopeSmoothing | undefined> = [
  undefined,
  { type: "sma", length: 4 },
  { type: "ema", length: 4 },
];

const toNull = (a: Array<number | undefined>) => a.map((v) => (v === undefined ? null : v));

describe("slope parity golden fixture", () => {
  it("writes the fixture", () => {
    const clean = makeCandles(80);
    const irregular = makeCandles(80, [10, 11, 30, 55]);
    // The irregular half runs at a DIFFERENT nominal barHours (4h vs the clean
    // half's 1h). Both values are still passed explicitly — never inferred —
    // but the divergent barHours is deliberate: it is real coverage of the
    // n * barHours denominator in pctHr and of the acceleration time base
    // (which follows the slope's units), rather than a duplicate of the clean
    // half under a different timestamp skin.
    const BAR_HOURS: Record<"clean" | "irregular", number> = { clean: 1, irregular: 4 };

    const cases: unknown[] = [];
    // Keyed by a config identity shared between the two series passes, so we
    // can assert afterward that the irregular half (different barHours)
    // actually produced different numbers for at least one shared config.
    const bySeriesThenKey: Record<"clean" | "irregular", Map<string, Array<number | null>>> = {
      clean: new Map(),
      irregular: new Map(),
    };
    let n = 0;
    for (const series of ["clean", "irregular"] as const) {
      const candles = series === "clean" ? clean : irregular;
      const barHours = BAR_HOURS[series];
      for (const maType of MA_KINDS) {
        for (const source of SOURCES) {
          for (const units of UNITS) {
            for (const smoothing of SMOOTHINGS) {
              const length = 5;
              const period = 3;
              const key = `slope|${maType}|${source}|${units}|${smoothing?.type ?? "none"}|${smoothing?.length ?? 0}`;
              const values = toNull(
                slopeLineSeries(candles, maType, length, period, units, source, smoothing, barHours),
              );
              cases.push({
                name: `slope-${n++}`,
                series,
                kind: "slope",
                config: { maType, source, length, period, units, smoothing: smoothing ?? null },
                barHours,
                values,
              });
              bySeriesThenKey[series].set(key, values);
            }
          }
        }
      }
      // Acceleration: signed and absolute, over each unit (the accel time base
      // follows the slope's units, so all three must be covered), crossed with
      // BOTH the slope's own smoothing and the acceleration's smoothing — they
      // are applied at different pipeline stages and must be proven to compose
      // in the right order, not just exercised in isolation.
      for (const units of UNITS) {
        for (const absolute of [false, true]) {
          for (const smoothing of SMOOTHINGS) {
            for (const accelSmoothing of SMOOTHINGS) {
              const length = 5;
              const period = 3;
              const accelPeriod = 2;
              const raw = accelLineSeries(
                candles, "ema", length, period, accelPeriod, units, "close",
                smoothing, accelSmoothing, barHours,
              );
              const values = toNull(
                absolute ? raw.map((v) => (v === undefined ? undefined : Math.abs(v))) : raw,
              );
              const key = `accel|${units}|${absolute}|${smoothing?.type ?? "none"}|${smoothing?.length ?? 0}|${accelSmoothing?.type ?? "none"}|${accelSmoothing?.length ?? 0}`;
              cases.push({
                name: `accel-${n++}`,
                series,
                kind: "accel",
                config: {
                  maType: "ema", source: "close", length, period, units,
                  smoothing: smoothing ?? null, accelPeriod,
                  accelSmoothing: accelSmoothing ?? null, accelAbsolute: absolute,
                },
                barHours,
                values,
              });
              bySeriesThenKey[series].set(key, values);
            }
          }
        }
      }
    }

    // Non-vacuous: every case must produce at least one defined finite value,
    // so a port that silently returns all-null cannot pass.
    for (const c of cases as Array<{ name: string; values: Array<number | null> }>) {
      expect(
        c.values.some((v) => v !== null && Number.isFinite(v)),
        `${c.name} produced no defined values`,
      ).toBe(true);
    }

    // The irregular half must not be a silent duplicate of the clean half: at
    // least one shared config (same maType/source/units/smoothing) must
    // produce DIFFERENT values under barHours=4 vs barHours=1. This is what
    // makes the irregular half real coverage rather than dead weight.
    let anyDiffers = false;
    for (const [key, cleanValues] of bySeriesThenKey.clean) {
      const irregularValues = bySeriesThenKey.irregular.get(key);
      if (irregularValues && JSON.stringify(cleanValues) !== JSON.stringify(irregularValues)) {
        anyDiffers = true;
        break;
      }
    }
    expect(anyDiffers, "clean and irregular halves are identical for every shared config — irregular barHours is not exercising anything").toBe(true);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          candles: clean.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          irregularCandles: irregular.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          cases,
        },
        null,
        2,
      ) + "\n",
    );
    expect(cases.length).toBeGreaterThan(400);
  });
});
