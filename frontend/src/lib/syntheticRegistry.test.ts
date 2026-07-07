import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const {
  registerSynthetic,
  getSynthetic,
  isSynthetic,
  setSyntheticPrecision,
} = await import("./syntheticRegistry");

beforeEach(() => localStorage.clear());

describe("syntheticRegistry", () => {
  it("registers and reads back an entry", () => {
    const e = registerSynthetic("OIL_CRUDE/DXY", "capital");
    expect(e.id).toMatch(/^SYN_/);
    expect(e.symbols).toEqual(["OIL_CRUDE", "DXY"]);
    expect(getSynthetic(e.id)?.expression).toBe("OIL_CRUDE/DXY");
  });
  it("is idempotent on the same canonical form", () => {
    const a = registerSynthetic("OIL_CRUDE/DXY", "capital");
    const b = registerSynthetic(" oil_crude / dxy ", "capital");
    expect(a.id).toBe(b.id);
  });
  it("isSynthetic only true for registered ids", () => {
    const e = registerSynthetic("A/B", "capital");
    expect(isSynthetic(e.id)).toBe(true);
    expect(isSynthetic("OIL_CRUDE")).toBe(false);
    expect(isSynthetic("SYN_deadbeef")).toBe(false); // not registered
  });
  it("persists precision", () => {
    const e = registerSynthetic("A/B", "capital");
    setSyntheticPrecision(e.id, 4);
    expect(getSynthetic(e.id)?.precision).toBe(4);
  });
});
