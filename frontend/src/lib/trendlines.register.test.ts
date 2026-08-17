import { describe, expect, it, vi } from "vitest";

// customIndicators reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator registration tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { BASE_TEMPLATES, OVERLAY_INDICATORS } = await import("./customIndicators");
// INDICATOR_META is module-local; indicatorInfo and resolveInputs are the
// exported surface.
const { indicatorInfo, resolveInputs } = await import("./indicatorMeta");
const { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef } = await import("./exprInstances");
const { TRENDLINES_OUTPUTS } = await import("./indicators/trendlinesOutputs");

describe("TRENDLINES registration", () => {
  it("has a base template", () => {
    expect(BASE_TEMPLATES.TRENDLINES).toBeDefined();
    // The pane paints its own canvas; declaring figures would feed a line's
    // far-future projection into the candle pane's y-autoscale.
    expect(BASE_TEMPLATES.TRENDLINES.figures).toEqual([]);
  });

  it("overlays the candle pane rather than opening a sub-pane", () => {
    // isSubPaneIndicator (indicators.ts) is the negation of this set, and a
    // non-member is created with no paneId, i.e. in its own bottom pane. The
    // draw converts prices through the pane's y-axis, so a sub-pane with no
    // figures and no candles would autoscale from 0 and render nothing usable.
    expect(OVERLAY_INDICATORS.has("TRENDLINES")).toBe(true);
  });

  it("has settings metadata for all eight params plus the extend select", () => {
    const inputs = resolveInputs("TRENDLINES", undefined);
    expect(inputs.filter((i) => i.type === "number")).toHaveLength(8);
    expect(inputs.find((i) => i.key === "extend")?.type).toBe("select");
    // resolveInputs falls back to synthesized generic inputs when a name has no
    // metadata, so assert the named title too or this test passes on a miss.
    expect(indicatorInfo("TRENDLINES").title).toBe("Trendlines");
  });

  it("is a referenceable expression instance exposing four outputs", () => {
    expect(EXPR_INSTANCE_TYPES.has("TRENDLINES")).toBe(true);
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const [inst] = exprInstancesFor(live as never);
    expect(inst.outputs).toEqual([...TRENDLINES_OUTPUTS]);
    expect(inst.timeframe).toBeNull();
  });

  it("gives every output the same warm-up floor and unknown outputs zero", () => {
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const warmup = exprWarmupByRef(live as never);
    // ATR(14) + two pivotLen(5) confirms + minSpanBars(20).
    expect(warmup("tl1", "tl_support")).toBe(14 + 10 + 20);
    expect(warmup("tl1", "not_an_output")).toBe(0);
  });
});
