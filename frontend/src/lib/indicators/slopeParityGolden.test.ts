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

import type { Indicator, KLineData } from "klinecharts";
import {
  slopeLineSeries,
  accelLineSeries,
  SLOPE_TEMPLATE,
  SLOPE_ACCEL_TEMPLATE,
  type SlopeExtend,
  type SlopePoint,
  type SlopeUnit,
  type SlopeSmoothing,
} from "./slope";
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

    // ---- Pane-shaped cases -------------------------------------------------
    // The cases above prove the ARITHMETIC ports. These prove the PANE ports:
    // they are produced by the templates' own `calc` — the exact function
    // klinecharts calls to build the plotted values — so slopeLengths(),
    // slopeShared() and resolveBarHours() are all in the loop, mirroring
    // Python's parse_slope_config. Backend test: test_slope_pane_rule_equality.
    //
    // Deliberately non-default on every axis a config-parsing divergence could
    // hide in: two lines (so slope0/slope1 must differ), sma (not the ema
    // default), hl2 (not close), pctBar (not the pctHr default), slope smoothing
    // on, accel on with a non-default period, and accelAbsolute — the transform
    // the pane applies to its plotted values and which a rule referencing
    // SLOPE.accelN must therefore see too.
    //
    // barHours is 4 (paired with PANE_RESOLUTION below), NOT 1, and that is
    // load-bearing for the units axis: at barHours 1, pctHr and pctBar are
    // arithmetically identical — slopeWithUnits divides by n * barHours vs n, and
    // accelSeries by n2 * barHours vs n2 — so a units mis-parse between those two
    // would be invisible at any config. At 4 all three unit values diverge.
    // Nominal 4h over 1h-spaced candles is fine: resolveBarHours takes
    // ext.barHours whenever it is finite and positive, so nothing is inferred.
    const paneExt: SlopeExtend = {
      maType: "sma", source: "hl2", units: "pctBar",
      slopePeriod: 3, smoothing: { type: "ema", length: 4 },
      showAccel: true, accelPeriod: 2, accelSmoothing: undefined, accelAbsolute: true,
      barHours: 4,
    };
    // The resolution whose nominal bar width equals paneExt.barHours. Written
    // into the fixture so the backend test evaluates at the SAME time base
    // instead of hardcoding a string that could drift away from barHours.
    const PANE_RESOLUTION = "HOUR_4";
    const paneLengths = [5, 13];
    const paneInd = { calcParams: paneLengths, extendData: paneExt } as unknown as Indicator;
    const paneRows = (calc: typeof SLOPE_TEMPLATE.calc) =>
      calc!(clean, paneInd) as unknown as SlopePoint[];
    const slopeRows = paneRows(SLOPE_TEMPLATE.calc);
    // computeAccelCalc keys its lines slope<i> too (drawSlope is reused verbatim
    // on the companion pane) — the OUTPUT is named accel<i>. Read slope<i>, label
    // accel<i>; reading `accel${i}` here would silently emit an all-null case.
    const accelRows = paneRows(SLOPE_ACCEL_TEMPLATE.calc);
    const paneCases = [
      ...paneLengths.map((_len, i) => ({
        output: `slope${i}`,
        values: toNull(slopeRows.map((p) => p[`slope${i}`])),
      })),
      ...paneLengths.map((_len, i) => ({
        output: `accel${i}`,
        values: toNull(accelRows.map((p) => p[`slope${i}`])),
      })),
    ];

    // Non-vacuous, and non-trivially so.
    for (const c of paneCases) {
      expect(
        c.values.some((v) => v !== null && Number.isFinite(v)),
        `pane case ${c.output} produced no defined values`,
      ).toBe(true);
    }
    // Two lengths must actually diverge — otherwise slopeLengths could be
    // dropping the second line and nobody would notice.
    expect(
      JSON.stringify(paneCases[0].values) !== JSON.stringify(paneCases[1].values),
      "slope0 and slope1 are identical — the two lengths are not both in play",
    ).toBe(true);
    // The slope pane is signed; the accel pane, with accelAbsolute on, is not.
    expect(paneCases[0].values.some((v) => v !== null && v < 0)).toBe(true);
    expect(paneCases[2].values.every((v) => v === null || v >= 0)).toBe(true);
    // ...and the abs transform is load-bearing: the SIGNED accel for the same
    // line has negative values, so an accel case that skipped Math.abs would
    // differ from what the pane plots.
    const signedAccel0 = accelLineSeries(
      clean, "sma", paneLengths[0], 3, 2, "pctBar", "hl2", paneExt.smoothing, undefined, 4,
    );
    expect(
      signedAccel0.some((v) => v !== undefined && v < 0),
      "signed accel never goes negative — accelAbsolute is not being exercised",
    ).toBe(true);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          candles: clean.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          irregularCandles: irregular.map((k) => ({ time: k.timestamp / 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
          cases,
          // accelSmoothing is explicitly null (not dropped) so the fixture states
          // "off" rather than leaving Python's parse to infer it from absence.
          paneConfig: {
            calcParams: paneLengths,
            extendData: { ...paneExt, accelSmoothing: null },
            resolution: PANE_RESOLUTION,
          },
          paneCases,
        },
        null,
        2,
      ) + "\n",
    );
    expect(cases.length).toBeGreaterThan(400);
  });
});
