import { describe, expect, it } from "vitest";
import { presetsFor, presetStepOf, withPresetStep } from "./indicatorMeta";

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
