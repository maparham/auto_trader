import { describe, it, expect } from "vitest";
import { fmtRunDuration, remainingEta } from "./duration";

describe("fmtRunDuration", () => {
  it("keeps a decimal under 10s", () => {
    expect(fmtRunDuration(4_320)).toBe("4.3s");
  });
  it("rounds whole seconds under a minute", () => {
    expect(fmtRunDuration(42_600)).toBe("43s");
  });
  it("formats minutes and seconds", () => {
    expect(fmtRunDuration(160_000)).toBe("2m 40s");
  });
  it("formats hours and minutes", () => {
    expect(fmtRunDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("remainingEta", () => {
  it("counts down from the last sync", () => {
    // eta 160s received at t=1000ms; 2.5s later 157.5s remain
    expect(remainingEta(160, 1_000, 3_500)).toBeCloseTo(157.5);
  });
  it("is the full eta at the sync instant", () => {
    expect(remainingEta(160, 1_000, 1_000)).toBe(160);
  });
  it("clamps at zero once the estimate is overrun", () => {
    expect(remainingEta(5, 0, 60_000)).toBe(0);
  });
});
