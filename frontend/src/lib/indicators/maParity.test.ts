// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/ma_pane.json:
// the chart's own computeMa output for the MA pane options the backend port
// (backend/auto_trader/indicators/ma.py) must reproduce.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computeMa, type MaExtend } from "./ma";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/ma_pane.json", import.meta.url);

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

const CASES: Array<{ type: "MA" | "EMA"; calcParams: number[]; extendData: MaExtend }> = [
  { type: "EMA", calcParams: [9], extendData: {} },
  { type: "MA", calcParams: [20], extendData: {} },
  { type: "MA", calcParams: [20], extendData: { maType: "ema", source: "hlcc4" } },
  { type: "EMA", calcParams: [21], extendData: { offset: 3 } },
  { type: "MA", calcParams: [10], extendData: { smoothing: { type: "ema", length: 5 } } },
  { type: "EMA", calcParams: [10], extendData: { smoothing: { type: "sma", length: 4 }, offset: 2 } },
  { type: "MA", calcParams: [14], extendData: { maType: "vwma", envelope: true } },
  { type: "MA", calcParams: [14], extendData: { maType: "evwma" } },
];

const KEYS = ["ma", "smoothingMa", "bandHi", "bandLo"] as const;

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const pts = computeMa(data, c.type === "EMA" ? "ema" : "sma", c.calcParams[0], c.extendData);
      const values: Record<string, (number | null)[]> = {};
      for (const k of KEYS) {
        const s = pts.map((p) => p[k] ?? null);
        if (s.some((v) => v !== null)) values[k] = s;
      }
      return { ...c, values };
    }),
  };
}

describe("MA pane parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
