// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pillsClearOfBells } from "./chartPainters";
import type { CurveLabelPill } from "../CurveLabels";

const pill = (over: Partial<CurveLabelPill> = {}): CurveLabelPill => ({
  key: "k", text: "EMA(50)", x: 100, y: 50, color: "#f5a623", side: "right", align: "center", maxX: 1000, ...over,
});

describe("pillsClearOfBells", () => {
  it("moves a right-side label past a bell at its curve end", () => {
    const [p] = pillsClearOfBells([pill()], [{ x: 120, y: 50 }]);
    expect(p.x + 5).toBe(120 + 7 + 2);
  });
  it("leaves a label alone when the bell is on another row", () => {
    const p = pill();
    expect(pillsClearOfBells([p], [{ x: 120, y: 90 }])[0]).toBe(p);
  });
  it("leaves left-side labels alone", () => {
    const p = pill({ side: "left" });
    expect(pillsClearOfBells([p], [{ x: 95, y: 50 }])[0]).toBe(p);
  });
});
