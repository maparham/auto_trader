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
const { trendlinesOutputs, TRENDLINES_DEFAULTS, TRENDLINES_EXTEND_DEFAULTS } = await import(
  "./indicators/trendlinesOutputs"
);

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

  it("has settings metadata for all twenty-four params and the extend select", () => {
    const inputs = resolveInputs("TRENDLINES", undefined);
    // Twenty-four calcParams, all numbers now that One line per pivot became
    // the integer Max lines per pivot. The merge tolerance is a calcParam because a merged-away line
    // must stop reporting to rules, which only the calc can arrange. The
    // extra numbers are the three dim thresholds and the dim opacity, which
    // choose an alpha and so are render-only.
    expect(inputs.filter((i) => i.source === "calcParam")).toHaveLength(24);
    expect(inputs.filter((i) => i.type === "number")).toHaveLength(28);
    expect(inputs.find((i) => i.key === "extend")?.type).toBe("select");
    // resolveInputs falls back to synthesized generic inputs when a name has no
    // metadata, so assert the named title too or this test passes on a miss.
    expect(indicatorInfo("TRENDLINES").title).toBe("Trendlines");
  });

  it("pairs the related inputs two to a row", () => {
    // groupInputs only pairs CONSECUTIVE inputs sharing a group, so this also
    // pins the panel's order: reordering the meta list silently unpairs them.
    const chunks = groupInputs(
      resolveInputs("TRENDLINES", undefined).filter((i) => i.tab !== "style"),
    );
    expect(chunks.map((c) => c.map((i) => i.label))).toEqual([
      ["Max Trendlines"],
      ["Min Pivot Length", "Max Pivot Pairs"],
      ["Min Pivot Size", "Min Pivot Reach"],
      ["Max Touch Gap", "Max Pierce"],
      ["Back Clearance"],
      ["Min Touches", "Max Touches"],
      ["Min Span", "Max Span"],
      ["Min Touch Spacing", "Max Touch Spacing"],
      ["Min Slope", "Max Slope"],
      ["Min Crossings", "Max Crossings"],
      ["Max Distance (×ATR)", "Max Distance (%)"],
      ["Max Projection"],
      ["Extend"],
      ["Max lines per pivot"],
      ["Merge Lines within", "Merge Lines within (%)"],
    ]);
  });

  // A fresh instance stores no extendData beyond indType, so what it DRAWS is
  // the draw path's own `??` fallback while what the panel SHOWS is the meta
  // row's `default`. They were allowed to drift once (the defaults were
  // flipped in the meta alone, so a new pane painted plain pivot arrows over
  // an unticked "Show pivots"); both now read TRENDLINES_EXTEND_DEFAULTS, and
  // this is the assertion that keeps them there.
  it("takes its render-only boolean defaults from the shared constant", () => {
    const inputs = resolveInputs("TRENDLINES", undefined);
    for (const [field, want] of Object.entries(TRENDLINES_EXTEND_DEFAULTS)) {
      const row = inputs.find((i) => i.field === field);
      expect(row?.source).toBe("extend");
      expect(row?.default).toBe(want);
    }
  });

  it("puts the render-only rows on the Style tab, paired like Inputs", () => {
    // Marks, the end tag and dimming change how a line LOOKS, so they sit
    // with colour and width rather than among the pivot inputs. Extend stays
    // on Inputs: it changes where a line ends, which rules can see.
    const style = resolveInputs("TRENDLINES", undefined).filter((i) => i.tab === "style");
    expect(style.every((i) => i.source === "extend")).toBe(true);
    expect(groupInputs(style).map((c) => c.map((i) => i.label))).toEqual([
      ["Show pivots", "Mark line pivots"],
      ["Show line stats"],
      ["Dim opacity"],
      ["Dim after touching"],
      ["Dim if crossed"],
      ["Dim if untouched for"],
    ]);
    expect(style.find((i) => i.key === "extend")).toBeUndefined();
  });

  it("declutters through the calc: Max lines per pivot is a calcParam integer", () => {
    const d = resolveInputs("TRENDLINES", undefined).find((i) => i.key === "p22");
    expect(d?.type).toBe("number");
    expect(d?.source).toBe("calcParam");
    expect(d?.label).toBe("Max lines per pivot");
    expect(d?.default).toBe(0);
    expect(d?.min).toBe(0);
    expect(d?.step).toBe(1);
    expect(d?.unbounded).toBe(true);
    const m = resolveInputs("TRENDLINES", undefined).find((i) => i.label === "Merge Lines within");
    expect(m?.source).toBe("calcParam");
    expect(m?.index).toBe(21);
  });

  it("gives Pivot Size a default, since older charts have no slot 6", () => {
    // Instances created before the param existed store fewer calcParams, so
    // calcParams[6] is undefined and the modal renders inp.default rather than
    // an empty box. Same 0 parseTrendlinesConfig substitutes, so what is shown
    // is what the indicator is actually doing.
    const swing = resolveInputs("TRENDLINES", undefined).find(
      (i) => i.index === 6,
    );
    expect(swing?.label).toBe("Min Pivot Size");
    expect(swing?.suffix).toBe("ATR");
    expect(swing?.default).toBe(0);
  });

  it("is a referenceable expression instance exposing tl_1..tl_N and tl_nearest", () => {
    expect(EXPR_INSTANCE_TYPES.has("TRENDLINES")).toBe(true);
    const live = [{ id: "tl1", type: "TRENDLINES", calcParams: [], extendData: {} }];
    const [inst] = exprInstancesFor(live as never);
    expect(inst.outputs).toEqual(trendlinesOutputs(TRENDLINES_DEFAULTS));
    expect(inst.outputs).toEqual(["tl_1", "tl_2", "tl_3", "tl_nearest"]);
    expect(inst.timeframe).toBeNull();

    const nine = exprInstancesFor([
      { id: "t", type: "TRENDLINES", calcParams: [5, 0.75, 2, 20, 250, 9], extendData: {} },
    ] as never)[0];
    expect(nine.outputs).toHaveLength(10);
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
    expect(warmup("tl1", "tl_1")).toBe(14 + 10 + 20);
    expect(warmup("tl1", "not_an_output")).toBe(0);
  });
});
