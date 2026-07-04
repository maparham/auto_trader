import { describe, it, expect } from "vitest";
import {
  activeLegFragment,
  canonicalize,
  insertLeg,
  isSyntheticExpr,
  parseLegs,
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

describe("parseLegs", () => {
  it("returns distinct legs in order, upper-cased", () => {
    expect(parseLegs("(aapl + msft) / aapl")).toEqual(["AAPL", "MSFT"]);
  });
  it("ignores numeric constants", () => {
    expect(parseLegs("OIL_CRUDE / DXY * 100")).toEqual(["OIL_CRUDE", "DXY"]);
  });
  it("throws on unbalanced parens", () => {
    expect(() => parseLegs("(A / B")).toThrow();
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

describe("activeLegFragment", () => {
  it("returns text after the last operator, trimmed", () => {
    expect(activeLegFragment("OIL_CRUDE / dx")).toBe("dx");
    expect(activeLegFragment("OIL_CRUDE /")).toBe("");
    expect(activeLegFragment("oil")).toBe("oil");
    expect(activeLegFragment("(AAPL+ms")).toBe("ms");
    expect(activeLegFragment("")).toBe("");
  });
  it("treats a SPACED minus as an operator but a bare dash as part of the token", () => {
    expect(activeLegFragment("A - dx")).toBe("dx"); // subtraction
    expect(activeLegFragment("A-B")).toBe("A-B"); // bare dash: one token, not split
    expect(activeLegFragment("A-")).toBe("A-");
  });
});

describe("insertLeg", () => {
  it("empty box -> the epic", () => {
    expect(insertLeg("", "DXY")).toBe("DXY");
  });
  it("no operator -> replaces the whole fragment with the epic", () => {
    expect(insertLeg("oil", "OIL_CRUDE")).toBe("OIL_CRUDE");
  });
  it("ends in an operator -> appends with one space", () => {
    expect(insertLeg("OIL_CRUDE /", "DXY")).toBe("OIL_CRUDE / DXY");
    expect(insertLeg("OIL_CRUDE / ", "DXY")).toBe("OIL_CRUDE / DXY");
  });
  it("ends in a leg fragment -> replaces the fragment", () => {
    expect(insertLeg("OIL_CRUDE / dx", "DXY")).toBe("OIL_CRUDE / DXY");
  });
  it("a spaced minus is an operator; a bare dash is not (no stranded box)", () => {
    // Spaced minus: append after the operator.
    expect(insertLeg("A -", "DXY")).toBe("A - DXY");
    expect(insertLeg("A - dx", "DXY")).toBe("A - DXY");
    // Bare dash (typed): the box is one token — replace it, never produce "A- DXY".
    expect(insertLeg("A-", "DXY")).toBe("DXY");
    expect(insertLeg("A-B", "DXY")).toBe("DXY");
  });
  it("leading / consecutive operators stay recoverable (not stranded)", () => {
    expect(insertLeg("/", "DXY")).toBe("/ DXY");
    expect(insertLeg("A / /", "DXY")).toBe("A / / DXY");
    expect(insertLeg("(", "AAPL")).toBe("( AAPL");
  });
});
