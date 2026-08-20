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
const { indicatorInfo, resolveInputs, groupInputs } = await import("./indicatorMeta");
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

  it("has settings metadata for all sixteen params, the merge tolerance and the extend select", () => {
    const inputs = resolveInputs("TRENDLINES", undefined);
    // Sixteen calcParams plus the merge tolerance, which is a number on
    // extendData rather than a calcParam because merging never moves an emitted
    // value. It is also the merge switch: 0 merges nothing, which is why there
    // is no checkbox beside it.
    expect(inputs.filter((i) => i.type === "number")).toHaveLength(17);
    expect(inputs.filter((i) => i.source === "calcParam")).toHaveLength(16);
    expect(inputs.find((i) => i.key === "extend")?.type).toBe("select");
    // resolveInputs falls back to synthesized generic inputs when a name has no
    // metadata, so assert the named title too or this test passes on a miss.
    expect(indicatorInfo("TRENDLINES").title).toBe("Trendlines");
  });

  it("pairs the related inputs two to a row", () => {
    // groupInputs only pairs CONSECUTIVE inputs sharing a group, so this also
    // pins the panel's order: reordering the meta list silently unpairs them.
    const chunks = groupInputs(resolveInputs("TRENDLINES", undefined));
    expect(chunks.map((c) => c.map((i) => i.label))).toEqual([
      ["Max Trendlines"],
      ["Min Back Clearance"],
      ["Min Pivot Length", "Max Pivot Pairs"],
      ["Max Pierce", "Max Touch Gap"],
      ["Min Touches", "Max Touches"],
      ["Min Span", "Max Span"],
      ["Max Projection", "Max Break Hold"],
      ["Min Pivot Size", "Min Pivot Reach"],
      ["Min Slope", "Max Slope"],
      ["Extend"],
      ["Declutter"],
      ["Hide broken lines"],
      ["Merge Lines within"],
    ]);
  });

  it("offers the two decluttering rules as ONE choice, never both at once", () => {
    const d = resolveInputs("TRENDLINES", undefined).find((i) => i.key === "declutter");
    expect(d?.type).toBe("select");
    expect(d?.options?.map((o) => o.value)).toEqual(["off", "near", "pivot"]);
    // The near-price cut was the old checkbox's default, so it stays the
    // select's: switching the control must not change what a pane draws.
    expect(d?.default).toBe("near");
  });

  it("gives Pivot Size a default, since older charts have no slot 8", () => {
    // Instances created before the param existed store eight calcParams, so
    // calcParams[8] is undefined and the modal renders inp.default rather than
    // an empty box. Same 0 parseTrendlinesConfig substitutes, so what is shown
    // is what the indicator is actually doing.
    const swing = resolveInputs("TRENDLINES", undefined).find(
      (i) => i.index === 8,
    );
    expect(swing?.label).toBe("Min Pivot Size");
    expect(swing?.suffix).toBe("ATR");
    expect(swing?.default).toBe(0);
  });

  it("is a referenceable expression instance exposing four outputs", () => {
    expect(EXPR_INSTANCE_TYPES.has("TRENDLINES")).toBe(true);
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const [inst] = exprInstancesFor(live as never);
    expect(inst.outputs).toEqual([...TRENDLINES_OUTPUTS]);
    expect(inst.timeframe).toBeNull();
  });

  it("reports its timeframe pin, so a rule reads the higher timeframe's lines", () => {
    // The backend recomputes from this: evaluate.py's pinned-IndicatorRef branch
    // runs the detector on the pinned timeframe's candles and aligns the result
    // onto the base bars, which is what the chart draws too.
    const live = [
      { id: "tl1", type: "TRENDLINES", calcParams: [], extendData: { mtf: { timeframe: "HOUR_4" } } },
    ];
    expect(exprInstancesFor(live as never)[0].timeframe).toBe("HOUR_4");
  });

  it("gives every output the same warm-up floor and unknown outputs zero", () => {
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const warmup = exprWarmupByRef(live as never);
    // ATR(14) + two pivotLen(5) confirms + minSpanBars(20).
    expect(warmup("tl1", "tl_support")).toBe(14 + 10 + 20);
    expect(warmup("tl1", "not_an_output")).toBe(0);
  });
});
