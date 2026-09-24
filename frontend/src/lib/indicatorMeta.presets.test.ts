import { describe, expect, it } from "vitest";
import { padTrendlinesParams, presetsFor, presetStepOf, withPresetStep, resolveInputs } from "./indicatorMeta";

const tl = presetsFor("TRENDLINES")!;

describe("trendlines Lines steps", () => {
  it("has one step that IS the defaults, so an untouched pane sits on it", () => {
    const i = presetStepOf(tl, tl.base);
    expect(i).not.toBeNull();
    expect(tl.steps[i!].name).toBe("Default");
  });

  it("keeps more lines at every step to the right", () => {
    const maxLines = tl.steps.map((s) => s.values[tl.slots.indexOf(5)]);
    for (let i = 1; i < maxLines.length; i++) expect(maxLines[i]).toBeGreaterThan(maxLines[i - 1]);
  });

  it("round-trips every step and touches only the swept slots", () => {
    tl.steps.forEach((_, i) => {
      const cp = withPresetStep(tl, tl.base, i);
      expect(presetStepOf(tl, cp)).toBe(i);
      cp.forEach((v, slot) => {
        if (!tl.slots.includes(slot)) expect(v).toBe(tl.base[slot]);
      });
    });
  });

  it("fills a slot the saved list predates from the defaults", () => {
    const short = tl.base.slice(0, 10);
    expect(presetStepOf(tl, short)).toBe(presetStepOf(tl, tl.base));
    expect(withPresetStep(tl, short, 0)).toHaveLength(tl.base.length);
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
