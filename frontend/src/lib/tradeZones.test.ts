import { describe, it, expect } from "vitest";
import { tradeZones, zoneLabels } from "./tradeZones";
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

// A strategy with no hard stop/target still risks and offers something: the
// bands fall back to what the trade ACTUALLY did (MAE/MFE), so a bracket-less
// trade draws a full overlay instead of a bare entry line.
describe("tradeZones realized fallback", () => {
  const bare: T = { ...base, stop_initial: null, stop_final: null, target: null };
  it("a short with no brackets takes its levels from MAE/MFE", () => {
    const z = tradeZones({ ...bare, mae: 3, mfe: 2 });
    expect(z.hasRisk).toBe(true); expect(z.hasReward).toBe(true);
    expect(z.riskRealized).toBe(true); expect(z.rewardRealized).toBe(true);
    expect(z.riskLevel).toBeCloseTo(103, 6);   // adverse is UP for a short
    expect(z.rewardLevel).toBeCloseTo(98, 6);  // favorable is DOWN
    expect(z.riskPct).toBeCloseTo(3, 6);
    expect(z.rewardPct).toBeCloseTo(2, 6);
    expect(z.rr).toBeCloseTo(2 / 3, 6);
  });
  it("a long with no brackets mirrors the sides", () => {
    const z = tradeZones({ ...bare, leg: "long", side: "buy", mae: 3, mfe: 2 });
    expect(z.riskLevel).toBeCloseTo(97, 6);
    expect(z.rewardLevel).toBeCloseTo(102, 6);
  });
  it("a real bracket wins over the excursion", () => {
    const z = tradeZones({ ...base, mae: 9, mfe: 9 });
    expect(z.riskRealized).toBe(false); expect(z.rewardRealized).toBe(false);
    expect(z.riskLevel).toBe(102); expect(z.rewardLevel).toBe(96);
  });
  it("mixes a planned stop with a realized reward", () => {
    const z = tradeZones({ ...base, target: null, mfe: 2 });
    expect(z.riskRealized).toBe(false); expect(z.rewardRealized).toBe(true);
    expect(z.rewardLevel).toBeCloseTo(98, 6);
  });
  it("a zero excursion leaves the leg collapsed", () => {
    const z = tradeZones(bare);
    expect(z.hasRisk).toBe(false); expect(z.hasReward).toBe(false);
    expect(z.riskLevel).toBeNull(); expect(z.rewardLevel).toBeNull();
    expect(z.rr).toBeNull();
  });
});

describe("zoneLabels", () => {
  it("tags a realized band so it can't read as a planned bracket", () => {
    const l = zoneLabels(tradeZones({ ...base, stop_initial: null, stop_final: null,
      target: null, mae: 3, mfe: 2 }));
    expect(l.risk).toBe("-3.0% MAE");
    expect(l.reward).toBe("+2.0% MFE");
    expect(l.rr).toBe("MAE/MFE 1:0.67");
  });
  it("leaves a planned bracket's labels alone", () => {
    const l = zoneLabels(tradeZones(base));
    expect(l.risk).toBe("-2.0%");
    expect(l.reward).toBe("+4.0%");
    expect(l.rr).toBe("R:R 1:2.00");
  });
});
