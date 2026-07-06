import { describe, it, expect } from "vitest";
import { detectBarClose, deriveOrderId } from "./liveHelpers";

describe("detectBarClose", () => {
  it("first tick never counts as a close", () => {
    expect(detectBarClose(null, { timestamp: 1000 }).closed).toBe(false);
  });
  it("same timestamp is the in-progress bar", () => {
    expect(detectBarClose(1000, { timestamp: 1000 }).closed).toBe(false);
  });
  it("advancing timestamp means the prior bar closed", () => {
    expect(detectBarClose(1000, { timestamp: 1060 }).closed).toBe(true);
  });
  it("older timestamp is stale, ignored", () => {
    expect(detectBarClose(1000, { timestamp: 940 }).closed).toBe(false);
  });
});

describe("deriveOrderId", () => {
  it("is deterministic for the same bar+leg+side", () => {
    expect(deriveOrderId("s1", 1700, "long", "buy")).toBe("s1:1700:long:buy");
    expect(deriveOrderId("s1", 1700, "long", "buy")).toBe(deriveOrderId("s1", 1700, "long", "buy"));
  });
  it("differs across bars", () => {
    expect(deriveOrderId("s1", 1700, "long", "buy")).not.toBe(deriveOrderId("s1", 1760, "long", "buy"));
  });
});
