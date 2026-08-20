import { describe, it, expect, vi } from "vitest";
import type { Chart } from "klinecharts";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const {
  insetBandRect,
  resolveDomain,
  valueToBandY,
  insetSpecOf,
  INSET_BAND_MIN_PX,
  isInsetInstance,
  insetFiguresOf,
  legendFiguresOf,
  legendPrecisionOf,
  insetOrder,
  withInset,
  drawInset,
  insetTemplate,
  INSET_BAND_FRACTION,
  INSET_BAND_MAX_FRACTION,
  clampBandFraction,
  bandFractionFromDrag,
  insetBandFraction,
  setInsetBandFraction,
  insetBandBox,
} = await import("./inset");
// For the draw-swap assertion: the base RSI template already has a draw of its own.
const { BASE_TEMPLATES } = await import("../customIndicators");

describe("insetBandRect", () => {
  it("takes the designed fraction of a roomy pane", () => {
    // 400 * 0.28 = 112, above the 56px floor and below the 160px cap.
    expect(insetBandRect({ height: 400 })).toEqual({ top: 288, height: 112 });
  });

  it("floors at the minimum on a pane where the fraction would be thinner", () => {
    // 150 * 0.28 = 42 -> floored to 56, still under the 60px cap.
    expect(insetBandRect({ height: 150 })).toEqual({ top: 94, height: 56 });
  });

  it("caps at the max fraction, so the band never dwarfs a short pane", () => {
    // A pane too short for the ASKED fraction: 60 * 0.8 = 48 wins over the 56px floor,
    // so the band stays inside its pane instead of overflowing it.
    expect(insetBandRect({ height: 60 }, 0.8)).toEqual({ top: 12, height: 48 });
  });

  it("honors an explicit fraction, which is what a band drag writes", () => {
    expect(insetBandRect({ height: 400 }, 0.5)).toEqual({ top: 200, height: 200 });
  });

  it("returns a zero band for a zero-height pane instead of a negative rect", () => {
    expect(insetBandRect({ height: 0 })).toEqual({ top: 0, height: 0 });
  });

  it("stays anchored to the pane's bottom edge at a fractional pane height", () => {
    const { top, height } = insetBandRect({ height: 400.5 });
    expect(top + height).toBe(400.5);
  });

  it("never exceeds the max fraction, even on an absurdly short pane", () => {
    const { height } = insetBandRect({ height: 2 }, INSET_BAND_MAX_FRACTION);
    expect(height).toBeLessThanOrEqual(2 * INSET_BAND_MAX_FRACTION);
  });
});

describe("resolveDomain", () => {
  it("returns a fixed domain untouched, ignoring the data", () => {
    expect(resolveDomain({ domain: [0, 100], pad: 0.08 }, [42, 43])).toEqual([0, 100]);
  });

  it("fits an auto domain to the values with symmetric padding", () => {
    // span 10, pad 0.08 -> 0.8 each side
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [10, 20])).toEqual([9.2, 20.8]);
  });

  it("ignores nulls, undefined and non-finite values", () => {
    expect(resolveDomain({ domain: "auto", pad: 0 }, [null, 5, undefined, NaN, 7])).toEqual([5, 7]);
  });

  it("falls back to a unit domain when nothing is finite", () => {
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [null, undefined])).toEqual([0, 1]);
  });

  it("keeps a flat series flat rather than inventing a span", () => {
    expect(resolveDomain({ domain: "auto", pad: 0.08 }, [3, 3, 3])).toEqual([3, 3]);
  });
});

describe("valueToBandY", () => {
  it("puts the domain max at the band top and the min at the bottom", () => {
    expect(valueToBandY(100, [0, 100], 80)).toBe(0);
    expect(valueToBandY(0, [0, 100], 80)).toBe(80);
    expect(valueToBandY(50, [0, 100], 80)).toBe(40);
  });

  it("clamps out-of-domain values to the band edges", () => {
    expect(valueToBandY(150, [0, 100], 80)).toBe(0);
    expect(valueToBandY(-20, [0, 100], 80)).toBe(80);
  });

  it("centres a degenerate domain instead of dividing by zero", () => {
    expect(valueToBandY(3, [3, 3], 80)).toBe(40);
  });
});

describe("insetSpecOf", () => {
  it("pins RSI to a fixed 0-100 domain so its levels sit still", () => {
    expect(insetSpecOf("RSI").domain).toEqual([0, 100]);
  });

  it("auto-scales ATR and SLOPE", () => {
    expect(insetSpecOf("ATR").domain).toBe("auto");
    expect(insetSpecOf("SLOPE").domain).toBe("auto");
  });

  it("auto-scales an unknown type rather than throwing", () => {
    expect(insetSpecOf("NOPE").domain).toBe("auto");
  });
});

