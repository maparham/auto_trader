// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/avwap.json:
// what AVWAP_TEMPLATE.calc draws for each pane, which Python indicators/vwap.py
// (AVWAP registry type) must reproduce, line and bands.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { AVWAP_TEMPLATE } from "./vwap";
import { avwapOutputs, parseAvwapRefConfig } from "./vwapOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/avwap.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    // Bars 50..52 carry no volume, so an anchor at bar 50 is blank for 3 bars.
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: i >= 50 && i < 53 ? 0 : 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const BANDS3 = [{ on: true, mult: 1 }, { on: true, mult: 2 }, { on: true, mult: 3 }];
const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [T0 + 50 * H], extendData: {} },
  { calcParams: [T0 + 120 * H + 1], extendData: { source: "close", bands: BANDS3 } },
  { calcParams: [T0 + 10 * H], extendData: { bandMode: "percentage", bands: BANDS3, lineHidden: { vwap: true, up2: true } } },
  { calcParams: [0], extendData: {} },
  { calcParams: [T0 + 9_999 * H], extendData: {} },
  // vwapFrom's band reading: an empty array draws no band; a truthy non-boolean
  // `on` draws it.
  { calcParams: [T0 + 50 * H], extendData: { bands: [] } },
  { calcParams: [T0 + 50 * H], extendData: { bands: [{ on: 1, mult: 1.5 }, { on: 0, mult: 2 }] } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      // Values with lineHidden removed: display toggles never change a series.
      const ext = { ...c.extendData };
      delete ext.lineHidden;
      const rows = AVWAP_TEMPLATE.calc!(data, { calcParams: c.calcParams, extendData: ext } as never) as Array<Record<string, number | undefined>>;
      const values: Record<string, (number | null)[]> = {};
      for (const o of avwapOutputs(parseAvwapRefConfig(c.calcParams, c.extendData))) values[o] = rows.map((r) => r[o] ?? null);
      return { ...c, values };
    }),
  };
}

describe("AVWAP parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
