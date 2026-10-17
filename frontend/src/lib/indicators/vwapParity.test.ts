// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/vwap.json:
// what the plain VWAP template computes (vwapFrom from bar 0 with its fixed
// settings), which Python indicators/vwap.py must reproduce.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { AVWAP_DEFAULT_BANDS, VWAP_TEMPLATE } from "./vwap";
import { VWAP_DEFAULT_BANDS } from "./vwapOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/vwap.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    // The first 3 bars carry no volume: VWAP stays blank until cumV > 0.
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: i < 3 ? 0 : 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [], extendData: {} },
  // Ignored by the plain template: the value must not move.
  { calcParams: [], extendData: { source: "close", bandMode: "percentage", slopeColor: { enabled: true, len: 5, flatBandPct: 0.1 } } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const rows = VWAP_TEMPLATE.calc!(data, { calcParams: c.calcParams, extendData: c.extendData } as never) as Array<{ vwap?: number }>;
      return { ...c, values: { vwap: rows.map((r) => r.vwap ?? null) } };
    }),
  };
}

describe("VWAP parity fixture", () => {
  it("keeps the leaf's band defaults equal to the chart's", () => {
    expect(VWAP_DEFAULT_BANDS).toEqual(AVWAP_DEFAULT_BANDS);
  });
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
