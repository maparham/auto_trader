import { describe, expect, it } from "vitest";
import { defaultCondition, defaultTriggerLevel, moveDraftSignal, setMoveLevel } from "./moveRuleDraft";

describe("defaultCondition", () => {
  it("picks the direction that tightens", () => {
    expect(defaultCondition("sl", "buy")).toBe("crossing_up");
    expect(defaultCondition("tp", "buy")).toBe("crossing_down");
    expect(defaultCondition("sl", "sell")).toBe("crossing_down");
    expect(defaultCondition("tp", "sell")).toBe("crossing_up");
  });
});

describe("defaultTriggerLevel", () => {
  it("SL is 1R in favor", () => {
    expect(defaultTriggerLevel("sl", "buy", 1.0, 0.95, null)).toBeCloseTo(1.05);
    expect(defaultTriggerLevel("sl", "sell", 1.0, 1.05, null)).toBeCloseTo(0.95);
  });
  it("TP is halfway to the SL, against the trade", () => {
    expect(defaultTriggerLevel("tp", "sell", 1.0, 1.05, null)).toBeCloseTo(1.025);
    expect(defaultTriggerLevel("tp", "buy", 1.0, 0.95, null)).toBeCloseTo(0.975);
  });
  it("falls back to 0.5% without an SL", () => {
    expect(defaultTriggerLevel("sl", "buy", 100, null, null)).toBeCloseTo(100.5);
    expect(defaultTriggerLevel("sl", "sell", 100, null, null)).toBeCloseTo(99.5);
    expect(defaultTriggerLevel("tp", "buy", 100, null, null)).toBeCloseTo(99.5);
    expect(defaultTriggerLevel("tp", "sell", 100, null, null)).toBeCloseTo(100.5);
  });
});

describe("setMoveLevel", () => {
  it("writes the trigger or a price target", () => {
    const d = { on: true, level: 1, condition: "crossing_up" as const, target: { type: "breakeven" as const, offset: 0 } };
    moveDraftSignal.set({ epic: "X", dealId: null, side: "buy", sl: d, tp: null });
    setMoveLevel("sl", "trigger", 2);
    setMoveLevel("sl", "target", 3);
    expect(moveDraftSignal.value?.sl).toMatchObject({ level: 2, target: { type: "price", value: 3 } });
    moveDraftSignal.set(null);
  });
});
