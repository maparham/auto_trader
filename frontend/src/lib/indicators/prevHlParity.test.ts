// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/prev_hl.json:
// computePrevHl over 30-minute bars with weekend gaps, a DST change and one
// irregular hole, which Python indicators/prev_hl.py must reproduce. Values are
// generated with lineHidden stripped (display toggles never change a series)
// and with the zone the backend will use: the pane's tz when valid, else UTC
// (the frontend stamps the chart zone before sending, lib/indicatorTimezone.ts).
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computePrevHl, type PrevHlExtend } from "./prevHl";
import { PREV_HL_OUTPUTS, parsePrevHlRefConfig, prevHlWarmup } from "./prevHlOutputs";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/prev_hl.json", import.meta.url);
const STEP = 30 * 60_000;
const T0 = Date.UTC(2024, 2, 4); // Monday 4 March 2024; US DST starts 10 March

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let t = T0; t < T0 + 35 * 86_400_000; t += STEP) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue; // weekend gap
    if (t >= Date.UTC(2024, 2, 13, 10) && t < Date.UTC(2024, 2, 13, 12)) continue; // irregular hole
    const i = out.length;
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    out.push({ timestamp: t, open, high: Math.max(open, close) + 0.4 + (i % 5) * 0.1, low: Math.min(open, close) - 0.3 - (i % 3) * 0.1, close, volume: 0 });
    p = close;
  }
  return out;
}

const validZone = (tz: unknown): string => {
  if (typeof tz !== "string" || !tz || tz === "chart") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

function cases(data: KLineData[]): PrevHlExtend[] {
  return [
    {},
    { tz: "chart" },
    { tz: "Mars/Base" },
    { tz: "America/New_York", lengths: { day: 2, week: 2 }, aggs: { day: "avg", week: "median" } },
    { tz: "Asia/Tokyo", rollingUnit: "bars", lengths: { rolling: 5 }, aggs: { rolling: "median" } },
    { tz: "UTC", rollingUnit: "hour", lengths: { rolling: 6 }, gapMode: "wallclock" },
    { rollingUnit: "day", lengths: { rolling: 1 } },
    { rollingUnit: "minute", lengths: { rolling: 10 } }, // finer than one bar: rolling stays blank
    { anchorTs: data[300].timestamp + 1, lineHidden: { anchorHigh: true, dayLow: true } },
  ];
}

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: cases(data).map((ext) => {
      const rows = computePrevHl(data, { ...ext, lineHidden: {}, tz: validZone(ext.tz) }) as Array<Record<string, number | undefined>>;
      const cfg = parsePrevHlRefConfig(ext);
      const values: Record<string, (number | null)[]> = {};
      const warmup: Record<string, number> = {};
      for (const o of PREV_HL_OUTPUTS) {
        values[o] = rows.map((r) => r[o] ?? null);
        warmup[o] = prevHlWarmup(cfg, o);
      }
      return { extendData: ext, values, warmup };
    }),
  };
}

describe("PREV_HL parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
