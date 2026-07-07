import { describe, it, expect } from "vitest";
import {
  activeSymbolFragment,
  canonicalize,
  insertSymbol,
  isSyntheticExpr,
  parseSymbols,
  syntheticId,
} from "./syntheticExpr";

describe("isSyntheticExpr", () => {
  it("plain epics are not synthetic", () => {
    for (const e of ["OIL_CRUDE", "US500", "EURUSD", "CS.D.EURUSD.CFD.IP"])
      expect(isSyntheticExpr(e)).toBe(false);
  });
  it("operators mark an expression", () => {
    for (const e of ["OIL_CRUDE/DXY", "(AAPL+MSFT)/2", "A*B", "A - B"])
      expect(isSyntheticExpr(e)).toBe(true);
  });
});

describe("parseSymbols", () => {
  it("returns distinct symbols in order, upper-cased", () => {
    expect(parseSymbols("(aapl + msft) / aapl")).toEqual(["AAPL", "MSFT"]);
  });
  it("ignores numeric constants", () => {
    expect(parseSymbols("OIL_CRUDE / DXY * 100")).toEqual(["OIL_CRUDE", "DXY"]);
  });
  it("throws on unbalanced parens", () => {
    expect(() => parseSymbols("(A / B")).toThrow();
  });
});

describe("canonicalize + syntheticId", () => {
  it("canonicalizes whitespace and case", () => {
    expect(canonicalize(" oil_crude/dxy ")).toBe("OIL_CRUDE / DXY");
  });
  it("same expression -> same id, different -> different", () => {
    expect(syntheticId("OIL_CRUDE/DXY")).toBe(syntheticId(" oil_crude / dxy "));
    expect(syntheticId("A/B")).not.toBe(syntheticId("B/A"));
  });
  it("id has the SYN_ prefix", () => {
    expect(syntheticId("A/B")).toMatch(/^SYN_[0-9a-z]+$/);
  });
});

describe("activeSymbolFragment", () => {
  it("returns text after the last operator, trimmed", () => {
    expect(activeSymbolFragment("OIL_CRUDE / dx")).toBe("dx");
    expect(activeSymbolFragment("OIL_CRUDE /")).toBe("");
    expect(activeSymbolFragment("oil")).toBe("oil");
    expect(activeSymbolFragment("(AAPL+ms")).toBe("ms");
    expect(activeSymbolFragment("")).toBe("");
  });
  it("treats a SPACED minus as an operator but a bare dash as part of the token", () => {
    expect(activeSymbolFragment("A - dx")).toBe("dx"); // subtraction
    expect(activeSymbolFragment("A-B")).toBe("A-B"); // bare dash: one token, not split
    expect(activeSymbolFragment("A-")).toBe("A-");
  });
});

describe("insertSymbol", () => {
  it("empty box -> the epic", () => {
    expect(insertSymbol("", "DXY")).toBe("DXY");
  });
  it("no operator -> replaces the whole fragment with the epic", () => {
    expect(insertSymbol("oil", "OIL_CRUDE")).toBe("OIL_CRUDE");
  });
  it("ends in an operator -> appends with one space", () => {
    expect(insertSymbol("OIL_CRUDE /", "DXY")).toBe("OIL_CRUDE / DXY");
    expect(insertSymbol("OIL_CRUDE / ", "DXY")).toBe("OIL_CRUDE / DXY");
  });
  it("ends in a symbol fragment -> replaces the fragment", () => {
    expect(insertSymbol("OIL_CRUDE / dx", "DXY")).toBe("OIL_CRUDE / DXY");
  });
  it("a spaced minus is an operator; a bare dash is not (no stranded box)", () => {
    // Spaced minus: append after the operator.
    expect(insertSymbol("A -", "DXY")).toBe("A - DXY");
    expect(insertSymbol("A - dx", "DXY")).toBe("A - DXY");
    // Bare dash (typed): the box is one token — replace it, never produce "A- DXY".
    expect(insertSymbol("A-", "DXY")).toBe("DXY");
    expect(insertSymbol("A-B", "DXY")).toBe("DXY");
  });
  it("leading / consecutive operators stay recoverable (not stranded)", () => {
    expect(insertSymbol("/", "DXY")).toBe("/ DXY");
    expect(insertSymbol("A / /", "DXY")).toBe("A / / DXY");
    expect(insertSymbol("(", "AAPL")).toBe("( AAPL");
  });
});
