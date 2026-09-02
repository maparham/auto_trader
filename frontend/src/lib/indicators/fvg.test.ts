// Core FVG math. Rendering is exercised visually; this suite pins the causal
// algorithm: 3-candle gap detection, the ATR size filter, wick-driven
// shrink-on-partial / death-on-full-fill, age + count caps, and the per-bar
// nearest-gap outputs the backtest rules read.
//
// Every fixture below is hand-checked bar by bar: a thrust bar's low is kept at
// or below the high two bars back so each leg forms EXACTLY one gap, and the
// consolidation bars that follow repeat one range so they can neither open a new
// gap nor fill the open one.
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { computeFvg, parseFvgConfig, fvgWarmup, FVG_DEFAULTS, fvgZoneStyleOf, FVG_TEMPLATE } from "./fvg";

/** Bar spanning [low, high]; open/close sit inside the range so a bar never
 * closes outside its own body extremes. */
function hl(low: number, high: number, i: number): KLineData {
  return {
    timestamp: 1700000000000 + i * 3600_000,
    open: low + (high - low) * 0.25,
    high,
    low,
    close: low + (high - low) * 0.75,
    volume: 1,
  };
}

/** `n` identical bars — they warm ATR(14) without opening or filling anything. */
function filler(n: number, from: number, low = 99.5, high = 100.5): KLineData[] {
  return Array.from({ length: n }, (_, k) => hl(low, high, from + k));
}

const CFG = { ...FVG_DEFAULTS, minSize: 0 };

// One bullish gap [100.5, 103] confirmed at bar 22, nothing else.
const BULL_BASE = [...filler(20, 0), hl(99.5, 100.5, 20), hl(100.5, 104, 21), hl(103, 105, 22)];
// One bearish gap [97, 99.5] confirmed at bar 22, nothing else.
const BEAR_BASE = [...filler(20, 0), hl(99.5, 100.5, 20), hl(96, 99.5, 21), hl(95, 97, 22)];

describe("computeFvg detection", () => {
  it("returns one point per bar", () => {
    const bars = filler(30, 0);
    expect(computeFvg(bars, CFG).points).toHaveLength(bars.length);
  });

  it("detects a bullish gap when low[i] > high[i-2], zoned [high[i-2], low[i]]", () => {
    const { gaps } = computeFvg([...BULL_BASE, ...filler(3, 23, 103.5, 104.5)], CFG);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ side: "bull", bottom: 100.5, top: 103, createdIdx: 22 });
  });

  it("detects a bearish gap when high[i] < low[i-2], zoned [high[i], low[i-2]]", () => {
    const { gaps } = computeFvg([...BEAR_BASE, ...filler(3, 23, 95.5, 96.5)], CFG);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ side: "bear", bottom: 97, top: 99.5, createdIdx: 22 });
  });

  it("emits nothing for a flat range with no displacement", () => {
    const { gaps, points } = computeFvg(filler(40, 0), CFG);
    expect(gaps).toHaveLength(0);
    expect(points.every((p) => p.bullTop === undefined && p.bearTop === undefined)).toBe(true);
  });

  it("skips a gap confirming before ATR(14) is warm", () => {
    // The same up-thrust, at bars 2/3/4 — ATR(14) has no value there.
    const bars = [...filler(3, 0), hl(100.5, 104, 3), hl(103, 105, 4), ...filler(25, 5, 103.5, 104.5)];
    expect(computeFvg(bars, CFG).gaps).toHaveLength(0);
  });
});

describe("computeFvg size filter", () => {
  // The gap is 2.5 wide; ATR(14) at the confirm bar is ~1.25.
  const bars = [...BULL_BASE, ...filler(3, 23, 103.5, 104.5)];

  it("keeps a gap at or above minSize x ATR(14)", () => {
    expect(computeFvg(bars, { ...CFG, minSize: 1 }).gaps).toHaveLength(1);
  });

  it("drops a gap below minSize x ATR(14)", () => {
    expect(computeFvg(bars, { ...CFG, minSize: 3 }).gaps).toHaveLength(0);
  });

  it("keeps every gap when minSize is 0", () => {
    expect(computeFvg(bars, { ...CFG, minSize: 0 }).gaps).toHaveLength(1);
  });
});

