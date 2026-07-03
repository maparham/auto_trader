import { describe, it, expect } from "vitest";
import { canonicalize, isSyntheticExpr, parseLegs, syntheticId } from "./syntheticExpr";

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
