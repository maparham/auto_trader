import { describe, it, expect } from "vitest";
import { classifyTokens } from "./highlight";

/** `[text, class]` pairs for every classified token in `doc`. */
function classes(doc: string): Array<[string, string]> {
  return classifyTokens(doc).map((t) => [doc.slice(t.from, t.to), t.cls]);
}

describe("classifyTokens", () => {
  it("classifies the catalog names", () => {
    expect(classes("EMA(9) > 1")).toEqual([
      ["EMA", "indicator"],
      ["9", "number"],
      [">", "operator"],
      ["1", "number"],
    ]);
  });

  it("classifies a wrapper, a candle field and a timeframe pin", () => {
    expect(classes("slope(candle.close, 3)@4H > 0")).toEqual([
      ["slope", "wrapper"],
      ["candle", "variable"],
      ["close", "field"],
      ["3", "number"],
      ["4H", "timeframe"],
      [">", "operator"],
      ["0", "number"],
    ]);
  });

  it("marks a chart-instance reference distinctly from an unknown name", () => {
    expect(classes("SLOPE#a1b2c3.slope0 > 0.5")).toEqual([
      ["SLOPE#a1b2c3", "instanceRef"],
      ["slope0", "field"],
      [">", "operator"],
      ["0.5", "number"],
    ]);
    // A bare unknown name with no field is still just a variable.
    expect(classes("nope > 1")[0]).toEqual(["nope", "variable"]);
  });

  it("does not treat a registered name followed by a dot as a ref", () => {
    expect(classes("EMA.foo > 1")[0]).toEqual(["EMA", "indicator"]);
    expect(classes("slope.foo > 1")[0]).toEqual(["slope", "wrapper"]);
    expect(classes("candle.close > 1")[0]).toEqual(["candle", "variable"]);
  });

  // Regression: INDICATOR_SPECS / WRAPPER_ARITY are plain object literals, so a
  // bare `in` also finds inherited Object.prototype members. `toString` and
  // `constructor` are ordinary unknown names and must classify as variables.
  it("does not mis-classify names inherited from Object.prototype", () => {
    expect(classes("toString > 1")[0]).toEqual(["toString", "variable"]);
    expect(classes("constructor > 1")[0]).toEqual(["constructor", "variable"]);
    expect(classes("valueOf > 1")[0]).toEqual(["valueOf", "variable"]);
    // ...and one with a field is a plain instance ref, not an indicator.
    expect(classes("toString.x > 1")[0]).toEqual(["toString", "instanceRef"]);
  });
});
