// frontend/src/lib/indicatorParityGolden.test.ts
//
// Golden-master generator for the Python indicator parity suite. Runs the SAME
// TS functions the chart/backtest use (maSeries, computeRsi, atrSeries,
// vwapFrom) over a deterministic synthetic candle set and writes the results to
// backend/tests/fixtures/indicator_golden.json. The Python side
// (backend/tests/test_indicator_parity.py) must reproduce every value exactly.
// Re-run this test to regenerate the fixture after changing TS indicator math.
/// <reference types="node" />
import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Mock klinecharts for the node test environment (indicator modules read LineType/IndicatorSeries).
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { maSeries, sma, alignHtfToChart } from "./mtf";
import { atrSeries } from "./atr";
import { computeRsi } from "./indicators/rsi";
import { vwapFrom } from "./indicators/vwap";
import { computeSrLevels } from "./indicators/srLevels";
import { computeFvg } from "./indicators/fvg";
import { computeTrendlines } from "./indicators/trendlines";

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

    // SR_LEVELS: config mirrored by test_indicator_parity.test_sr_levels.
    const srPoints = computeSrLevels(candles, {
      pivotLen: 5, atrMult: 0.5, minTouches: 2, maxLevels: 8, maxBars: 500,
    }).points;

    // FVG: config mirrored by test_indicator_parity.test_fvg. minSize 0.25 keeps
    // ~48 gaps over this walk — enough that every branch (shrink, full fill,
    // expiry, the per-side cap) is exercised rather than a handful of zones.
    const fvgPoints = computeFvg(candles, { minSize: 0.25, maxBars: 500, maxGaps: 10 }).points;

    // TRENDLINES: config mirrored by test_indicator_parity.test_trendlines
    // VALUE FOR VALUE. pivotLen 3 / minSpanBars 10 keep this 500-bar walk
    // producing many lines; maxProjBars 60 makes lines actually expire.
    // touchMult is pinned at 0.75 rather than taken from the defaults (now 0)
    // so half touches are live in the BASE and the GAP0 variant still bites.
    const TL_CFG = {
      pivotLen: 3, touchMult: 0.75, minTouches: 2, minSpanBars: 10, maxProjBars: 60,
      maxLines: 3, minSwingAtr: 0, minSwingReach: 0, pairPivots: 40, maxTouches: 0,
      maxSpanBars: 0, maxSlopeAtr: 0, minSlopeAtr: 0, maxTouchSpacing: 0,
      minTouchSpacing: 0, minCrossings: 0, maxCrossings: 0, pierceMult: 0.25,
      minBackBars: 0, maxDistAtr: 0, maxDistPct: 0, mergeAtr: 0, maxPerPivot: 0, mergePct: 0,
      majorPivots: 0, majorLen: 30, majorSizeAtr: 0,
    };
    const tlPoints = computeTrendlines(candles, TL_CFG).points;
    // One variant per gate, each against its own off state in TL_CFG, so a port
    // that ignored a param would fail exactly one pair.
    const TL_VARIANTS: Record<string, Partial<typeof TL_CFG>> = {
      SWING: { minSwingAtr: 2 },
      REACH: { minSwingReach: 12 },
      PAIR: { pairPivots: 5 },
      // The major tier only bites once the recent window is short.
      MAJOR: { pairPivots: 5, majorPivots: 3, majorLen: 10 },
      CAP: { maxTouches: 3 },
      SPAN: { maxSpanBars: 40 },
      SLOPE: { maxSlopeAtr: 0.1 },
      FLAT: { minSlopeAtr: 0.05 },
      SPACING: { maxTouchSpacing: 30 },
      SPACING_MIN: { minTouchSpacing: 4, minTouches: 3 },
      CROSS_MIN: { minCrossings: 2 },
      CROSS_MAX: { maxCrossings: 1 },
      // The two halves of the touch rule, each against its own base value:
      // no gap allowed at all, and a pierce band four times as wide.
      GAP0: { touchMult: 0 },
      PIERCE: { pierceMult: 1.0 },
      BACK: { minBackBars: 10 },
    };
    const tlVariantSeries: Record<string, Array<number | null>> = {};
    for (const [name, patch] of Object.entries(TL_VARIANTS)) {
      const pts = computeTrendlines(candles, { ...TL_CFG, ...patch }).points;
      tlVariantSeries[`TL_${name}_1`] = toNull(pts.map((p) => p.tl_1 ?? null));
      tlVariantSeries[`TL_${name}_NEAREST`] = toNull(pts.map((p) => p.tl_nearest ?? null));
      // Each variant must MOVE something against the base, or the Python port
      // could ignore the param and still pass.
      expect(JSON.stringify(pts), name).not.toBe(JSON.stringify(tlPoints));
    }

    const series: Record<string, Array<number | null>> = {
      EMA_9: toNull(ema9Base),
      EMA_21: toNull(maSeries(candles, "ema", 21, {}).base),
      SMA_14: toNull(maSeries(candles, "sma", 14, {}).base),
      RSI_14: toNull(computeRsi(candles, 14, {}).map((p) => p.val ?? null)),
      ATR_14: toNull(atrSeries(candles, 14)),
      ATR_14_SMA: toNull(atrSeries(candles, 14, "sma")),
      ATR_14_EMA: toNull(atrSeries(candles, 14, "ema")),
      ATR_14_WMA: toNull(atrSeries(candles, 14, "wma")),
      VOLMA_20: toNull(sma(candles.map((k) => k.volume ?? 0), 20)),
      VOL: toNull(candles.map((k) => k.volume ?? null)),
      AVWAP: toNull(vwapFrom(candles, start, {}).map((p) => p.vwap ?? null)),
      "EMA_9@HOUR_4": toNull(emaAtHour4),
      "EMA_9~3": toNull(ema9Slope3),
      SR_SUPPORT: toNull(srPoints.map((p) => p.support ?? null)),
      SR_RESISTANCE: toNull(srPoints.map((p) => p.resistance ?? null)),
      FVG_BULL_TOP: toNull(fvgPoints.map((p) => p.bullTop ?? null)),
      FVG_BULL_BOTTOM: toNull(fvgPoints.map((p) => p.bullBottom ?? null)),
      FVG_BEAR_TOP: toNull(fvgPoints.map((p) => p.bearTop ?? null)),
      FVG_BEAR_BOTTOM: toNull(fvgPoints.map((p) => p.bearBottom ?? null)),
      TL_1: toNull(tlPoints.map((p) => p.tl_1 ?? null)),
      TL_2: toNull(tlPoints.map((p) => p.tl_2 ?? null)),
      TL_3: toNull(tlPoints.map((p) => p.tl_3 ?? null)),
      TL_NEAREST: toNull(tlPoints.map((p) => p.tl_nearest ?? null)),
      ...tlVariantSeries,
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
    for (const key of ["ATR_14", "ATR_14_SMA", "ATR_14_EMA", "ATR_14_WMA"] as const)
      for (const v of series[key]) if (v !== null) expect(v).toBeGreaterThan(0);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(fixture));
  });
});
