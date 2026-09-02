import { describe, it, expect, vi } from "vitest";

// The templates read LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { computeMa, maFigures, MA_KIND_LABEL, maLegendLabel } = await import("./ma");
const { maSeries } = await import("../mtf");

// Shared with mtf.test.ts (lib/testBars.ts) so the bar shape cannot drift
// between the kernel tests and the template tests.
import { vbars } from "../testBars";

describe("computeMa maType", () => {
  const candles = vbars([10, 20, 30], [1, 2, 3]);
  it("defaults to the template kind when maType is unset", () => {
    const pts = computeMa(candles, "sma", 2, {});
    expect(pts[1].ma).toBeCloseTo(15, 10); // plain SMA
  });
  it("resolves extendData.maType over the template kind", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "evwma" });
    const { base } = maSeries(candles, "evwma", 2);
    expect(pts.map((p) => p.ma)).toEqual(base.map((v) => v ?? undefined));
  });
  it("falls back to the template kind on a garbage maType", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "nope" as never });
    expect(pts[1].ma).toBeCloseTo(15, 10);
  });
});

describe("computeMa envelope", () => {
  const candles = vbars([10, 20, 30, 40], [1, 2, 3, 4]);
  it("emits the same-kind MA of high and low when on", () => {
    const pts = computeMa(candles, "sma", 2, { maType: "vwma", envelope: true });
    const hi = maSeries(candles, "vwma", 2, { source: "high" }).base;
    const lo = maSeries(candles, "vwma", 2, { source: "low" }).base;
    expect(pts.map((p) => p.bandHi)).toEqual(hi.map((v) => v ?? undefined));
    expect(pts.map((p) => p.bandLo)).toEqual(lo.map((v) => v ?? undefined));
  });
  it("emits no band values when off", () => {
    const pts = computeMa(candles, "sma", 2, {});
    expect(pts.every((p) => p.bandHi === undefined && p.bandLo === undefined)).toBe(true);
  });
  it("bands ignore offset and mirror the UNshifted base window", () => {
    const pts = computeMa(candles, "sma", 2, { envelope: true, offset: 1 });
    const hi = maSeries(candles, "sma", 2, { source: "high" }).base;
    expect(pts.map((p) => p.bandHi)).toEqual(hi.map((v) => v ?? undefined));
  });
});

describe("computeMa MTF", () => {
  // Minute-spaced chart bars (vbars) under a 2-minute HTF stash. waitClose
  // alignment: each HTF bar's value appears from its CLOSE (open + htfMs) on.
  const candles = vbars([1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]);
  const mtf = {
    timeframe: "MINUTE_2",
    htfStarts: [0, 120_000],
    htfSeries: [10, 20],
    htfMs: 120_000,
  };
  it("aligns the stashed HTF smoothing series as a separate smoothingMa line", () => {
    const pts = computeMa(candles, "ema", 2, {
      mtf: { ...mtf, htfSmoothing: [11, 21] },
    });
    expect(pts.map((p) => p.ma)).toEqual([undefined, undefined, 10, 10, 20, 20]);
    expect(pts.map((p) => p.smoothingMa)).toEqual([undefined, undefined, 11, 11, 21, 21]);
  });
  it("emits no smoothingMa when the stash carries no smoothing series", () => {
    const pts = computeMa(candles, "ema", 2, { mtf });
    expect(pts.every((p) => p.smoothingMa === undefined)).toBe(true);
  });
  it("draws bar-for-bar when the pin equals the chart timeframe", () => {
    // vbars are minute-spaced; a MINUTE_1-equivalent stash (htfMs = 60s) must
    // not lag the pair one bar — Chart and same-TF pin render identically.
    const pts = computeMa(candles, "ema", 2, {
      mtf: {
        timeframe: "MINUTE_1",
        htfStarts: candles.map((c) => c.timestamp),
        htfSeries: [1, 2, 3, 4, 5, 6],
        htfSmoothing: [10, 20, 30, 40, 50, 60],
        htfMs: 60_000,
      },
    });
    expect(pts.map((p) => p.ma)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pts.map((p) => p.smoothingMa)).toEqual([10, 20, 30, 40, 50, 60]);
  });
  it("admits a flagged forming entry from its open (waitClose unchecked)", () => {
    // Entry 1 is the FORMING bucket: chart bars 2-3 sit inside it and read its
    // value from its open; bar 0-1 (inside closed entry 0) still wait for the
    // close — history keeps waitClose.
    const pts = computeMa(candles, "ema", 2, {
      mtf: { ...mtf, formingIdx: 1, htfSmoothing: [11, 21] },
    });
    expect(pts.map((p) => p.ma)).toEqual([undefined, undefined, 20, 20, 20, 20]);
    expect(pts.map((p) => p.smoothingMa)).toEqual([undefined, undefined, 21, 21, 21, 21]);
  });
});

describe("maLegendLabel", () => {
  it("keeps the template label when never flipped", () => {
    expect(maLegendLabel(undefined, "ema")).toBe("EMA");
    expect(maLegendLabel(undefined, "sma")).toBe("MA");
    // An explicit maType equal to the template kind is still never-flipped.
    expect(maLegendLabel("ema", "ema")).toBe("EMA");
    expect(maLegendLabel("sma", "sma")).toBe("MA");
  });
  it("shows the kind label once the type is flipped", () => {
    expect(maLegendLabel("sma", "ema")).toBe("SMA");
    expect(maLegendLabel("evwma", "sma")).toBe("EVWMA");
    expect(maLegendLabel("vwma", "ema")).toBe("VWMA");
  });
  it("falls back to the template label on a garbage maType", () => {
    expect(maLegendLabel("nope", "ema")).toBe("EMA");
    expect(maLegendLabel(42, "sma")).toBe("MA");
  });
});

describe("maFigures", () => {
  it("titles the base and smoothing lines by the kind label", () => {
    const figs = maFigures(MA_KIND_LABEL.vwma, false);
    expect(figs.map((f) => f.key)).toEqual(["ma", "smoothingMa", "bandHi", "bandLo"]);
    expect(figs[0].title).toBe("VWMA: ");
    expect(figs[1].title).toBe("VWMA MA: ");
  });
  it("titles the band figures only when the envelope is on", () => {
    // Titleless figures are skipped by the DOM legend, so an off envelope
    // must not read as two "n/a" rows.
    expect(maFigures("EVWMA", false).slice(2).map((f) => f.title)).toEqual(["", ""]);
    expect(maFigures("EVWMA", true).slice(2).map((f) => f.title)).toEqual([
      "EVWMA High: ",
      "EVWMA Low: ",
    ]);
  });
});
