// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { describeIndicator, configureParams, describeRules, validateRule } from "./describe";
import { TRENDLINES_DEFAULTS, TRENDLINES_DIRECTIONS } from "../lib/indicators/trendlinesOutputs";
import { presetsFor } from "../lib/indicatorMeta";

const TL_KEYS = Object.keys(TRENDLINES_DEFAULTS);

describe("describeIndicator", () => {
  it("lists every Trendlines slot with a name, label and default", () => {
    const d = describeIndicator("TRENDLINES");
    const slots = d.inputs.filter((i) => i.source === "calcParam");
    expect(new Set(slots.map((i) => i.index))).toEqual(new Set(TL_KEYS.map((_, i) => i)));
    const pivot = slots.find((i) => i.name === "pivotLen")!;
    expect(pivot.label).toBeTruthy();
    expect(pivot.default).toBe(presetsFor("TRENDLINES")!.base[TL_KEYS.indexOf("pivotLen")]);
    expect(d.startsOn).toBe("Balanced");
    expect(d.presets.map((p) => p.name)).toContain("Balanced");
    expect(d.directions.map((p) => p.name)).toEqual(["All", "Rising", "Falling"]);
  });

  it("refuses an unknown type", () => {
    expect(() => describeIndicator("NOPE")).toThrow(/unknown indicator type/);
  });
});

describe("configureParams", () => {
  const base = presetsFor("TRENDLINES")!.base;

  it("Rising changes only the slope slots", () => {
    const { calcParams, changed } = configureParams("TRENDLINES", base, { direction: "Rising" });
    const rising = TRENDLINES_DIRECTIONS.find((d) => d.name === "Rising")!;
    expect(calcParams[TL_KEYS.indexOf("minSlopeAtr")]).toBe(rising.minSlopeAtr);
    expect(calcParams[TL_KEYS.indexOf("maxSlopeAtr")]).toBe(rising.maxSlopeAtr);
    calcParams.forEach((v, i) => {
      if (i !== TL_KEYS.indexOf("minSlopeAtr") && i !== TL_KEYS.indexOf("maxSlopeAtr")) expect(v).toBe(base[i]);
    });
    expect(changed.length).toBeGreaterThan(0);
  });

  it("accepts a param by name or by key", () => {
    const byName = configureParams("TRENDLINES", base, { params: { pivotLen: 8 } });
    expect(byName.calcParams[TL_KEYS.indexOf("pivotLen")]).toBe(8);
    const byKey = configureParams("TRENDLINES", base, { params: { [`p${TL_KEYS.indexOf("pivotLen")}`]: 9 } });
    expect(byKey.calcParams[TL_KEYS.indexOf("pivotLen")]).toBe(9);
  });

  it("names the valid keys when a key is unknown", () => {
    expect(() => configureParams("TRENDLINES", base, { params: { length: 8 } })).toThrow(/pivotLen/);
  });

  it("names the valid presets and directions", () => {
    expect(() => configureParams("TRENDLINES", base, { preset: "Lots" })).toThrow(/Balanced/);
    expect(() => configureParams("TRENDLINES", base, { direction: "Up" })).toThrow(/Rising/);
  });

  it("rejects a value outside the input's range", () => {
    expect(() => configureParams("TRENDLINES", base, { params: { maxLines: 999 } })).toThrow(/maxLines/);
  });

  it("works for a simple type", () => {
    expect(configureParams("RSI", [14], { params: { p0: 21 } }).calcParams[0]).toBe(21);
  });
});

describe("rules", () => {
  it("describes the catalog and the chart's panes", () => {
    const r = describeRules([{ id: "RSI", type: "RSI", calcParams: [14] }]);
    expect(r).toHaveProperty("indicators");
    expect(r).toHaveProperty("candleFields");
    expect((r.instances as Array<{ id: string; type: string }>)[0]).toMatchObject({ id: "RSI", type: "RSI" });
  });

  it("validates expressions", () => {
    expect(validateRule("EMA(9) x> EMA(21)", false, [], 3600)).toMatchObject({ ok: true });
    const bad = validateRule("EMA(9) x>", false, [], 3600);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toBeTruthy();
  });

  // M5: a picked-line id (bare L<n>) is checked against the held `lines` set,
  // matching the backtest panel's own analyze(expr, {lines}) call.
  it("checks picked-line refs against the lines set when given one", () => {
    expect(validateRule("candle.close x> L1", false, [], 3600, new Set(["L1"]))).toMatchObject({ ok: true });
    const bad = validateRule("candle.close x> L2", false, [], 3600, new Set(["L1"]));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/L2 is not one of this rule's lines/);
    // Omitting `lines` entirely (no holder) leaves line refs unchecked.
    expect(validateRule("candle.close x> L2", false, [], 3600)).toMatchObject({ ok: true });
  });
});
