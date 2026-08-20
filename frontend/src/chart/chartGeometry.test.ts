// What lands in the pixel LineCache — the one input to selection handles,
// crossing arrows, curve-end pills and the click/hover hit-test. A curve that
// is cached but never painted shows up as dots and arrows floating over blank
// chart, which is exactly what FVG and S/R Levels did: their figures carry the
// legend rows and rule operands, while draw() paints zones instead of lines.
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import { buildLineCache } from "./chartGeometry";

interface FakeInd {
  paneId: string;
  name: string;
  figures: Array<{ key: string; type: string }>;
  result: Array<Record<string, number>>;
  extendData?: unknown;
  calcParams?: unknown[];
  visible?: boolean;
}

const BARS = [0, 1, 2, 3].map((i) => ({ timestamp: 1700000000000 + i * 60_000 }));

/** Chart stub with just the surface buildLineCache reads. */
function chartWith(inds: FakeInd[]): Parameters<typeof buildLineCache>[0] {
  return {
    getIndicators: () => inds,
    getDataList: () => BARS,
    getVisibleRange: () => ({ from: 0, to: BARS.length }),
    getStyles: () => ({ indicator: { lines: [{ color: "#fff" }] } }),
    convertToPixel: (pts: Array<{ value: number }>) => pts.map((p, k) => ({ x: k * 8, y: p.value })),
  } as never;
}

function ind(name: string, key: string, indType?: string): FakeInd {
  return {
    paneId: "candle_pane",
    name,
    figures: [{ key, type: "line" }],
    result: BARS.map((_, i) => ({ [key]: 100 + i })),
    extendData: indType ? { indType } : undefined,
  };
}

describe("buildLineCache", () => {
  it("caches a normal plotted curve", () => {
    const cache = buildLineCache(chartWith([ind("EMA#a1", "ema", "EMA")]));
    expect(cache).toHaveLength(1);
    expect(cache[0]).toMatchObject({ name: "EMA#a1", figKey: "ema", indType: "EMA" });
    expect(cache[0].coords).toHaveLength(BARS.length);
  });

  // The figures are real (legend rows, rule operands) but nothing paints them,
  // so a cached entry would hang handles and crossing arrows on empty space.
  it("skips FVG and S/R Levels, whose figures are never drawn as curves", () => {
    const cache = buildLineCache(
      chartWith([
        ind("FVG", "bull_top"),
        ind("FVG#b2", "bear_top", "FVG"),
        ind("SR_LEVELS", "support"),
        ind("EMA#a1", "ema", "EMA"),
      ]),
    );
    expect(cache.map((l) => l.name)).toEqual(["EMA#a1"]);
  });
});