describe("constants", () => {
  it("keeps the band floor above a legible minimum", () => {
    expect(INSET_BAND_MIN_PX).toBeGreaterThanOrEqual(40);
  });
});

const insetInd = (over: Record<string, unknown> = {}) => ({
  name: "RSI",
  calcParams: [14],
  precision: 8,
  figures: [] as unknown[],
  visible: true,
  paneId: "candle_pane",
  extendData: { indType: "RSI", inset: true },
  ...over,
});

describe("isInsetInstance", () => {
  it("reads the explicit marker", () => {
    expect(isInsetInstance(insetInd())).toBe(true);
  });

  it("is false for a figure-less candle-pane indicator that is not inset", () => {
    // ProximityHeatmap ships figures: [] on candle_pane; an emptiness check would
    // wrongly drag it into the inset path.
    expect(isInsetInstance({ name: "ProximityHeatmap", extendData: {} })).toBe(false);
  });

  it("does not throw on a missing extendData", () => {
    expect(isInsetInstance({ name: "RSI" })).toBe(false);
  });
});

describe("insetFiguresOf", () => {
  it("derives RSI's static figure list from the base template", () => {
    expect(insetFiguresOf(insetInd()).map((f) => f.key)).toEqual(["rsi"]);
  });

  it("regenerates SLOPE's figures from the LIVE calcParams, never a stored copy", () => {
    const two = insetFiguresOf(
      insetInd({ name: "SLOPE", calcParams: [9, 21], extendData: { indType: "SLOPE", inset: true } }),
    );
    // one line per length, plus the title-less thHi/thLo auto-scale figures
    expect(two.filter((f) => f.title).length).toBe(2);
    expect(two.map((f) => f.key)).toContain("thHi");
  });

  it("returns [] for a type with no base template", () => {
    expect(insetFiguresOf(insetInd({ extendData: { indType: "MACD", inset: true } }))).toEqual([]);
  });
});

describe("legend helpers", () => {
  it("gives an inset instance the base template's figures and precision", () => {
    expect(legendFiguresOf(insetInd()).map((f) => f.key)).toEqual(["rsi"]);
    expect(legendPrecisionOf(insetInd())).toBe(2); // RSI_TEMPLATE.precision, not INSET_PRECISION
  });

  it("leaves a normal instance reading its own fields", () => {
    const normal = { name: "RSI", precision: 2, figures: [{ key: "rsi", title: "RSI: ", type: "line" }], extendData: { indType: "RSI" } };
    expect(legendFiguresOf(normal)).toBe(normal.figures);
    expect(legendPrecisionOf(normal)).toBe(2);
  });

  it("leaves a figure-less non-inset instance empty", () => {
    const heatmap = { name: "ProximityHeatmap", precision: 0, figures: [], extendData: {} };
    expect(legendFiguresOf(heatmap)).toEqual([]);
  });
});

describe("insetOrder", () => {
  const chartWith = (inds: Array<Record<string, unknown>>) =>
    ({ getIndicators: () => inds }) as unknown as Chart;

  it("lists inset instances in pane order", () => {
    const chart = chartWith([
      { name: "EMA", paneId: "candle_pane", visible: true, extendData: { indType: "EMA" } },
      insetInd({ name: "RSI" }),
      insetInd({ name: "ATR", extendData: { indType: "ATR", inset: true } }),
    ]);
    expect(insetOrder(chart)).toEqual(["RSI", "ATR"]);
  });

  it("excludes hidden instances, so hiding the first does not orphan the band chrome", () => {
    const chart = chartWith([
      insetInd({ name: "RSI", visible: false }),
      insetInd({ name: "ATR", extendData: { indType: "ATR", inset: true } }),
    ]);
    expect(insetOrder(chart)).toEqual(["ATR"]);
  });

  it("is empty when nothing is inset", () => {
    expect(insetOrder(chartWith([{ name: "EMA", paneId: "candle_pane", visible: true }]))).toEqual([]);
  });
});

