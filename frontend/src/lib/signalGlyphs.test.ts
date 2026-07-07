import { describe, it, expect } from "vitest";
import { buildSignalGlyphs, termLabel, signalHeader } from "./signalGlyphs";
import type { Marker } from "../api";

const mk = (over: Partial<Marker>): Marker => ({
  time: 100,
  side: "buy",
  price: 10,
  reason: "",
  leg: "long",
  ...over,
});

describe("buildSignalGlyphs", () => {
  it("emits a glyph only for markers with a non-empty terms list", () => {
    const withTerms = mk({
      signal_time: 90,
      combine: "OR",
      terms: [{ left: "EMA(56)", lval: 1, op: "gt", right: "open", rval: 0, leftTf: "MINUTE_15", rightTf: null }],
    });
    const mechanical = mk({ reason: "range end", signal_time: null, terms: [] });
    const legacy = mk({ time: 200 }); // no terms field at all (old persisted result)

    const glyphs = buildSignalGlyphs([withTerms, mechanical, legacy]);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].signalTime).toBe(90);
    expect(glyphs[0].combine).toBe("OR");
    expect(glyphs[0].terms).toHaveLength(1);
  });

  it("places the glyph below a long candle and above a short one", () => {
    const long = mk({ leg: "long", signal_time: 90, terms: [{ left: "close", lval: 1, op: "gt", right: "open", rval: 0, leftTf: null, rightTf: null }] });
    const short = mk({ leg: "short", side: "sell", signal_time: 90, terms: [{ left: "close", lval: 0, op: "lt", right: "open", rval: 1, leftTf: null, rightTf: null }] });
    expect(buildSignalGlyphs([long])[0].placement).toBe("below");
    expect(buildSignalGlyphs([short])[0].placement).toBe("above");
  });

  it("skips a terms marker with no signal_time (can't anchor it)", () => {
    const noTime = mk({ signal_time: null, terms: [{ left: "close", lval: 1, op: "gt", right: "open", rval: 0, leftTf: null, rightTf: null }] });
    expect(buildSignalGlyphs([noTime])).toHaveLength(0);
  });
});

describe("termLabel", () => {
  it("appends the prettified timeframe when the operand has one", () => {
    expect(termLabel("EMA(56)", "MINUTE_15")).toBe("EMA(56) @15m");
    expect(termLabel("EMA(9)", "HOUR")).toBe("EMA(9) @1H");
  });

  it("leaves a timeframe-less operand bare", () => {
    expect(termLabel("open", null)).toBe("open");
    expect(termLabel("entryPrice", null)).toBe("entryPrice");
  });

  it("falls back to the raw resolution when it isn't a known period", () => {
    expect(termLabel("EMA(5)", "WHAT_9")).toBe("EMA(5) @WHAT_9");
  });
});

describe("signalHeader", () => {
  it("labels a long buy as an entry and a long sell as an exit", () => {
    expect(signalHeader({ side: "buy", leg: "long", combine: "AND" }, "11 Mar 15:30")).toBe(
      "Long entry — signal 11 Mar 15:30 (AND)",
    );
    expect(signalHeader({ side: "sell", leg: "long", combine: "OR" }, "11 Mar 15:30")).toBe(
      "Long exit — signal 11 Mar 15:30 (OR)",
    );
  });

  it("labels a short sell as an entry and a short buy as an exit", () => {
    expect(signalHeader({ side: "sell", leg: "short", combine: "AND" }, "t")).toBe("Short entry — signal t (AND)");
    expect(signalHeader({ side: "buy", leg: "short", combine: "AND" }, "t")).toBe("Short exit — signal t (AND)");
  });
});
