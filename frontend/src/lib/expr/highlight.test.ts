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
    expect(classes("SLOPE#a1b2c3.accel9 > 0.5")).toEqual([
      ["SLOPE#a1b2c3", "instanceRef"],
      ["accel9", "field"],
      [">", "operator"],
      ["0.5", "number"],
    ]);
    // A bare unknown name with no field is still just a variable.
    expect(classes("nope > 1")[0]).toEqual(["nope", "variable"]);
  });

  // A pane's outputs are named by its MA lengths, so the token after the dot
  // LEXES as a number but IS a field name — painting it as a numeric literal
  // would misread the ref. The trailing 0.5 proves a real literal still paints
  // as a number in the same expression.
  it("paints a length-named output as a field, not as a number", () => {
    expect(classes("SLOPE.9 > 0.5")).toEqual([
      ["SLOPE", "instanceRef"],
      ["9", "field"],
      [">", "operator"],
      ["0.5", "number"],
    ]);
  });

  it("does not treat a registered name followed by a dot as a ref", () => {
    expect(classes("EMA.foo > 1")[0]).toEqual(["EMA", "indicator"]);
    expect(classes("slope.foo > 1")[0]).toEqual(["slope", "wrapper"]);
    expect(classes("candle.close > 1")[0]).toEqual(["candle", "variable"]);
  });

  // The boolean keywords lex as their own token types (AND/OR/NOT), so they
  // never reach the NAME branch — they need their own class or they go
  // undecorated. The lowercase and the all-uppercase spellings both specialize;
  // a mixed-case `And` stays a name.
  it("classifies the boolean keywords", () => {
    expect(classifyTokens("a > 1 and b > 2")).toContainEqual({
      from: 6, to: 9, cls: "logic",
    });
    expect(classes("a > 1 and b > 2")).toEqual([
      ["a", "variable"],
      [">", "operator"],
      ["1", "number"],
      ["and", "logic"],
      ["b", "variable"],
      [">", "operator"],
      ["2", "number"],
    ]);
    expect(classes("a > 1 or not b > 2")).toEqual([
      ["a", "variable"],
      [">", "operator"],
      ["1", "number"],
      ["or", "logic"],
      ["not", "logic"],
      ["b", "variable"],
      [">", "operator"],
      ["2", "number"],
    ]);
    // The all-uppercase spelling is the same keyword token, so it colors the
    // same; only a MIXED-case word is an ordinary (unknown) name.
    expect(classes("a > 1 AND b > 2")[3]).toEqual(["AND", "logic"]);
    expect(classes("a > 1 And b > 2")[3]).toEqual(["And", "variable"]);
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

  it("highlights == as an operator", () => {
    expect(classes("count(candle.close > candle.open, 5) == 3")).toContainEqual(
      ["==", "operator"]
    );
  });
});
