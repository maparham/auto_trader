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

import { buildLineCache, tradeSpineX, draftLabelX, priceRowY, TRADE_SPINE_GAP, TRADE_SPINE_FALLBACK_W, TRADE_SPINE_MIN_X } from "./chartGeometry";

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

describe("tradeSpineX", () => {
  it("places the spine a gap left of the widest pill face", () => {
    // widest compact pill 70px → spine clears it by TRADE_SPINE_GAP
    expect(tradeSpineX({ paneWidth: 1000, pillWidths: [70, 62] })).toBe(1000 - 70 - TRADE_SPINE_GAP);
  });

  it("follows an expanded pill further left as it grows", () => {
    const compact = tradeSpineX({ paneWidth: 1000, pillWidths: [70] });
    const expanded = tradeSpineX({ paneWidth: 1000, pillWidths: [240] });
    expect(expanded).toBeLessThan(compact as number);
    expect(expanded).toBe(1000 - 240 - TRADE_SPINE_GAP);
  });

  it("falls back to the default inset when nothing is measurable (e.g. a draft)", () => {
    expect(tradeSpineX({ paneWidth: 1000, pillWidths: [] })).toBe(1000 - TRADE_SPINE_FALLBACK_W - TRADE_SPINE_GAP);
  });

  it("ignores zero-width nodes (pre-layout) rather than hugging the axis", () => {
    expect(tradeSpineX({ paneWidth: 1000, pillWidths: [0, 0] })).toBe(1000 - TRADE_SPINE_FALLBACK_W - TRADE_SPINE_GAP);
  });

  it("keeps the spine on the pane when a pill is wider than the pane", () => {
    // badges draw LEFT of the spine, so it must never be pushed off the left edge
    expect(tradeSpineX({ paneWidth: 200, pillWidths: [400] })).toBe(TRADE_SPINE_MIN_X);
  });

  it("returns null for a pane too narrow to hold the spine at all", () => {
    expect(tradeSpineX({ paneWidth: 0, pillWidths: [70] })).toBeNull();
  });
});

describe("draftLabelX", () => {
  it("anchors a draft's canvas label just right of the spine it has no DOM pill for", () => {
    // Draft lines carry no DOM pill, so the spine falls back to the default inset;
    // the label then takes the slot a real trade's pill would occupy.
    const spine = tradeSpineX({ paneWidth: 1000, pillWidths: [] })!;
    expect(draftLabelX(1000)).toBe(spine + TRADE_SPINE_GAP);
  });

  it("tracks the pane width so the draft label stays with its spine", () => {
    expect(draftLabelX(1200)).toBeGreaterThan(draftLabelX(800));
  });

  it("falls back to the far-left slot when the pane is not measurable yet", () => {
    expect(draftLabelX(0)).toBe(6);
  });
});

describe("priceRowY", () => {
  const chartAt = (y: number | undefined) =>
    ({ convertToPixel: () => [{ y }] }) as unknown as Parameters<typeof priceRowY>[0];

  it("rounds the pixel row of a price", () => {
    expect(priceRowY(chartAt(120.6), 5)).toBe(121);
  });

  it("gives no row when the pane has no height", () => {
    // A cell on a background tab keeps painting at zero height, where
    // klinecharts maps every price to +/-Infinity: a pill placed there
    // reached React as style.top = -Infinity.
    expect(priceRowY(chartAt(-Infinity), 101.2)).toBeUndefined();
    expect(priceRowY(chartAt(Infinity), 101.2)).toBeUndefined();
    expect(priceRowY(chartAt(NaN), 101.2)).toBeUndefined();
    expect(priceRowY(chartAt(undefined), 101.2)).toBeUndefined();
  });
});
