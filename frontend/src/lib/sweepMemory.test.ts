import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import {
  sweepContext,
  recallSweepRange,
  recordSweepRanges,
  loadSweepAxes,
  saveSweepAxes,
  pruneSweepAxes,
} from "./sweepMemory";
import type { RangeAxis, ListAxis, SweepAxis } from "./sweep";
import { defaultBacktestConfig } from "./backtestConfig";
import type { LabelConfig } from "./sweepLabels";

const range = (target: string, from = 10, to = 20, step = 2): RangeAxis => ({
  kind: "range", target, label: target, from, to, step,
});

beforeEach(() => localStorage.clear());

describe("sweepContext", () => {
  it("is 'rules' for rules mode and per-file for coded mode", () => {
    expect(sweepContext("rules", null)).toBe("rules");
    expect(sweepContext(undefined, null)).toBe("rules");
    expect(sweepContext("coded", "ema_cross.py")).toBe("coded.ema_cross.py");
    expect(sweepContext("coded", null)).toBe("coded.");
  });
});

describe("range memory", () => {
  it("recalls nothing before any record", () => {
    expect(recallSweepRange("rules", "risk:long.stop.value")).toBeNull();
  });

  it("records range axes on run and recalls them per target", () => {
    recordSweepRanges("rules", [range("risk:long.stop.value", 1, 3, 0.5)]);
    expect(recallSweepRange("rules", "risk:long.stop.value")).toEqual({ from: 1, to: 3, step: 0.5 });
  });

  it("does not record list axes", () => {
    const list: ListAxis = { kind: "list", target: "op:long.entry.0", label: "op", options: [] };
    recordSweepRanges("rules", [list]);
    expect(recallSweepRange("rules", "op:long.entry.0")).toBeNull();
  });

  it("keys by context: two strategy files do not collide", () => {
    recordSweepRanges("coded.a.py", [range("param:n", 5, 10, 1)]);
    recordSweepRanges("coded.b.py", [range("param:n", 50, 100, 10)]);
    expect(recallSweepRange("coded.a.py", "param:n")).toEqual({ from: 5, to: 10, step: 1 });
    expect(recallSweepRange("coded.b.py", "param:n")).toEqual({ from: 50, to: 100, step: 10 });
  });

  it("re-recording a target updates it in place", () => {
    recordSweepRanges("rules", [range("param:n", 1, 2, 1)]);
    recordSweepRanges("rules", [range("param:n", 3, 4, 1)]);
    expect(recallSweepRange("rules", "param:n")).toEqual({ from: 3, to: 4, step: 1 });
  });

  it("evicts the oldest entry past the 300-entry cap", () => {
    recordSweepRanges("rules", [range("param:first")]);
    for (let i = 0; i < 300; i++) recordSweepRanges("rules", [range(`param:p${i}`)]);
    expect(recallSweepRange("rules", "param:first")).toBeNull();
    expect(recallSweepRange("rules", "param:p299")).not.toBeNull();
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("auto-trader.sweepRanges", "not json");
    expect(recallSweepRange("rules", "param:n")).toBeNull();
    recordSweepRanges("rules", [range("param:n")]);
    expect(recallSweepRange("rules", "param:n")).toEqual({ from: 10, to: 20, step: 2 });
  });
});

describe("axis-set persistence", () => {
  it("round-trips an axis list per context", () => {
    const axes: SweepAxis[] = [range("risk:long.stop.value")];
    saveSweepAxes("rules", axes);
    expect(loadSweepAxes("rules")).toEqual(axes);
    expect(loadSweepAxes("coded.a.py")).toEqual([]);
  });

  it("returns [] for missing or malformed storage", () => {
    expect(loadSweepAxes("rules")).toEqual([]);
    localStorage.setItem("auto-trader.sweepAxes.rules", JSON.stringify({ nope: 1 }));
    expect(loadSweepAxes("rules")).toEqual([]);
  });
});

describe("pruneSweepAxes", () => {
  // Using defaultBacktestConfig which already has one enabled long-entry rule at index 0
  const cfg = defaultBacktestConfig() as LabelConfig;

  it("drops a rule axis whose rule no longer exists, keeps resolvable and self-labelled axes", () => {
    const axes: SweepAxis[] = [
      range("rule:long.entry.0.left.length"),
      range("rule:long.entry.5.left.length"),
      range("risk:long.stop.value"),
      range("param:n"),
      { kind: "period", target: "period", label: "Periods", n: 3 },
    ];
    const kept = pruneSweepAxes(axes, cfg);
    expect(kept.map((a) => a.target)).toEqual([
      "rule:long.entry.0.left.length",
      "risk:long.stop.value",
      "param:n",
      "period",
    ]);
  });
});
