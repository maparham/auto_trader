// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/lr.json:
// lrOutputs.lrSeries over a fixed candle set, which Python indicators/lr.py
// must reproduce (backend/tests/test_lr_pane.py). It also pins the rolling
// series to the chart: at the newest bar both fit the same window and
// evaluate it at the same x, so lrSeries and computeLr must agree there.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computeLr, type LrExtend } from "./lr";
import { LR_OUTPUTS, lrSeries, parseLrConfig } from "./lrOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/lr.json", import.meta.url);

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

const CASES: Array<{ calcParams: number[]; extendData: Record<string, unknown> }> = [
  { calcParams: [], extendData: {} },
  { calcParams: [20, 2], extendData: {} },
  { calcParams: [14, 1.5], extendData: { source: "hl2" } },
  { calcParams: [2, 3], extendData: { source: "hlcc4" } },
  { calcParams: [30, 2], extendData: { lineHidden: { lr: true, up: true } } },
];

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const cfg = parseLrConfig(c.calcParams, c.extendData);
      const values: Record<string, (number | null)[]> = {};
      for (const o of LR_OUTPUTS) values[o] = lrSeries(data, cfg, o);
      return { ...c, warmup: cfg.length, values };
    }),
  };
}

describe("LR parity fixture", () => {
  it("agrees with the chart's computeLr at the newest bar, every output", () => {
    const data = candles();
    for (const c of CASES) {
      const cfg = parseLrConfig(c.calcParams, c.extendData);
      // lineHidden only omits keys on the chart; strip it to read every line.
      const drawn = computeLr(data, cfg.length, cfg.mult, { source: cfg.source } as LrExtend);
      const last = drawn[drawn.length - 1];
      for (const o of LR_OUTPUTS) {
        expect(lrSeries(data, cfg, o).at(-1)).toBeCloseTo(last[o] as number, 9);
      }
    }
  });
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