describe("computeFvg mitigation", () => {
  it("shrinks the unfilled remainder when a wick partially fills the gap", () => {
    const bars = [...BULL_BASE, hl(102, 104, 23), ...filler(3, 24, 102.5, 103.5)];
    const { gaps, points } = computeFvg(bars, CFG);
    expect(gaps).toHaveLength(1);
    // The low of 102 ate the 102–103 slice; the live zone is now [100.5, 102].
    expect(gaps[0]).toMatchObject({ bottom: 100.5, top: 102 });
    expect(points[points.length - 1]).toMatchObject({ bullBottom: 100.5, bullTop: 102 });
  });

  it("kills the gap when a wick reaches the far edge exactly", () => {
    const bars = [...BULL_BASE, hl(100.5, 104, 23), ...filler(3, 24, 102.5, 103.5)];
    expect(computeFvg(bars, CFG).gaps).toHaveLength(0);
  });

  it("kills the gap when a wick trades through the far edge", () => {
    const bars = [...BULL_BASE, hl(99, 104, 23), ...filler(3, 24, 102.5, 103.5)];
    const { gaps, points } = computeFvg(bars, CFG);
    expect(gaps).toHaveLength(0);
    expect(points[points.length - 1].bullTop).toBeUndefined();
  });

  it("does not let the creating bar's own wick fill the new gap", () => {
    // Bar 22's low (103) IS the gap's top edge — it must not shrink it to nothing.
    const { points } = computeFvg([...BULL_BASE, ...filler(2, 23, 103.5, 104.5)], CFG);
    expect(points[22]).toMatchObject({ bullBottom: 100.5, bullTop: 103 });
  });

  it("shrinks a bearish gap from below and kills it on a full fill", () => {
    const partial = computeFvg([...BEAR_BASE, hl(95, 98, 23), ...filler(2, 24, 97, 98)], CFG);
    expect(partial.gaps[0]).toMatchObject({ bottom: 98, top: 99.5 });
    const full = computeFvg([...BEAR_BASE, hl(95, 100, 23), ...filler(2, 24, 96.5, 97.5)], CFG);
    expect(full.gaps).toHaveLength(0);
  });
});

describe("computeFvg age and count caps", () => {
  it("expires a gap maxBars after it was created", () => {
    const bars = [...BULL_BASE, ...filler(20, 23, 103.5, 104.5)];
    expect(computeFvg(bars, { ...CFG, maxBars: 500 }).gaps).toHaveLength(1);
    // Created at 22, last bar is 42 — an age of 20 exceeds maxBars 10.
    expect(computeFvg(bars, { ...CFG, maxBars: 10 }).gaps).toHaveLength(0);
  });

  it("keeps only the newest maxGaps per side", () => {
    // A second clean up-leg: gap [104.5, 107] confirmed at bar 26.
    const bars = [
      ...BULL_BASE,
      hl(103.5, 104.5, 23),
      hl(103.5, 104.5, 24),
      hl(104.5, 108, 25),
      hl(107, 109, 26),
      ...filler(3, 27, 107.5, 108.5),
    ];
    expect(computeFvg(bars, CFG).gaps.map((g) => g.createdIdx)).toEqual([22, 26]);
    const capped = computeFvg(bars, { ...CFG, maxGaps: 1 }).gaps;
    expect(capped).toHaveLength(1);
    expect(capped[0].createdIdx).toBe(26);
  });
});

describe("computeFvg outputs", () => {
  const LADDER = [
    ...BULL_BASE,
    hl(103.5, 104.5, 23),
    hl(103.5, 104.5, 24),
    hl(104.5, 108, 25),
    hl(107, 109, 26),
    ...filler(3, 27, 107.5, 108.5),
  ];

  it("reports the nearest gap below the close on the bullish side", () => {
    const last = computeFvg(LADDER, CFG).points.slice(-1)[0];
    // Live: [100.5, 103] and [104.5, 107]; the close is ~108.25.
    expect(last).toMatchObject({ bullBottom: 104.5, bullTop: 107 });
  });

  it("honours maxGaps when picking the nearest gap", () => {
    const last = computeFvg(LADDER, { ...CFG, maxGaps: 1 }).points.slice(-1)[0];
    expect(last).toMatchObject({ bullBottom: 104.5, bullTop: 107 });
  });

  it("reports the nearest gap above the close on the bearish side", () => {
    const last = computeFvg([...BEAR_BASE, ...filler(3, 23, 95.5, 96.5)], CFG).points.slice(-1)[0];
    expect(last).toMatchObject({ bearBottom: 97, bearTop: 99.5 });
  });

  it("leaves a side blank when it has no live gap", () => {
    const last = computeFvg([...BULL_BASE, ...filler(3, 23, 103.5, 104.5)], CFG).points.slice(-1)[0];
    expect(last.bullTop).toBe(103);
    expect(last.bearTop).toBeUndefined();
    expect(last.bearBottom).toBeUndefined();
  });

  // Load-bearing invariant: shrink-on-partial means any bar reaching into a
  // bullish gap pulls its top down to that bar's low, and a bar's close never
  // sits below its own low — so a live bullish zone always ends up at or below
  // the close (bearish, at or above). That is what makes "nearest gap below /
  // above the close" total, with no close-inside-the-zone case to arbitrate.
  it("never leaves the close strictly inside a live zone", () => {
    for (const bars of [LADDER, [...BEAR_BASE, hl(95, 98, 23), ...filler(3, 24, 97, 98)]]) {
      const { points } = computeFvg(bars, CFG);
      points.forEach((p, i) => {
        if (p.bullTop !== undefined) expect(p.bullTop).toBeLessThanOrEqual(bars[i].close);
        if (p.bearBottom !== undefined) expect(p.bearBottom).toBeGreaterThanOrEqual(bars[i].close);
      });
    }
  });

  it("is causal: a bar's outputs never depend on later bars", () => {
    const bars = [...LADDER, ...filler(4, 30, 107.5, 108.5)];
    const full = computeFvg(bars, CFG).points;
    for (const cut of [23, 27, 30]) {
      expect(computeFvg(bars.slice(0, cut), CFG).points).toEqual(full.slice(0, cut));
    }
  });
});

