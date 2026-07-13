import { describe, it, expect } from "vitest";
import { tradeZones } from "./tradeZones";
import type { BacktestResult } from "../api";
type T = BacktestResult["trades"][number];
const base: T = { side: "sell", quantity: 1, entry_time: 0, entry_price: 100,
  exit_time: 60, exit_price: 96, pnl: 4, leg: "short", reason: "target",
  stop_initial: 102, stop_final: 102, target: 96,
  mae: 0, mfe: 0, mae_r: null, mfe_r: null, context: null };

describe("tradeZones", () => {
  it("computes risk %, reward %, R:R (magnitudes, side-agnostic)", () => {
    const z = tradeZones(base);
    expect(z.hasRisk).toBe(true); expect(z.hasReward).toBe(true);
    expect(z.riskPct).toBeCloseTo(2, 6);    // |100-102|/100
    expect(z.rewardPct).toBeCloseTo(4, 6);  // |100-96|/100
    expect(z.rr).toBeCloseTo(2, 6);
    expect(z.stopMoved).toBe(false);
  });
  it("no target -> no reward zone, rr null", () => {
    const z = tradeZones({ ...base, target: null });
    expect(z.hasReward).toBe(false); expect(z.rewardPct).toBeNull(); expect(z.rr).toBeNull();
  });
  it("stopMoved true when final != initial", () => {
    expect(tradeZones({ ...base, stop_final: 100 }).stopMoved).toBe(true);
  });
});
