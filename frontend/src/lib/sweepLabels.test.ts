import { describe, it, expect } from "vitest";
import type { Operand, RuleGroup } from "./backtestConfig";
import type { RangeAxis, ListAxis, SweepAxis } from "./sweep";
import { operandLabel, sweepAxisLabel, sweepAxisLabels, withSweepLabels, type LabelConfig } from "./sweepLabels";

const ema = (length: number): Operand => ({ kind: "indicator", indicator: "EMA", length });
const konst = (value: number): Operand => ({ kind: "const", value });
const series = (label: string): Operand =>
  // Recipe content is irrelevant to labeling: the chip carries its own label.
  ({ kind: "series", seriesKey: "k", label, recipe: { source: "indicator", indicatorType: "MASlope", calcParams: [9], line: 0 } } as unknown as Operand);

const group = (...rules: RuleGroup["rules"]): RuleGroup => ({ combine: "AND", rules });

function rangeAxis(target: string, label = "stored"): RangeAxis {
  return { kind: "range", target, label, from: 0, to: 1, step: 1 };
}

describe("operandLabel", () => {
  it("names an indicator with its length", () => {
    expect(operandLabel(ema(21))).toBe("EMA 21");
  });
  it("names a length-less indicator by kind alone", () => {
    expect(operandLabel({ kind: "indicator", indicator: "VOL" })).toBe("VOL");
  });
  it("uses a chart operand's own chip label", () => {
    expect(operandLabel(series("MA Slope 9 · SMA 9"))).toBe("MA Slope 9 · SMA 9");
  });
  it("shows a const's value, a price field, and the entry price", () => {
    expect(operandLabel(konst(3))).toBe("3");
    expect(operandLabel({ kind: "price", field: "close" })).toBe("close");
    expect(operandLabel({ kind: "entry" })).toBe("entry price");
  });
});

describe("sweepAxisLabel (rule axes)", () => {
  const cfg: LabelConfig = {
    longEntry: group({ left: series("MA Slope 9 · SMA 9"), op: "gt", right: konst(0) }),
    longExit: group({ left: ema(9), op: "crossesBelow", right: ema(21), count: 2 }),
  };

  it("labels a swept right value as <left> <op> x", () => {
    expect(sweepAxisLabel("rule:long.entry.0.right.value", cfg)).toBe("MA Slope 9 · SMA 9 > x");
  });
  it("labels a swept left value as x <op> <right>", () => {
    expect(sweepAxisLabel("rule:long.exit.0.left.length", cfg)).toBe("EMA 9 length");
  });
  it("labels a swept operand length by that operand", () => {
    expect(sweepAxisLabel("rule:long.exit.0.right.length", cfg)).toBe("EMA 21 length");
  });
  it("labels an exit count as the rule plus Nth", () => {
    expect(sweepAxisLabel("rule:long.exit.0.count", cfg)).toBe("EMA 9 crosses below EMA 21, Nth");
  });
  it("labels an operator axis by the rule's left operand", () => {
    expect(sweepAxisLabel("op:long.entry.0", cfg)).toBe("MA Slope 9 · SMA 9 op");
  });
  it("resolves against the ENABLED-only rule index", () => {
    const withDisabled: LabelConfig = {
      longEntry: group(
        { left: ema(5), op: "gt", right: konst(0), enabled: false },
        { left: ema(50), op: "gt", right: konst(0) },
      ),
    };
    // Index 0 addresses the second (first enabled) rule, not the disabled one.
    expect(sweepAxisLabel("rule:long.entry.0.right.value", withDisabled)).toBe("EMA 50 > x");
  });
  it("returns null for an out-of-range or unknown target", () => {
    expect(sweepAxisLabel("rule:long.entry.9.right.value", cfg)).toBeNull();
    expect(sweepAxisLabel("param:fast", cfg)).toBeNull();
  });
});

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

describe("sweepAxisLabels (collision disambiguation)", () => {
  it("qualifies two axes that share a base label with side and rule number", () => {
    const cfg: LabelConfig = {
      longEntry: group(
        { left: ema(9), op: "gt", right: konst(0) },
        { left: ema(9), op: "gt", right: konst(0) },
      ),
    };
    const axes: SweepAxis[] = [
      rangeAxis("rule:long.entry.0.right.value"),
      rangeAxis("rule:long.entry.1.right.value"),
    ];
    expect(sweepAxisLabels(axes, cfg)).toEqual(["Long 1 · EMA 9 > x", "Long 2 · EMA 9 > x"]);
  });

  it("separates two length axes on the same rule by comparison side", () => {
    const cfg: LabelConfig = {
      longEntry: group({ left: ema(9), op: "gt", right: ema(9) }),
    };
    const axes: SweepAxis[] = [
      rangeAxis("rule:long.entry.0.left.length"),
      rangeAxis("rule:long.entry.0.right.length"),
    ];
    expect(sweepAxisLabels(axes, cfg)).toEqual([
      "Long 1 · EMA 9 length (left)",
      "Long 1 · EMA 9 length (right)",
    ]);
  });

  it("leaves a unique label untouched", () => {
    const cfg: LabelConfig = {
      longEntry: group({ left: ema(9), op: "gt", right: konst(0) }),
    };
    expect(sweepAxisLabels([rangeAxis("rule:long.entry.0.right.value")], cfg)).toEqual(["EMA 9 > x"]);
  });

  it("falls back to the stored label for an unresolvable target", () => {
    const listAxis: ListAxis = { kind: "list", target: "period", label: "Period", options: [] };
    expect(sweepAxisLabels([listAxis], {})).toEqual(["Period"]);
  });
});

describe("withSweepLabels", () => {
  it("rewrites each axis label in place, leaving the rest of the axis intact", () => {
    const cfg: LabelConfig = { longEntry: group({ left: ema(9), op: "gt", right: konst(0) }) };
    const axes: SweepAxis[] = [rangeAxis("rule:long.entry.0.right.value", "long.entry.0.right.value")];
    const out = withSweepLabels(axes, cfg);
    expect(out[0].label).toBe("EMA 9 > x");
    expect(out[0]).toMatchObject({ target: "rule:long.entry.0.right.value", from: 0, to: 1, step: 1 });
  });
});
