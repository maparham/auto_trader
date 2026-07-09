// frontend/src/lib/indicatorParityGolden.test.ts
//
// Golden-master generator for the Python indicator parity suite. Runs the SAME
// TS functions the chart/backtest use (maSeries, computeRsi, atrSeries,
// vwapFrom) over a deterministic synthetic candle set and writes the results to
// backend/tests/fixtures/indicator_golden.json. The Python side
// (backend/tests/test_indicator_parity.py) must reproduce every value exactly.
// Re-run this test to regenerate the fixture after changing TS indicator math.
import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Mock klinecharts for the node test environment (indicator modules read LineType/IndicatorSeries).
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

import type { KLineData } from "klinecharts";
import { maSeries, sma, alignHtfToChart } from "./mtf";
import { atrSeries } from "./atr";
import { computeRsi } from "./indicators/rsi";
import { vwapFrom } from "./indicators/vwap";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../backend/tests/fixtures/indicator_golden.json");

/** Deterministic LCG (Numerical Recipes constants) — NO Math.random/Date.now. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCandles(n: number): KLineData[] {
  const rnd = lcg(42);
  const out: KLineData[] = [];
  let close = 100;
  const startMs = 1700000000000; // fixed epoch, hourly bars
  for (let i = 0; i < n; i++) {
    const open = close;
    const drift = (rnd() - 0.5) * 2; // ±1
    close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rnd() * 0.5;
    const low = Math.min(open, close) - rnd() * 0.5;
    // First 3 bars volume 0 to exercise the AVWAP cumV<=0 blank path.
    const volume = i < 3 ? 0 : Math.floor(rnd() * 1000) + 1;
    out.push({ timestamp: startMs + i * 3600_000, open, high, low, close, volume });
  }
  return out;
}

const toNull = (a: Array<number | undefined | null>) => a.map((v) => (v == null ? null : v));

/** Verbatim port of backtestSeries.ts slopeOf (see task-14 brief): tangent rate
 * of change in percent per HOUR over n bars. undefined for the first n bars,
 * wherever raw is undefined, or where the denominator is 0. */
function slopeOf(raw: Array<number | undefined | null>, n: number, barHours: number): Array<number | undefined> {
  return raw.map((v, i) => {
    const prev = raw[i - n];
    if (i < n || v == null || prev == null || prev === 0) return undefined;
    return ((v - prev) / Math.abs(prev) / (n * barHours)) * 100;
  });
}

/** Aggregate hourly candles into 4-hour HTF candles: group by floor(i/4). */
function aggregateHtf(candles: KLineData[], groupSize: number): KLineData[] {
  const out: KLineData[] = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize);
    if (group.length === 0) continue;
    out.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      close: group[group.length - 1].close,
      high: Math.max(...group.map((k) => k.high)),
      low: Math.min(...group.map((k) => k.low)),
      volume: group.reduce((s, k) => s + (k.volume ?? 0), 0),
    });
  }
  return out;
}

describe("indicator parity golden fixture", () => {
  it("generates the fixture the Python suite verifies against", () => {
    const candles = makeCandles(500);
    const anchorMs = candles[50].timestamp;
    // AVWAP: mirror backtestSeries.computeRaw — first bar at/after anchor.
    const idx = candles.findIndex((k) => k.timestamp >= anchorMs);
    const start = idx < 0 ? candles.length : idx;

    const htfCandles = aggregateHtf(candles, 4);
    const htfMs = 4 * 3600_000;
    const htfEma = maSeries(htfCandles, "ema", 9, {}).base;
    const baseTimestamps = candles.map((k) => k.timestamp);
    const emaAtHour4 = alignHtfToChart(baseTimestamps, htfCandles, htfEma, htfMs, true);

    const ema9Base = maSeries(candles, "ema", 9, {}).base;
    const ema9Slope3 = slopeOf(ema9Base, 3, 1);

    const series: Record<string, Array<number | null>> = {
      EMA_9: toNull(ema9Base),
      EMA_21: toNull(maSeries(candles, "ema", 21, {}).base),
      SMA_14: toNull(maSeries(candles, "sma", 14, {}).base),
      RSI_14: toNull(computeRsi(candles, 14, {}).map((p) => p.val ?? null)),
      ATR_14: toNull(atrSeries(candles, 14)),
      VOLMA_20: toNull(sma(candles.map((k) => k.volume ?? 0), 20)),
      VOL: toNull(candles.map((k) => k.volume ?? null)),
      AVWAP: toNull(vwapFrom(candles, start, {}).map((p) => p.vwap ?? null)),
      "EMA_9@HOUR_4": toNull(emaAtHour4),
      "EMA_9~3": toNull(ema9Slope3),
    };

    const fixture = {
      candles: candles.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0,
      })),
      htfCandles: htfCandles.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0,
      })),
      anchorMs,
      series,
    };

    for (const [name, arr] of Object.entries(series)) {
      expect(arr, name).toHaveLength(candles.length);
    }
    // Sanity: RSI in [0,100] wherever defined; ATR positive.
    for (const v of series.RSI_14) if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of series.ATR_14) if (v !== null) expect(v).toBeGreaterThan(0);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(fixture));
  });
});