describe("parseFvgConfig", () => {
  it("falls back per field on garbage, never throwing", () => {
    expect(parseFvgConfig(undefined)).toEqual(FVG_DEFAULTS);
    expect(parseFvgConfig(["x", NaN, -3])).toEqual(FVG_DEFAULTS);
  });

  it("accepts minSize 0 (filter off) but not a negative one", () => {
    expect(parseFvgConfig([0, 500, 10]).minSize).toBe(0);
    expect(parseFvgConfig([-1, 500, 10]).minSize).toBe(FVG_DEFAULTS.minSize);
  });

  it("floors the count/window params and clamps them to at least 1", () => {
    expect(parseFvgConfig([0.25, 3.7, 2.9])).toMatchObject({ maxBars: 3, maxGaps: 2 });
    expect(parseFvgConfig([0.25, 0, 0])).toMatchObject({
      maxBars: FVG_DEFAULTS.maxBars,
      maxGaps: FVG_DEFAULTS.maxGaps,
    });
  });
});

describe("fvgWarmup", () => {
  it("is the ATR window plus the two bars the pattern spans", () => {
    expect(fvgWarmup()).toBe(16);
  });
});

describe("fvgZoneStyleOf", () => {
  it("merges a partial zoneStyle over the defaults", async () => {
    const { FVG_ZONE_STYLE_DEFAULTS } = await import("./fvg");
    expect(fvgZoneStyleOf(undefined)).toEqual(FVG_ZONE_STYLE_DEFAULTS);
    const st = fvgZoneStyleOf({ zoneStyle: { bullColor: "#123456" } });
    expect(st.bullColor).toBe("#123456");
    expect(st.bearColor).toBe(FVG_ZONE_STYLE_DEFAULTS.bearColor);
    expect(st.opacity).toBe(FVG_ZONE_STYLE_DEFAULTS.opacity);
  });
});

describe("computeFvg MTF branch", () => {
  const H = 3600_000;
  const t0 = 1700000000000;
  const chartBars = filler(12, 0);
  const mtf = {
    timeframe: "HOUR_4",
    htfMs: 4 * H,
    htfStarts: [t0, t0 + 4 * H, t0 + 8 * H],
    htfBullTop: [103, 104, 105] as Array<number | undefined>,
    htfBullBottom: [100, 101, 102] as Array<number | undefined>,
    htfBearTop: [120, undefined, 122] as Array<number | undefined>,
    htfBearBottom: [118, undefined, 119] as Array<number | undefined>,
    htfGaps: [{ side: "bull" as const, top: 103, bottom: 100, createdTs: t0 + 4 * H }],
  };

  it("admits a flagged forming entry from its open (waitClose unchecked)", () => {
    const { points } = computeFvg(chartBars, CFG, {
      mtf: { ...mtf, formingIdx: 2 },
    });
    expect(points[7].bullTop).toBe(103); // history keeps waitClose
    expect(points[8].bullTop).toBe(105); // forming entry, from its open
    expect(points[11].bearBottom).toBe(119);
  });

  it("aligns the HTF series onto chart bars using only CLOSED HTF bars", () => {
    const { points } = computeFvg(chartBars, CFG, { mtf });
    // Inside the first (still-open) HTF bar there is no closed HTF bar yet.
    expect(points[0].bullTop).toBeUndefined();
    expect(points[3].bullTop).toBeUndefined();
    // Bars in the second HTF bar read the first CLOSED HTF bar.
    expect(points[4].bullTop).toBe(103);
    expect(points[7].bearBottom).toBe(118);
    // The third reads HTF bar 2, whose bearish side was blank.
    expect(points[8].bullTop).toBe(104);
    expect(points[8].bearTop).toBeUndefined();
    // The last HTF bar never closes on-chart, so its values are never used.
    expect(points[11].bullTop).toBe(104);
  });

  it("maps a stashed HTF gap's timestamp onto a chart bar index", () => {
    const { gaps } = computeFvg(chartBars, CFG, { mtf });
    expect(gaps).toHaveLength(1);
    // createdTs is the HTF bar starting t0+4h → its first chart bar is index 4.
    expect(gaps[0]).toMatchObject({ side: "bull", top: 103, bottom: 100, createdIdx: 4 });
  });
});

