// Writes (UPDATE_PARITY=1) or checks the committed fixtures the backend's
// tests/test_indicator_parity.py reads: the alertable registry and the
// chart's own values for each alertable indicator over a fixed candle set.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { Indicator, KLineData } from "klinecharts";
import { ALERTABLE } from "./alertableIndicators";
import { computeMa } from "./indicators/ma";
import { computeRsi } from "./indicators/rsi";
import { computeAtr } from "./indicators/atr";
import { computeTrendlines } from "./indicators/trendlines";
import { canonicalTrendlinesParams, parseTrendlinesConfig } from "./indicators/trendlinesOutputs";

const DIR = new URL("../../../backend/tests/fixtures/indicator_parity/", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const CASES = [
  { indicator: "MA", calcParams: [20], config: { maType: "sma", source: "close" } },
  { indicator: "MA", calcParams: [20], config: { maType: "ema", source: "hl2" } },
  { indicator: "MA", calcParams: [10], config: { maType: "vwma", source: "close" } },
  { indicator: "MA", calcParams: [10], config: { maType: "evwma", source: "close" } },
  { indicator: "MA", calcParams: [20], config: { maType: "sma", source: "ohlc4" } },
  { indicator: "RSI", calcParams: [14], config: { source: "close" } },
  { indicator: "RSI", calcParams: [14], config: { source: "hl2" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "rma" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "ema" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "sma" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "wma" } },
  { indicator: "TRENDLINES", calcParams: canonicalTrendlinesParams([], {}), config: {} },
] as const;

function series(c: (typeof CASES)[number], data: KLineData[]): (number | null)[] {
  if (c.indicator === "TRENDLINES") {
    const pts = computeTrendlines(data, parseTrendlinesConfig(c.calcParams, {})).points;
    return pts.map((p) => (p as Record<string, number | undefined>).tl_nearest ?? null);
  }
  const n = c.calcParams[0];
  if (c.indicator === "MA")
    return computeMa(data, "ema", n, { maType: c.config.maType, source: c.config.source } as never).map((p) => p.ma ?? null);
  if (c.indicator === "RSI")
    return computeRsi(data, n, { source: c.config.source } as never).map((p) => p.val ?? null);
  const ind = { calcParams: [n], extendData: { smoothing: c.config.smoothing } } as unknown as Indicator;
  return computeAtr(data, ind).map((p) => p.atr ?? null);
}

describe("indicator parity fixtures", () => {
  const data = candles();
  const values = {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => ({ ...c, values: series(c, data) })),
  };
  const files: [string, unknown][] = [["alertable.json", ALERTABLE], ["values.json", values]];
  for (const [name, body] of files) {
    it(`${name} matches the committed fixture`, () => {
      const text = JSON.stringify(body, null, 1) + "\n";
      const path = new URL(name, DIR);
      if (process.env.UPDATE_PARITY) writeFileSync(path, text);
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }
});
