import { describe, it, expect } from "vitest";
import { stageLabel } from "./progressLabels";

describe("stageLabel", () => {
  it("maps the four stall-window keys", () => {
    expect(stageLabel("downloading")).toBe("Downloading candles");
    expect(stageLabel("submitting")).toBe("Submitting");
    expect(stageLabel("uploading")).toBe("Uploading to compute host");
    expect(stageLabel("engine")).toBe("Running backtest");
  });
  it("returns empty for null/undefined/unknown", () => {
    expect(stageLabel(null)).toBe("");
    expect(stageLabel(undefined)).toBe("");
    expect(stageLabel("nope")).toBe("");
  });
});
