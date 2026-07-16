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
  recordSweepPace,
  recallSweepPace,
  estimateSweepText,
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

describe("pace memory", () => {
  it("recalls nothing before any record", () => {
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBeNull();
  });

  it("records a per-combo pace and recalls it by epic|tf|target", () => {
    recordSweepPace("CS.D.EURUSD", "MINUTE", "local", 250);
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBe(250);
  });

  it("falls back to the most recent pace when the exact key misses", () => {
    recordSweepPace("CS.D.EURUSD", "MINUTE", "local", 250);
    recordSweepPace("CS.D.GBPUSD", "HOUR", "remote", 900);
    // Exact hits still win over the fallback.
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBe(250);
    // A miss (different target / tf / epic) returns the most recently recorded
    // pace across all keys (900), for a rough first-time estimate.
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "remote")).toBe(900);
    expect(recallSweepPace("CS.D.EURUSD", "HOUR", "local")).toBe(900);
    expect(recallSweepPace("brand-new", "DAY", "local")).toBe(900);
  });

  it("re-recording a key updates it in place", () => {
    recordSweepPace("CS.D.EURUSD", "MINUTE", "local", 100);
    recordSweepPace("CS.D.EURUSD", "MINUTE", "local", 400);
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBe(400);
  });

  it("evicts the oldest entry past the 100-entry cap", () => {
    recordSweepPace("epic-first", "MINUTE", "local", 10);
    for (let i = 0; i < 100; i++) recordSweepPace(`epic-${i}`, "MINUTE", "local", i + 1);
    // epic-first was evicted: its exact recall no longer returns its own 10 (it
    // falls back to the most recent surviving entry instead).
    expect(recallSweepPace("epic-first", "MINUTE", "local")).not.toBe(10);
    expect(recallSweepPace("epic-99", "MINUTE", "local")).toBe(100);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("auto-trader.sweepPace", "not json");
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBeNull();
    recordSweepPace("CS.D.EURUSD", "MINUTE", "local", 42);
    expect(recallSweepPace("CS.D.EURUSD", "MINUTE", "local")).toBe(42);
  });
});

describe("estimateSweepText", () => {
  it("shows just the combo count when there is no pace", () => {
    expect(estimateSweepText(250, null)).toBe("250 combos");
    expect(estimateSweepText(1, null)).toBe("1 combo");
  });

  it("uses the singular 'combo' when there is exactly one", () => {
    expect(estimateSweepText(1, 100)).toBe("1 combo, under a minute on this run target");
    expect(estimateSweepText(1, 120_000)).toBe("1 combo, about 2m on this run target");
  });

  it("says 'under a minute' when the total is below one minute", () => {
    // 250 combos * 100ms = 25s.
    expect(estimateSweepText(250, 100)).toBe("250 combos, under a minute on this run target");
  });

  it("rounds minutes up for longer runs", () => {
    // 60 combos * 3000ms = 180000ms = exactly 3m.
    expect(estimateSweepText(60, 3000)).toBe("60 combos, about 3m on this run target");
    // 61 combos * 3000ms = 183000ms -> ceil to 4m.
    expect(estimateSweepText(61, 3000)).toBe("61 combos, about 4m on this run target");
  });

  it("treats exactly one minute as 'about 1m' (ceil), not 'under a minute'", () => {
    expect(estimateSweepText(60, 1000)).toBe("60 combos, about 1m on this run target");
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
