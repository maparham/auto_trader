// The sink must be invisible: every config emits the same points and keeps the
// same live lines with a recording sink attached as without one. This is the
// guard that lets debug mode ride inside the parity-bound detector.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import {
  buildTlState,
  initTlState,
  stepTrendlinesBar,
  type TlSink,
} from "./trendlines";
import { TRENDLINES_DEFAULTS, type TrendlinesConfig } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";
import dxy from "./trendlinesDxy.fixture.json";

/** A sink that calls every hook's cheapest legal body: proves the hooks
 * themselves do not mutate detector state. */
const noopSink: TlSink = {
  crossings() {},
  pivotRejected() {},
  pivotTouch() {},
  seedRejected() {},
  died() {},
  evicted() {},
  afterConfirm() {},
};

const CFGS: Array<[string, Partial<TrendlinesConfig>]> = [
  ["defaults", {}],
  ["slope", { maxSlopeAtr: 0.05, minSlopeAtr: -0.05 }],
  ["lookback", { lookbackBars: 150 }],
  ["back", { minBackBars: 10 }],
  ["size+reach", { minSwingAtr: 1, minSwingReach: 8 }],
  ["ceilings", { maxTouches: 3, maxSpanBars: 120, maxCrossings: 4 }],
  ["extendLeft", { extendLeft: 1 }],
];

describe("sink parity", () => {
  for (const [name, patch] of CFGS) {
    for (const [label, bars] of [
      ["synth", synthBars(1500)],
      ["dxy", dxy as unknown as KLineData[]],
    ] as const) {
      it(`${name} on ${label}: points and lines identical`, () => {
        const cfg = { ...TRENDLINES_DEFAULTS, ...patch };
        const plain = buildTlState(bars, bars.length, cfg);
        const st = initTlState(bars, bars.length);
        for (let i = 0; i < bars.length; i++) stepTrendlinesBar(st, i, cfg, noopSink);
        expect(st.points).toEqual(plain.points);
        expect(st.lines).toEqual(plain.lines);
        expect(st.pairs).toBe(plain.pairs);
      });
      it(`${name} on ${label}: a floored run (startIdx > 0) matches buildTlState`, () => {
        const cfg = { ...TRENDLINES_DEFAULTS, ...patch };
        const floor = Math.floor(bars.length / 3);
        const plain = buildTlState(bars, bars.length, cfg, floor);
        const st = initTlState(bars, bars.length, floor);
        for (let i = floor; i < bars.length; i++) stepTrendlinesBar(st, i, cfg, noopSink);
        expect(st.points).toEqual(plain.points);
        expect(st.lines).toEqual(plain.lines);
        expect(st.pairs).toBe(plain.pairs);
      });
    }
  }
});
