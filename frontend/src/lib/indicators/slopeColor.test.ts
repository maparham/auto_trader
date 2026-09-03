import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { slopeStates, defaultSlopeColor, segmentRuns } = await import("./slopeColor");
const { AVWAP_TEMPLATE, VWAP_TEMPLATE } = await import("./vwap");

describe("slopeStates", () => {
  it("classifies rising / falling / flat around the band edges", () => {
    // len=1, band=0.1 %/bar. 100→100.2 = +0.2%/bar rising; →99.8 = falling;
    // →100.05 = +0.05% flat; exactly ±0.1% is flat (≤ band).
    const v = [100, 100.2, 100, 99.8, 99.8, 99.85, 99.85, 99.95];
    const s = slopeStates(v, 1, 0.1);
    expect(s[0]).toBeUndefined(); // warm-up
    expect(s[1]).toBe(1);   // +0.2 %/bar
    expect(s[2]).toBe(-1);  // -0.199... %/bar
    expect(s[3]).toBe(-1);
    expect(s[4]).toBe(0);   // 0 %/bar
    expect(s[5]).toBe(0);   // ~+0.050 %/bar within band
    expect(s[6]).toBe(0);
    expect(s[7]).toBe(1);   // (99.95-99.85)/99.85*100 = 0.10015...% > 0.1 → rising
  });

  it("treats exactly the band edge as flat", () => {
    // (100.1 - 100)/100/1*100 = exactly 0.1 → flat (≤ band).
    expect(slopeStates([100, 100.1], 1, 0.1)[1]).toBe(0);
  });

  it("divides by N so the band is stable as lookback grows", () => {
    // 100 → 100.4 over 2 bars = 0.2 %/bar with len=2.
    const s = slopeStates([100, 100.2, 100.4], 2, 0.1);
    expect(s[0]).toBeUndefined();
    expect(s[1]).toBeUndefined(); // i < N
    expect(s[2]).toBe(1);
  });

  it("returns undefined for missing values and zero denominators", () => {
    const s = slopeStates([0, 5, undefined, 6, 7], 1, 0.1);
    expect(s[1]).toBeUndefined(); // v[i-1] === 0
    expect(s[2]).toBeUndefined(); // v[i] missing
    expect(s[3]).toBeUndefined(); // v[i-1] missing
    expect(s[4]).toBe(1);
  });

  it("flatBandPct 0 collapses to 2-state (any nonzero slope colors)", () => {
    const s = slopeStates([100, 100.0001, 100.0001], 1, 0);
    expect(s[1]).toBe(1);
    expect(s[2]).toBe(0); // exactly zero slope stays flat even at band 0
  });
});

describe("AVWAP slopeState (via AVWAP_TEMPLATE.calc)", () => {
  // Closes rise steadily with constant volume, so the running vwap from the
  // anchor forward rises monotonically.
  const bars = [0, 1, 2, 3, 4].map((i) => ({
    timestamp: i * 60_000, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1,
  }));
  const SLOPE_CFG = {
    enabled: true, len: 1, flatBandPct: 0.1,
    up: { color: "#0f0" }, down: { color: "#f00" }, flat: { color: "#999" },
  };
  it("attaches per-bar states from the anchor forward when enabled", () => {
    const pts = AVWAP_TEMPLATE.calc!(bars, {
      calcParams: [bars[1].timestamp],
      extendData: { slopeColor: SLOPE_CFG },
    } as never) as Array<{ slopeState?: number }>;
    // Pre-anchor bar carries no vwap, so no state either.
    expect(pts[0].slopeState).toBeUndefined();
    // From the first bar with two vwap samples on, the rising vwap reads rising.
    expect(pts.slice(2).every((p) => p.slopeState === 1)).toBe(true);
  });

  it("attaches nothing when disabled", () => {
    const pts = AVWAP_TEMPLATE.calc!(bars, {
      calcParams: [bars[1].timestamp],
      extendData: {},
    } as never) as Array<{ slopeState?: number }>;
    expect(pts.every((p) => p.slopeState === undefined)).toBe(true);
  });
});

describe("VWAP slopeState (via VWAP_TEMPLATE.calc)", () => {
  // Same rising-vwap fixture as the AVWAP case above, but through the plain
  // (unanchored) VWAP template — its calc used to hardcode ext = {}, which
  // would silently drop extendData.slopeColor.
  const bars = [0, 1, 2, 3, 4].map((i) => ({
    timestamp: i * 60_000, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1,
  }));
  const SLOPE_CFG = {
    enabled: true, len: 1, flatBandPct: 0.1,
    up: { color: "#0f0" }, down: { color: "#f00" }, flat: { color: "#999" },
  };
  it("attaches per-bar states when slopeColor is enabled", () => {
    const pts = VWAP_TEMPLATE.calc!(bars, {
      extendData: { slopeColor: SLOPE_CFG },
    } as never) as Array<{ slopeState?: number }>;
    expect(pts.slice(2).every((p) => p.slopeState === 1)).toBe(true);
  });

  it("attaches nothing when slopeColor is absent", () => {
    const pts = VWAP_TEMPLATE.calc!(bars, { extendData: {} } as never) as Array<{ slopeState?: number }>;
    expect(pts.every((p) => p.slopeState === undefined)).toBe(true);
  });
});

describe("segmentRuns", () => {
  it("batches consecutive same-state segments, styling each segment by its NEWER endpoint", () => {
    // states:      u  u  d  d  u        (u=1, d=-1)
    // segments:    [0-1]u [1-2]d [2-3]d [3-4]u
    const runs = segmentRuns([1, 1, -1, -1, 1], 0, 5);
    expect(runs).toEqual([
      { state: 1, from: 0, to: 1 },
      { state: -1, from: 1, to: 3 },
      { state: 1, from: 3, to: 4 },
    ]);
  });
  it("maps undefined (warm-up) to flat (0)", () => {
    expect(segmentRuns([undefined, 1], 0, 2)).toEqual([{ state: 1, from: 0, to: 1 }]);
    expect(segmentRuns([undefined, undefined, 1], 0, 3)).toEqual([
      { state: 0, from: 0, to: 1 },
      { state: 1, from: 1, to: 2 },
    ]);
  });
});

describe("defaultSlopeColor", () => {
  it("is disabled with spec defaults", () => {
    const d = defaultSlopeColor();
    expect(d.enabled).toBe(false);
    expect(d.len).toBe(1);
    expect(d.flatBandPct).toBe(0.1);
    expect(d.up.color).toBe("#26a69a");
    expect(d.down.color).toBe("#ef5350");
    expect(d.flat.color).toBe("#9598A1");
  });
});
