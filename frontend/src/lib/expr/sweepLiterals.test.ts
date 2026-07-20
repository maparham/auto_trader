import { describe, it, expect } from "vitest";
import { sweepLiteralTarget, literalLabel, reanchorRanges } from "./sweepLiterals";

describe("sweep literals", () => {
  it("builds a lit: target path", () => {
    expect(sweepLiteralTarget("long", "entry", 0, 2)).toBe("lit:long.entry.0.2");
  });
  it("labels a literal by its AST context", () => {
    expect(literalLabel("EMA(50) > 30", 0)).toBe("EMA length");
    expect(literalLabel("EMA(50) > 30", 1)).toBe("threshold");
    expect(literalLabel("candle.high + 3 * ATR(14) > 0", 0)).toBe("multiplier of ATR(14)");
  });
  it("drops ranges on ordinals that vanished after an edit", () => {
    const prev = [{ ordinal: 0 }, { ordinal: 1 }] as any;
    const next = [{ ordinal: 0 }] as any;
    const ranges = { "lit:long.entry.0.0": {}, "lit:long.entry.0.1": {} };
    const { kept, dropped } = reanchorRanges(prev, next, ranges, "long", "entry", 0);
    expect(Object.keys(kept)).toEqual(["lit:long.entry.0.0"]);
    expect(dropped).toEqual(["lit:long.entry.0.1"]);
  });
  it("preserves ranges from other rows when editing one row", () => {
    const prev = [{ ordinal: 0 }, { ordinal: 1 }] as any;
    const next = [{ ordinal: 0 }] as any;
    const ranges = {
      "lit:long.entry.0.0": {},
      "lit:long.entry.0.1": {},
      "lit:short.exit.2.1": {},
    };
    const { kept, dropped } = reanchorRanges(prev, next, ranges, "long", "entry", 0);
    expect(Object.keys(kept)).toEqual([
      "lit:long.entry.0.0",
      "lit:short.exit.2.1",
    ]);
    expect(dropped).toEqual(["lit:long.entry.0.1"]);
  });
});