describe("withInset", () => {
  it("sets the flag on the named instance only", () => {
    expect(withInset([{ id: "RSI", type: "RSI" }, { id: "ATR", type: "ATR" }], "RSI", true)).toEqual([
      { id: "RSI", type: "RSI", inset: true },
      { id: "ATR", type: "ATR" },
    ]);
  });

  it("removes the key rather than writing false", () => {
    const [only] = withInset([{ id: "RSI", type: "RSI", inset: true }], "RSI", false);
    expect(Object.prototype.hasOwnProperty.call(only, "inset")).toBe(false);
  });

  it("returns a new array and leaves unknown ids alone", () => {
    const list = [{ id: "RSI", type: "RSI" }];
    const next = withInset(list, "NOPE", true);
    expect(next).not.toBe(list);
    expect(next).toEqual(list);
  });

  it("keeps key ORDER stable, because saveIndicators serializes with JSON.stringify", () => {
    // templateAutosave's sameTemplate compares saved payloads; a reordered key changes the bytes.
    expect(JSON.stringify(withInset([{ id: "RSI", type: "RSI" }], "RSI", true))).toBe(
      '[{"id":"RSI","type":"RSI","inset":true}]',
    );
    expect(JSON.stringify(withInset([{ id: "RSI", type: "RSI", inset: true }], "RSI", false))).toBe(
      '[{"id":"RSI","type":"RSI"}]',
    );
  });
});

// Recording 2D context: enough surface for the wrapper and for the base draws it
// delegates to, capturing the calls the assertions care about.
function fakeCtx() {
  const calls: string[] = [];
  // Line state lives off the canvas object so `stroke` can snapshot it without the
  // recorder referencing itself (which would leave `ctx` implicitly `any`).
  const style = { lineWidth: 1, dash: [] as number[], strokeStyle: "", translateY: 0 };
  // One entry per stroke, in order: what the line looked like AT that stroke.
  // `calls` alone only proves a stroke happened, not what it was painted with.
  const strokes: Array<{ width: number; dash: number[] }> = [];
  // Parallel to `strokes`, kept separate so the width/dash assertions can stay
  // exact-equality on a two-field shape.
  const strokeColors: string[] = [];
  const ctx = {
    calls,
    strokes,
    strokeColors,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (x: number, y: number) => { style.translateY += y; calls.push(`translate:${x},${y}`); },
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    clip: () => calls.push("clip"),
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => {
      calls.push("stroke");
      strokes.push({ width: style.lineWidth, dash: [...style.dash] });
      strokeColors.push(style.strokeStyle);
    },
    fill: () => {}, fillRect: () => {},
    fillText: (t: string) => calls.push(`text:${t}`), measureText: () => ({ width: 10 }),
    setLineDash: (d: number[]) => { style.dash = d ?? []; }, arc: () => {},
    globalAlpha: 1, fillStyle: "", font: "",
    get strokeStyle() { return style.strokeStyle; },
    set strokeStyle(v: string) { style.strokeStyle = v; },
    get lineWidth() { return style.lineWidth; },
    set lineWidth(v: number) { style.lineWidth = v; },
    textAlign: "", textBaseline: "",
  };
  return ctx;
}

function drawParams(over: Record<string, unknown> = {}) {
  const result = Array.from({ length: 10 }, (_, i) => ({ rsi: i * 10 }));
  return {
    ctx: fakeCtx(),
    chart: {
      getVisibleRange: () => ({ from: 0, to: 10 }),
      getBarSpace: () => ({ bar: 6, halfBar: 3, gapBar: 5, halfGapBar: 2.5 }),
      getIndicators: () => [
        { name: "RSI", paneId: "candle_pane", visible: true, extendData: { indType: "RSI", inset: true } },
      ],
      getDataList: () => result.map(() => ({ open: 1, high: 2, low: 0, close: 1, timestamp: 0 })),
    },
    indicator: {
      name: "RSI", calcParams: [14], precision: 8, figures: [], visible: true,
      shortName: "RSI", styles: { lines: [{ color: "#7E57C2" }] },
      extendData: { indType: "RSI", inset: true },
      result,
    },
    xAxis: { convertToPixel: (i: number) => i * 10 },
    yAxis: { convertToPixel: (v: number) => 1000 - v },
    bounding: { width: 500, height: 400, left: 0, right: 500, top: 0, bottom: 0 },
    ...over,
  };
}

const strokeCount = (p: { ctx: { calls: string[] } }) =>
  p.ctx.calls.filter((c) => c === "stroke").length;

