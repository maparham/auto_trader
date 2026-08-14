import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

import {
  codedCfgsDiffer, loadCodedCfg, resolveParamValues, rewriteCodedExitRefs,
  saveCodedCfg, sendableRisk,
} from "./codedConfig";
import type { ParamSpec } from "../api";

const spec = (over: Partial<ParamSpec> = {}): ParamSpec => ({
  name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
  min: 2, max: 50, step: 1, options: null, help: null, ...over,
});

beforeEach(() => localStorage.clear());

describe("codedConfig store", () => {
  it("returns an empty default config for an unknown filename", () => {
    const cfg = loadCodedCfg("backtest", "new.py");
    expect(cfg.params).toEqual({});
    expect(cfg.longExit.rules).toEqual([]);
    expect(cfg.longRisk).toBeUndefined();
  });

  it("keeps backtest and live sets independent", () => {
    const base = loadCodedCfg("backtest", "s.py");
    saveCodedCfg("backtest", "s.py", { ...base, params: { ema_fast: 12 } });
    expect(loadCodedCfg("backtest", "s.py").params).toEqual({ ema_fast: 12 });
    expect(loadCodedCfg("live", "s.py").params).toEqual({});
  });

  it("keeps per-filename configs independent", () => {
    const base = loadCodedCfg("backtest", "a.py");
    saveCodedCfg("backtest", "a.py", { ...base, params: { ema_fast: 12 } });
    expect(loadCodedCfg("backtest", "b.py").params).toEqual({});
  });
});

// A preset load can recreate a referenced pane under a fresh id (the saved id
// was taken by a differently-configured pane); the store's exit rules must
// follow, or they keep naming a pane that isn't theirs.
describe("rewriteCodedExitRefs", () => {
  it("rewrites instance refs in both exit groups, leaving everything else alone", () => {
    const base = loadCodedCfg("backtest", "s.py");
    saveCodedCfg("backtest", "s.py", {
      ...base,
      params: { ema_fast: 12 },
      longExit: { combine: "AND", rules: [{ expr: "SLOPE#a1.9 > 0", enabled: true }] },
      shortExit: { combine: "OR", rules: [{ expr: "ATR1.to14 > 1" }, { expr: "EMA(9) > 0" }] },
    });
    rewriteCodedExitRefs("backtest", "s.py", { "SLOPE#a1": "SLOPE#b2", ATR1: "ATR" });
    const cfg = loadCodedCfg("backtest", "s.py");
    expect(cfg.longExit.rules[0]).toEqual({ expr: "SLOPE#b2.9 > 0", enabled: true });
    expect(cfg.shortExit.rules.map((r) => r.expr)).toEqual(["ATR.to14 > 1", "EMA(9) > 0"]);
    expect(cfg.params).toEqual({ ema_fast: 12 });
  });

  it("an empty id map leaves the store untouched", () => {
    const base = loadCodedCfg("backtest", "s.py");
    saveCodedCfg("backtest", "s.py", {
      ...base,
      longExit: { combine: "AND", rules: [{ expr: "SLOPE.9 > 0" }] },
    });
    const before = loadCodedCfg("backtest", "s.py");
    rewriteCodedExitRefs("backtest", "s.py", {});
    expect(loadCodedCfg("backtest", "s.py")).toEqual(before);
  });
});

describe("resolveParamValues", () => {
  it("fills defaults and keeps valid stored values", () => {
    expect(resolveParamValues([spec()], {})).toEqual({ ema_fast: 9 });
    expect(resolveParamValues([spec()], { ema_fast: 12 })).toEqual({ ema_fast: 12 });
  });

  it("drops unknown keys and out-of-range/mistyped values", () => {
    expect(resolveParamValues([spec()], { gone: 1, ema_fast: 999 }))
      .toEqual({ ema_fast: 9 });
    expect(resolveParamValues([spec()], { ema_fast: "nine" }))
      .toEqual({ ema_fast: 9 });
    expect(resolveParamValues(
      [spec({ type: "choice", default: "a", options: ["a", "b"], min: null, max: null, step: null })],
      { ema_fast: "c" },
    )).toEqual({ ema_fast: "a" });
  });
});

describe("sendableRisk", () => {
  it("passes through undefined and a genuinely configured risk", () => {
    expect(sendableRisk(undefined)).toBeUndefined();
    const configured = { stop: { kind: "pct" as const, value: 5 }, target: { kind: "none" as const } };
    expect(sendableRisk(configured)).toEqual(configured);
  });

  it("normalizes a none/none risk to undefined (C1) so file brackets survive", () => {
    // RiskSection touched then reset back to None persists {none,none} — this
    // must be indistinguishable from never having configured panel risk at all.
    expect(sendableRisk({ stop: { kind: "none" }, target: { kind: "none" } })).toBeUndefined();
  });
});

describe("codedCfgsDiffer", () => {
  it("detects param and risk drift", () => {
    const a = loadCodedCfg("backtest", "x.py");
    expect(codedCfgsDiffer(a, { ...a })).toBe(false);
    expect(codedCfgsDiffer(a, { ...a, params: { n: 1 } })).toBe(true);
    expect(codedCfgsDiffer(a, {
      ...a, longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
    })).toBe(true);
  });

  it("ignores key order and absent-vs-undefined fields", () => {
    const a = { ...loadCodedCfg("backtest", "x.py"), params: { a: 1, b: 2 } };
    const b = { ...loadCodedCfg("backtest", "x.py"), params: { b: 2, a: 1 } };
    expect(codedCfgsDiffer(a, b)).toBe(false);
    expect(codedCfgsDiffer(a, { ...a, longRisk: undefined })).toBe(false);
  });
});
