import { describe, expect, it } from "vitest";
import { adaptiveStep } from "./adaptiveStep";

describe("adaptiveStep", () => {
  it("is half the decade of the value on a fractional field", () => {
    expect(adaptiveStep(0.03, 0.1)).toBe(0.005);
    expect(adaptiveStep(0.5, 0.1)).toBe(0.05);
    expect(adaptiveStep(0.1, 0.1)).toBe(0.05);
    expect(adaptiveStep(3, 0.1)).toBe(0.5);
    expect(adaptiveStep(-0.25, 0.1)).toBe(0.05);
  });
  it("leaves a whole-number field on its own step", () => {
    expect(adaptiveStep(3, 1)).toBe(1);
    expect(adaptiveStep(0.5, 1)).toBe(1);
    expect(adaptiveStep(20, 5)).toBe(5);
  });
  it("falls back to the base step on empty, zero or junk", () => {
    expect(adaptiveStep("", 0.1)).toBe(0.1);
    expect(adaptiveStep(0, 0.1)).toBe(0.1);
    expect(adaptiveStep("-", 0.1)).toBe(0.1);
  });
});