describe("drawInset", () => {
  it("returns true so klinecharts draws no figures of its own", () => {
    expect(drawInset("RSI")(drawParams() as never)).toBe(true);
  });

  it("translates to the band and clips to it", () => {
    const p = drawParams();
    drawInset("RSI")(p as never);
    // 400px pane -> 112px band at top 288
    expect(p.ctx.calls).toContain("translate:0,288");
    expect(p.ctx.calls).toContain("rect:0,0,500,112");
    expect(p.ctx.calls).toContain("clip");
  });

  it("balances save and restore even when the base draw throws", () => {
    // A base draw that throws must not leave the canvas translated for the next
    // indicator on this pane, so the wrapper restores in a finally.
    const exploding = { figures: [], draw: () => { throw new Error("boom"); } };
    const p = drawParams();
    expect(() => drawInset("RSI", exploding as never)(p as never)).not.toThrow();
    expect(p.ctx.calls.filter((c) => c === "save").length)
      .toBe(p.ctx.calls.filter((c) => c === "restore").length);
    expect(p.ctx.calls.at(-1)).toBe("restore");
  });

  it("skips the rest of the paint when the base draw throws, rather than half-drawing", () => {
    // Only the delegated base draw is guarded. On a throw we abandon this
    // instance's frame instead of layering our lines and label over whatever
    // half-drawn state the base left behind.
    const exploding = {
      figures: [{ key: "rsi", title: "RSI: ", type: "line" }],
      draw: () => { throw new Error("boom"); },
    };
    const p = drawParams();
    drawInset("RSI", exploding as never)(p as never);
    expect(strokeCount(p)).toBe(1); // the chrome lid, painted before the throw
    expect(p.ctx.calls.some((c) => c.startsWith("text:"))).toBe(false);
  });

  it("logs a throwing base draw once, not once per frame", () => {
    // A base draw that throws throws on EVERY frame, so an unguarded console.error
    // floods the console at frame rate. A name no other test uses, so the assertion
    // does not depend on what earlier tests already logged.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exploding = { figures: [], draw: () => { throw new Error("boom"); } };
      const draw = drawInset("RSI", exploding as never);
      for (let i = 0; i < 3; i++) {
        const p = drawParams();
        p.indicator.name = "THROTTLE_PROBE";
        draw(p as never);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("hands the base draw a yAxis shim that maps the domain onto the band", () => {
    // Inject a recording base so the substitution is asserted directly rather than
    // inferred from canvas calls.
    let got = null as { toY: (v: number) => number; height: number } | null;
    const stub = {
      figures: [{ key: "rsi", title: "RSI: ", type: "line" }],
      draw: (dp: { yAxis: { convertToPixel: (v: number) => number }; bounding: { height: number } }) => {
        got = { toY: dp.yAxis.convertToPixel, height: dp.bounding.height };
        return false;
      },
    };
    drawInset("RSI", stub as never)(drawParams() as never);
    expect(got).not.toBeNull();
    // RSI's fixed 0-100 domain over a 112px band, y measured from the band's top.
    expect(got!.height).toBe(112);
    expect(got!.toY(100)).toBe(0);
    expect(got!.toY(0)).toBe(112);
    expect(got!.toY(50)).toBe(56);
  });

  it("uses the injected base's figures, so SLOPE's regenerated list flows through", () => {
    const stub = {
      figures: [{ key: "a", title: "A: ", type: "line" }],
      draw: () => false,
    };
    const p = drawParams();
    p.indicator.result = [{ a: 1 }, { a: 2 }] as never;
    drawInset("ATR", stub as never)(p as never);
    // Counted, not toContain: paintBandChrome strokes its hairline lid too, so a
    // bare toContain("stroke") would pass with paintInsetLines deleted outright.
    // 1 chrome lid + 1 line figure = 2.
    expect(strokeCount(p)).toBe(2);
  });

  it("paints each line at the width and dash its own style entry carries", () => {
    // The settings modal's Style tab offers width + dash for an inset instance, so
    // the band's stand-in figure loop has to read them (it once hardcoded 1px solid).
    // Two figures with DIFFERENT entries, because the bug this pins is an index that
    // advances before the read and hands line 0 line 1's style.
    const figures = [
      { key: "a", title: "A: ", type: "line" },
      { key: "b", title: "B: ", type: "line" },
    ];
    const p = drawParams();
    p.indicator.result = [{ a: 1, b: 2 }, { a: 2, b: 3 }] as never;
    p.indicator.styles = {
      lines: [
        { color: "#7E57C2", size: 3, style: "dashed", dashedValue: [5, 4] },
        // "dotted" is a dashed line with a short on/long off pattern (toKLineStyle),
        // so it must ride through dashedValue with no style branch of its own.
        { color: "#26A69A", size: 2, style: "dashed", dashedValue: [1, 3] },
      ],
    } as never;
    drawInset("ATR", { figures, draw: () => false } as never)(p as never);
    // strokes[0] is the chrome lid (1px solid); the figures follow in order.
    expect(p.ctx.strokes).toEqual([
      { width: 1, dash: [] },
      { width: 3, dash: [5, 4] },
      { width: 2, dash: [1, 3] },
    ]);
  });

  it("falls back to 1px solid, and a dashed line does not leak onto the next one", () => {
    // An instance saved before the Style tab offered these controls has color-only
    // entries (or none), and must keep drawing exactly as it did: 1px, solid.
    const figures = [
      { key: "a", title: "A: ", type: "line" },
      { key: "b", title: "B: ", type: "line" },
    ];
    const p = drawParams();
    p.indicator.result = [{ a: 1, b: 2 }, { a: 2, b: 3 }] as never;
    p.indicator.styles = {
      lines: [{ color: "#7E57C2", size: 4, style: "dashed", dashedValue: [5, 4] }, { color: "#26A69A" }],
    } as never;
    drawInset("ATR", { figures, draw: () => false } as never)(p as never);
    expect(p.ctx.strokes.at(-1)).toEqual({ width: 1, dash: [] });
  });

  it("scales the stored alpha instead of replacing it, so inset keeps the user's opacity", () => {
    // The Style tab's color picker writes hex + opacity as an rgba() string. The band
    // draws slightly translucent because it sits ON TOP of the candles, but replacing
    // the stored alpha outright made a line the user set to 40% render at 90% here
    // while staying 40% in its own sub-pane: toggling inset visibly changed opacity.
    const figures = [{ key: "a", title: "A: ", type: "line" }];
    const p = drawParams();
    p.indicator.result = [{ a: 1 }, { a: 2 }] as never;
    p.indicator.styles = { lines: [{ color: "rgba(126, 87, 194, 0.4)" }] } as never;
    drawInset("ATR", { figures, draw: () => false } as never)(p as never);
    // 0.4 * LINE_ALPHA, not LINE_ALPHA.
    expect(p.ctx.strokeColors.at(-1)).toBe("rgba(126, 87, 194, 0.36000000000000004)");
  });

  it("still dims an opaque line, so band curves read as overlay rather than chrome", () => {
    const figures = [{ key: "a", title: "A: ", type: "line" }];
    const p = drawParams();
    p.indicator.result = [{ a: 1 }, { a: 2 }] as never;
    p.indicator.styles = { lines: [{ color: "#7E57C2" }] } as never;
    drawInset("ATR", { figures, draw: () => false } as never)(p as never);
    expect(p.ctx.strokeColors.at(-1)).toBe("rgba(126, 87, 194, 0.9)");
  });

  it("honors the base draw's isCover instead of overpainting the lines it drew", () => {
    // klinecharts runs its figure loop only `if (!isCover)`; this wrapper stands in
    // for that loop, so it must do the same. SLOPE's draw returns TRUE (it already
    // painted slope0 colored by direction and thHi/thLo dashed), so stroking the
    // figures again would flatten its colors and turn the thresholds into solid
    // full-width horizontals.
    const figures = [
      { key: "a", title: "A: ", type: "line" },
      { key: "b", title: "B: ", type: "line" },
    ];
    const strokesWhenCovering = (covered: boolean) => {
      const p = drawParams();
      p.indicator.result = [{ a: 1, b: 2 }, { a: 2, b: 3 }] as never;
      drawInset("SLOPE", { figures, draw: () => covered } as never)(p as never);
      return strokeCount(p);
    };
    // 1 chrome lid + one stroke per line figure when the base did NOT cover.
    expect(strokesWhenCovering(false)).toBe(3);
    // Chrome only: the base said it painted its own lines.
    expect(strokesWhenCovering(true)).toBe(1);
  });

  it("paints nothing on a zero-height pane", () => {
    const p = drawParams({ bounding: { width: 500, height: 0, left: 0, right: 500, top: 0, bottom: 0 } });
    expect(drawInset("RSI")(p as never)).toBe(true);
    expect(p.ctx.calls).not.toContain("stroke");
  });

  it("paints the band at the height this chart was dragged to", () => {
    const p = drawParams();
    setInsetBandFraction(p.chart, 0.5);
    drawInset("RSI")(p as never);
    // 400px pane at half height -> a 200px band at top 200, not the default 112@288.
    expect(p.ctx.calls).toContain("translate:0,200");
    expect(p.ctx.calls).toContain("rect:0,0,500,200");
  });
});

describe("insetTemplate", () => {
  it("empties the figure list so the price axis never sees the values", () => {
    expect(insetTemplate("RSI")!.figures).toEqual([]);
  });

  it("drops regenerateFigures, which would refill figures on a calcParams edit", () => {
    // SLOPE has one; leaving it would silently undo the empty figure list.
    expect(insetTemplate("SLOPE")!.regenerateFigures).toBeNull();
  });

  it("reports a high precision so the pane's MIN keeps the price precision", () => {
    expect(insetTemplate("RSI")!.precision).toBe(8);
  });

  it("keeps the base calc and swaps in the inset draw", () => {
    const t = insetTemplate("RSI")!;
    expect(typeof t.calc).toBe("function");
    // NOT `typeof t.draw === "function"`: RSI_TEMPLATE already carries a draw (its
    // divergence marking), so that would pass whether or not the swap happened. The
    // swap is the whole point — the base draw paints in its own pane's coordinates.
    expect(typeof t.draw).toBe("function");
    expect(t.draw).not.toBe(BASE_TEMPLATES.RSI.draw);
  });

  it("neutralises minValue/maxValue, which clamp the pane range independently of figures", () => {
    // Latent today (no base sets them), load-bearing the day one does: an inherited
    // min/max would clamp the PRICE axis, the exact bug `figures: []` guards against.
    const t = insetTemplate("RSI")!;
    expect(t.minValue).toBeNull();
    expect(t.maxValue).toBeNull();
  });

  it("returns null for a type we do not own", () => {
    expect(insetTemplate("MACD")).toBeNull();
  });
});

describe("band height", () => {
  it("clamps a drag to the min and max fractions", () => {
    expect(clampBandFraction(0.5)).toBe(0.5);
    expect(clampBandFraction(0)).toBe(0.08);
    expect(clampBandFraction(5)).toBe(INSET_BAND_MAX_FRACTION);
  });

  it("falls back to the default rather than storing a NaN fraction", () => {
    // A drag whose pane height was 0 would otherwise divide its way to NaN, and a NaN
    // fraction makes the band vanish with no way to drag it back.
    expect(clampBandFraction(NaN)).toBe(INSET_BAND_FRACTION);
    expect(bandFractionFromDrag(0, 100, -50)).toBe(INSET_BAND_FRACTION);
  });

  it("grows the band when its top edge is dragged UP", () => {
    // The band is anchored to the pane's bottom, so the drag delta is subtracted:
    // 40px up from a 100px band in a 400px pane -> 140/400.
    expect(bandFractionFromDrag(400, 100, -40)).toBeCloseTo(0.35);
    expect(bandFractionFromDrag(400, 100, 40)).toBeCloseTo(0.15);
  });

  it("keeps each chart's height to itself, so one cell's drag leaves the others", () => {
    const a = {} as Chart;
    const b = {} as Chart;
    setInsetBandFraction(a, 0.5);
    expect(insetBandFraction(a)).toBe(0.5);
    expect(insetBandFraction(b)).toBe(INSET_BAND_FRACTION);
    expect(insetBandFraction(null)).toBe(INSET_BAND_FRACTION);
  });
});

describe("insetBandBox", () => {
  const chartWith = (inds: unknown[], size: unknown = { left: 12, top: 30, width: 500, height: 400 }) =>
    ({ getIndicators: () => inds, getSize: () => size }) as unknown as Chart;

  it("places the band in chart-root pixels, under the pane's own top", () => {
    const chart = chartWith([insetInd()]);
    // 400px pane -> a 112px band at pane-local 288, and the pane's main area starts
    // at root y=30, so the DOM layers sit at 318.
    expect(insetBandBox(chart)).toEqual({ top: 318, left: 12, width: 500, height: 112 });
  });

  it("is null when nothing on the pane is inset", () => {
    expect(insetBandBox(chartWith([insetInd({ extendData: { indType: "RSI" } })]))).toBeNull();
  });

  it("keeps the box for a HIDDEN inset instance, whose row is its only way back", () => {
    // The band paints nothing while its only occupant is hidden, but the card has to
    // stay: its eye icon is the only control that can show the indicator again.
    expect(insetBandBox(chartWith([insetInd({ visible: false })]))).not.toBeNull();
  });

  it("is null when the chart cannot report its geometry yet", () => {
    expect(insetBandBox(chartWith([insetInd()], null))).toBeNull();
  });
});