// Draw geometry. Only the right edge is under test: where a zone STOPS is the
// one thing "Extend to Right" changes, and it must move the midline with it.
describe("FVG_TEMPLATE.draw right edge", () => {
  const BARS = [...BULL_BASE, ...filler(3, 23, 103.5, 104.5)]; // 26 bars, one bull gap
  const BAR_PX = 10;
  const PANE_W = 400; // room to spare past the last bar (index 25 -> x 250)
  const LAST_BAR_RIGHT = 25 * BAR_PX + BAR_PX / 2;

  function draw(extendData: Record<string, unknown>): { rects: number[]; dashEnds: number[] } {
    const rects: number[] = [];
    const dashEnds: number[] = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      stroke: () => {},
      setLineDash: () => {},
      moveTo: () => {},
      lineTo: (x: number) => dashEnds.push(x),
      fillRect: (x: number, _y: number, w: number) => rects.push(x + w),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    };
    const calcParams = [0, FVG_DEFAULTS.maxBars, FVG_DEFAULTS.maxGaps];
    const result = FVG_TEMPLATE.calc!(BARS, { calcParams, extendData } as never);
    const drew = FVG_TEMPLATE.draw!({
      ctx,
      indicator: { result, calcParams, extendData },
      bounding: { width: PANE_W, height: 200 },
      xAxis: { convertToPixel: (i: number) => i * BAR_PX },
      yAxis: { convertToPixel: (p: number) => 200 - p },
    } as never);
    expect(drew).toBe(true);
    expect(rects).toHaveLength(1);
    return { rects, dashEnds };
  }

  it("stops at the last bar when the flag is off", () => {
    expect(draw({ minSize: 0 }).rects[0]).toBe(LAST_BAR_RIGHT);
  });

  it("defaults to off with no extendData of its own", () => {
    expect(draw({}).rects[0]).toBe(LAST_BAR_RIGHT);
  });

  it("runs to the pane edge when the flag is on", () => {
    expect(draw({ extendRight: true }).rects[0]).toBe(PANE_W);
  });

  it("ends the midline where the zone ends", () => {
    const off = draw({ showMidline: true });
    expect(off.dashEnds).toEqual([LAST_BAR_RIGHT]);
    const on = draw({ showMidline: true, extendRight: true });
    expect(on.dashEnds).toEqual([PANE_W]);
  });

  it("never runs past the pane, with the last bar scrolled off to the right", () => {
    // Pane cut at 240: the zone opens at bar 22 (x 220) but the last bar's right
    // edge (255) is off-screen, so both modes must render identically.
    const cut = (extendData: Record<string, unknown>): number => {
      const rects: number[] = [];
      const ctx = {
        save: () => {}, restore: () => {}, beginPath: () => {}, stroke: () => {},
        setLineDash: () => {}, moveTo: () => {}, lineTo: () => {},
        fillRect: (x: number, _y: number, w: number) => rects.push(x + w),
        fillStyle: "", strokeStyle: "", lineWidth: 1,
      };
      const calcParams = [0, FVG_DEFAULTS.maxBars, FVG_DEFAULTS.maxGaps];
      const result = FVG_TEMPLATE.calc!(BARS, { calcParams, extendData } as never);
      FVG_TEMPLATE.draw!({
        ctx,
        indicator: { result, calcParams, extendData },
        bounding: { width: 240, height: 200 },
        xAxis: { convertToPixel: (i: number) => i * BAR_PX },
        yAxis: { convertToPixel: (p: number) => 200 - p },
      } as never);
      return rects[0];
    };
    expect(cut({})).toBe(240);
    expect(cut({ extendRight: true })).toBe(240);
  });
});
