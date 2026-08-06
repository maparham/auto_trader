import { describe, it, expect } from "vitest";
import { completionsFor } from "./complete";

describe("completionsFor", () => {
  it("suggests candle fields after 'candle.'", () => {
    const opts = completionsFor("candle.", 7).map((o) => o.label);
    expect(opts).toContain("close");
    expect(opts).toContain("wickTop");
    expect(opts).not.toContain("EMA");
  });
  it("suggests timeframes after '@'", () => {
    const opts = completionsFor("EMA(9)@", 7).map((o) => o.label);
    expect(opts).toContain("4H");
    expect(opts).toContain("D");
  });
  it("ranks indicators by prefix on a bare word", () => {
    const opts = completionsFor("EM", 2).map((o) => o.label);
    expect(opts[0]).toBe("EMA");
  });
  it("offers conditions on a bare prefix", () => {
    const labels = completionsFor("cou", 3).map((o) => o.label);
    expect(labels).toContain("count");
  });
  it("offers barsSinceEntry", () => {
    const labels = completionsFor("bars", 4).map((o) => o.label);
    expect(labels).toContain("barsSinceEntry");
  });
});

describe("infix cross completions", () => {
  it("offers x> and x< on the x prefix, ranked first", () => {
    const opts = completionsFor("EMA(9) x", 8);
    const labels = opts.map((o) => o.label);
    // prefix rank 3 beats everything; localeCompare tie-break puts x< first
    expect(labels[0]).toBe("x<");
    expect(labels[1]).toBe("x>");
  });

  it("keeps the infix operators in the bare-word candidate set", () => {
    const labels = completionsFor("", 0).map((o) => o.label);
    expect(labels).toContain("x>");
    expect(labels).toContain("crossAbove");
  });
});
