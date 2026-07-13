import { describe, expect, it } from "vitest";
import type { RiskConfig } from "./backtestConfig";
import { applyRiskSync, riskPatch, risksEqual, riskSyncOn } from "./riskSync";

const pct = (stop: number, target: number): RiskConfig => ({
  stop: { kind: "pct", value: stop },
  target: { kind: "pct", value: target },
});
const NONE: RiskConfig = { stop: { kind: "none" }, target: { kind: "none" } };

describe("riskSyncOn", () => {
  it("defaults ON when the flag is absent", () => {
    expect(riskSyncOn({})).toBe(true);
    expect(riskSyncOn({ riskSynced: true })).toBe(true);
    expect(riskSyncOn({ riskSynced: false })).toBe(false);
  });
});

describe("riskPatch", () => {
  it("writes both sides when synced", () => {
    const r = pct(1, 2);
    expect(riskPatch(true, "short", r)).toEqual({ longRisk: r, shortRisk: r });
  });
  it("writes only the edited side when not synced", () => {
    const r = pct(1, 2);
    expect(riskPatch(false, "long", r)).toEqual({ longRisk: r });
    expect(riskPatch(false, "short", r)).toEqual({ shortRisk: r });
  });
});

describe("risksEqual", () => {
  it("treats undefined and none/none as equal", () => {
    expect(risksEqual(undefined, undefined)).toBe(true);
    expect(risksEqual(NONE, undefined)).toBe(true);
    expect(risksEqual(undefined, NONE)).toBe(true);
  });
  it("compares stop and target field-by-field", () => {
    expect(risksEqual(pct(1, 2), pct(1, 2))).toBe(true);
    expect(risksEqual(pct(1, 2), pct(1, 3))).toBe(false);
    expect(risksEqual(pct(1, 2), undefined)).toBe(false);
    const atr: RiskConfig = { stop: { kind: "atr", mult: 2, length: 14 }, target: { kind: "pct", value: 4 } };
    expect(risksEqual(atr, { ...atr, stop: { ...atr.stop, length: 21 } })).toBe(false);
  });
});

describe("applyRiskSync", () => {
  it("copies the preferred side across when synced and differing", () => {
    const cfg = { longRisk: pct(1, 2), shortRisk: pct(3, 6) };
    expect(applyRiskSync(cfg, "long")).toEqual({ longRisk: pct(1, 2), shortRisk: pct(1, 2) });
    expect(applyRiskSync(cfg, "short")).toEqual({ longRisk: pct(3, 6), shortRisk: pct(3, 6) });
  });
  it("returns the same reference when already in sync or sync is off", () => {
    const same = { longRisk: pct(1, 2), shortRisk: pct(1, 2) };
    expect(applyRiskSync(same, "long")).toBe(same);
    const off = { riskSynced: false, longRisk: pct(1, 2), shortRisk: pct(3, 6) };
    expect(applyRiskSync(off, "long")).toBe(off);
    const untouched = { longRisk: pct(1, 2), shortRisk: NONE, riskSynced: false };
    expect(applyRiskSync(untouched, "long")).toBe(untouched);
  });
  it("does not rewrite when the other side is merely unset-vs-none", () => {
    const cfg = { longRisk: NONE };
    expect(applyRiskSync(cfg, "long")).toBe(cfg);
  });
  it("copies undefined across too (preferred side never configured)", () => {
    const cfg = { shortRisk: pct(3, 6) };
    expect(applyRiskSync(cfg, "long")).toEqual({ longRisk: undefined, shortRisk: undefined });
  });
});
