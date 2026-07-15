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
