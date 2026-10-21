import { describe, expect, it } from "vitest";
import { padTrendlinesParams, presetsFor, presetStepOf, withPresetStep, resolveInputs } from "./indicatorMeta";
import { TRENDLINES_PRESET_CONFIGS, TRENDLINES_SEED } from "./indicators/trendlinesOutputs";

const tl = presetsFor("TRENDLINES")!;

describe("trendlines presets", () => {
  it("lists every recipe, the seed first", () => {
    expect(tl.steps.map((s) => s.name)).toEqual(TRENDLINES_PRESET_CONFIGS.map((p) => p.name));
    expect(presetStepOf(tl, Object.values(TRENDLINES_SEED))).toBe(0);
  });

  it("round-trips every preset over every slot", () => {
    tl.steps.forEach((_, i) => {
      const cp = withPresetStep(tl, tl.base, i);
      expect(cp).toEqual(Object.values(TRENDLINES_PRESET_CONFIGS[i].config));
      expect(presetStepOf(tl, cp)).toBe(i);
    });
  });

  it("matches none on the parse defaults, so an old pane reads Custom", () => {
    expect(presetStepOf(tl, tl.base)).toBeNull();
  });

  it("fills a slot the saved list predates from the defaults", () => {
    expect(withPresetStep(tl, tl.base.slice(0, 10), 0)).toHaveLength(tl.base.length);
  });
});

describe("Extend Left input", () => {
  it("TRENDLINES has an Extend Left toggle on slot 28", () => {
    const inp = resolveInputs("TRENDLINES", undefined).find((x) => x.index === 28);
    expect(inp).toMatchObject({ label: "Extend Left", type: "boolean", source: "calcParam", default: false });
    expect(inp?.tip).toEqual([
      "Starts each line at the nearest earlier swing it touched.",
      "The line keeps its angle; that swing counts as a touch.",
      "Breaks on the way count as crossings.",
      "Drops back to the shorter line if the longer one fails a filter.",
    ]);
  });
});

describe("padTrendlinesParams", () => {
  it("fills the gap between a short saved array and a higher slot from the defaults", () => {
    const twentyFour = Array.from({ length: 24 }, (_, i) => i);
    const padded = padTrendlinesParams(twentyFour, 28);
    expect(padded[24]).toBe(12); // majorPivots (MAJOR_PIVOTS)
    expect(padded[26]).toBe(3); // majorSizeAtr
    expect(padded[27]).toBe(0); // lookbackBars
    // The given slots are untouched.
    for (let i = 0; i < 24; i++) expect(padded[i]).toBe(i);
  });

  it("writes down the legacy migrations a missing slot runs with", () => {
    // A pane saved before slots 19 to 22 existed, with the old extendData
    // choices: Only lines near price, a render-only merge of 1 ATR, One line
    // per pivot. Padding to reach slot 28 must keep all three.
    const old = Array.from({ length: 19 }, () => 1);
    const ext = { declutter: "near", dedupeAtr: 1 };
    const padded = padTrendlinesParams(old, 28, ext);
    expect(padded[19]).toBe(5); // TL_NEAR_PRICE_ATR
    expect(padded[21]).toBe(1);
    expect(padTrendlinesParams(old, 28, { declutter: "pivot" })[22]).toBe(1);
  });
});
