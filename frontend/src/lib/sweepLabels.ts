// Human labels for sweep axes. The axis `target` is a machine path
// ("rule:long.entry.0.right.value", "risk:long.stop.value",
// "op:long.entry.0"); this resolves it against the current config into copy a
// trader reads: "MA Slope 9 · SMA 9 > x", "Long stop %". Used at toggle time
// (single axis, base label) and again at run time (collision-aware) so the
// results panel names each axis by what it actually sweeps, not its path.

import type { Operand, Operator, RiskConfig, RuleGroup } from "./backtestConfig";
import type { SweepAxis } from "./sweep";

// The slice of a config this resolver reads. BacktestConfig (rules mode) and
// CodedStrategyConfig (coded mode) both satisfy it; entry groups are absent in
// coded mode, which never sweeps an entry rule.
export interface LabelConfig {
  longEntry?: RuleGroup;
  longExit?: RuleGroup;
  shortEntry?: RuleGroup;
  shortExit?: RuleGroup;
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
}

// Compact comparison text. `crosses` variants stay as words so they never
// collide with the "x" placeholder used for the swept value.
const OP_SYMBOL: Record<Operator, string> = {
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
  crosses: "crosses",
};

/** How one operand reads on a rule row: a chart operand's own chip label, an
 * indicator plus its length ("EMA 21", "VOL"), a price field, a const value,
 * or the held position's entry price. */
export function operandLabel(op: Operand): string {
  switch (op.kind) {
    case "series":
      return op.label;
    case "const":
      return String(op.value);
    case "price":
      return op.field;
    case "entry":
      return "entry price";
    case "indicator":
      return op.length != null ? `${op.indicator} ${op.length}` : op.indicator;
    default:
      return "?";
  }
}

function cap(side: string): string {
  return side === "long" ? "Long" : "Short";
}

function groupFor(cfg: LabelConfig, side: string, group: string): RuleGroup | undefined {
  if (group === "entry") return side === "long" ? cfg.longEntry : cfg.shortEntry;
  return side === "long" ? cfg.longExit : cfg.shortExit;
}

// A sweep target addresses a rule by its position in the ENABLED-only list
// (activeRuleIndex in the modal), so resolve against the same filtered list.
function ruleAt(cfg: LabelConfig, side: string, group: string, idx: number) {
  const g = groupFor(cfg, side, group);
  if (!g) return null;
  return g.rules.filter((r) => r.enabled !== false)[idx] ?? null;
}

function ruleLabel(target: string, cfg: LabelConfig): string | null {
  // "rule:<side>.<group>.<idx>.<left|right>.<length|value>" | "...count"
  const [, side, group, idxStr, ...leaf] = target.split(/[:.]/);
  const rule = ruleAt(cfg, side, group, Number(idxStr));
  if (!rule) return null;
  const left = operandLabel(rule.left);
  const right = operandLabel(rule.right);
  const sym = OP_SYMBOL[rule.op];
  const path = leaf.join(".");
  if (path === "count") return `${left} ${sym} ${right}, Nth`;
  if (path === "left.value") return `x ${sym} ${right}`;
  if (path === "right.value") return `${left} ${sym} x`;
  if (path === "left.length") return `${left} length`;
  if (path === "right.length") return `${right} length`;
  return null;
}

function opLabel(target: string, cfg: LabelConfig): string | null {
  // "op:<side>.<group>.<idx>"
  const [, side, group, idxStr] = target.split(/[:.]/);
  const rule = ruleAt(cfg, side, group, Number(idxStr));
  if (!rule) return null;
  return `${operandLabel(rule.left)} op`;
}

function riskLabel(target: string, cfg: LabelConfig): string | null {
  // "risk:<side>.<stop|target>.<value|mult>". The unit follows from the field's
  // kind: a mult axis is always ATR, a value axis is % / trail % / price.
  const [, side, field, prop] = target.split(/[:.]/);
  if (!side || (field !== "stop" && field !== "target") || !prop) return null;
  const risk = side === "long" ? cfg.longRisk : cfg.shortRisk;
  const kind = (field === "stop" ? risk?.stop.kind : risk?.target.kind) ?? "";
  const unit =
    prop === "mult"
      ? "ATR ×"
      : kind === "trailPct"
        ? "trail %"
        : kind === "trailAtr"
          ? "trail ATR ×"
          : kind === "price"
            ? "price"
            : kind === "atr"
              ? "ATR ×"
              : "%";
  return `${cap(side)} ${field} ${unit}`;
}

/** Base label for one axis, or null if the target does not resolve (unknown
 * grammar, or a rule deleted since the axis was created). param/period/
 * timeWindow targets return null on purpose: they keep their own stored
 * label. */
export function sweepAxisLabel(target: string, cfg: LabelConfig): string | null {
  if (target.startsWith("rule:")) return ruleLabel(target, cfg);
  if (target.startsWith("op:")) return opLabel(target, cfg);
  if (target.startsWith("risk:")) return riskLabel(target, cfg);
  return null;
}

// Side + rule number prefix ("Long 1", "Short exit 2") to disambiguate two
// axes that share a base label; null for non-rule targets.
function prefixFor(target: string): string | null {
  if (!target.startsWith("rule:") && !target.startsWith("op:")) return null;
  const [, side, group, idxStr] = target.split(/[:.]/);
  return `${cap(side)}${group === "exit" ? " exit" : ""} ${Number(idxStr) + 1}`;
}

// "left"/"right" leaf of a rule operand axis, so two length axes on the same
// rule (same prefix, same base) still separate; null otherwise.
function leafSide(target: string): "left" | "right" | null {
  const p = target.split(".");
  return p[3] === "left" || p[3] === "right" ? p[3] : null;
}

function tally(labels: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
}

/** Labels for a whole axis list, collision-aware: a base label shared by two
 * or more axes is qualified with its side and rule number, and if that still
 * collides (two operand axes on the same rule) with the comparison side, so
 * every returned label is distinct. Unresolvable targets fall back to the
 * axis's stored label. */
export function sweepAxisLabels(axes: SweepAxis[], cfg: LabelConfig): string[] {
  // Stage 1: base labels, prefixed only where they collide.
  const bases = axes.map((a) => sweepAxisLabel(a.target, cfg) ?? a.label);
  const baseCounts = tally(bases);
  const prefixed = axes.map((a, i) => {
    if ((baseCounts.get(bases[i]) ?? 0) <= 1) return bases[i];
    const p = prefixFor(a.target);
    return p ? `${p} · ${bases[i]}` : bases[i];
  });
  // Stage 2: for labels that still collide (same rule, different leaf side),
  // append the comparison side.
  const prefixedCounts = tally(prefixed);
  return axes.map((a, i) => {
    if ((prefixedCounts.get(prefixed[i]) ?? 0) <= 1) return prefixed[i];
    const side = leafSide(a.target);
    return side ? `${prefixed[i]} (${side})` : prefixed[i];
  });
}

/** The axis list with each `label` replaced by its collision-aware label.
 * Applied to the materialized axes right before a run so results describe the
 * run as it ran. */
export function withSweepLabels(axes: SweepAxis[], cfg: LabelConfig): SweepAxis[] {
  const labels = sweepAxisLabels(axes, cfg);
  return axes.map((a, i) => ({ ...a, label: labels[i] }));
}
