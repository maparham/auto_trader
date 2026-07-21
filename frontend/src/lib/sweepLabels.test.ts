import { describe, it, expect } from "vitest";
import type { RuleGroup } from "./backtestConfig";
import type { RangeAxis, ListAxis, SweepAxis } from "./sweep";
import { sweepAxisLabel, sweepAxisLabels, withSweepLabels, type LabelConfig } from "./sweepLabels";

const group = (...rules: RuleGroup["rules"]): RuleGroup => ({ combine: "AND", rules });

function rangeAxis(target: string, label = "stored"): RangeAxis {
  return { kind: "range", target, label, from: 0, to: 1, step: 1 };
}

describe("sweepAxisLabel (risk axes)", () => {
  const cfg: LabelConfig = {
    longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "atr", mult: 3, length: 14 } },
    shortRisk: { stop: { kind: "trailPct", value: 1 }, target: { kind: "price", value: 100 } },
  };
  it("labels a percent stop", () => {
    expect(sweepAxisLabel("risk:long.stop.value", cfg)).toBe("Long stop %");
  });
  it("labels an ATR target mult", () => {
    expect(sweepAxisLabel("risk:long.target.mult", cfg)).toBe("Long target ATR ×");
  });
  it("labels a trailing-percent stop", () => {
    expect(sweepAxisLabel("risk:short.stop.value", cfg)).toBe("Short stop trail %");
  });
  it("labels a fixed-price target value", () => {
    expect(sweepAxisLabel("risk:short.target.value", cfg)).toBe("Short target price");
  });
});

describe("sweepAxisLabel (expression literal axes)", () => {
  const exprRow = (expr: string) =>
    ({ expr, enabled: true } as unknown as RuleGroup["rules"][number]);

  it("labels a lit: axis by the literal's context (full-list index)", () => {
    const cfg: LabelConfig = { longEntry: group(exprRow("EMA(50) > 30")) };
    expect(sweepAxisLabel("lit:long.entry.0.0", cfg)).toBe("EMA length");
    expect(sweepAxisLabel("lit:long.entry.0.1", cfg)).toBe("threshold");
  });

  it("returns null for a lit: axis whose ordinal no longer exists", () => {
    const cfg: LabelConfig = { longEntry: group(exprRow("EMA(9) > candle.close")) };
    expect(sweepAxisLabel("lit:long.entry.0.1", cfg)).toBeNull();
  });

  it("returns null (no crash) for a stale rule:/op: axis over an expression row", () => {
    const cfg: LabelConfig = { longEntry: group(exprRow("EMA(9) > 0")) };
    expect(sweepAxisLabel("rule:long.entry.0.right.value", cfg)).toBeNull();
    expect(sweepAxisLabel("op:long.entry.0", cfg)).toBeNull();
  });
});

describe("sweepAxisLabels (collision disambiguation)", () => {
  it("falls back to the stored label for an unresolvable target", () => {
    const listAxis: ListAxis = { kind: "list", target: "period", label: "Period", options: [] };
    expect(sweepAxisLabels([listAxis], {})).toEqual(["Period"]);
  });
});

describe("withSweepLabels", () => {
  it("rewrites each axis label in place, leaving the rest of the axis intact", () => {
    const cfg: LabelConfig = { longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "atr", mult: 3, length: 14 } } };
    const axes: SweepAxis[] = [rangeAxis("risk:long.stop.value", "stored")];
    const out = withSweepLabels(axes, cfg);
    expect(out[0].label).toBe("Long stop %");
    expect(out[0]).toMatchObject({ target: "risk:long.stop.value", from: 0, to: 1, step: 1 });
  });
});
