import { describe, it, expect } from "vitest";
import { decideMobileBoot } from "./mobileBoot";

describe("decideMobileBoot", () => {
  it("?m=1 forces mobile and persists", () => {
    expect(decideMobileBoot("?m=1", null, false)).toEqual({ mobile: true, persist: "1" });
  });
  it("?m=0 forces desktop and persists, beating a stored choice", () => {
    expect(decideMobileBoot("?m=0", "1", true)).toEqual({ mobile: false, persist: "0" });
  });
  it("stored opt-out wins over media", () => {
    expect(decideMobileBoot("?foo=bar", "0", true)).toEqual({ mobile: false, persist: null });
  });
  it("stored \"1\" does not force mobile on a fine-pointer desktop tab", () => {
    // One ?m=1 visit on desktop (QR link, emulator) stores "1"; a later
    // normal tab must still boot desktop.
    expect(decideMobileBoot("", "1", false)).toEqual({ mobile: false, persist: null });
    expect(decideMobileBoot("", "1", true)).toEqual({ mobile: true, persist: null });
  });
  it("falls back to the media query", () => {
    expect(decideMobileBoot("", null, true)).toEqual({ mobile: true, persist: null });
    expect(decideMobileBoot("", null, false)).toEqual({ mobile: false, persist: null });
  });
  it("ignores junk m values", () => {
    expect(decideMobileBoot("?m=2", null, false)).toEqual({ mobile: false, persist: null });
  });
});
