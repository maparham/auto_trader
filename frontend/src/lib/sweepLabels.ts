// Human labels for sweep axes. The axis `target` is a machine path
// ("lit:long.entry.0.1", "risk:long.stop.value"); this resolves it against the
// current config into copy a trader reads: "EMA length", "Long stop %". Used at
// toggle time (single axis, base label) and again at run time (collision-aware)
// so the results panel names each axis by what it actually sweeps, not its path.

import { type RiskConfig, type RuleGroup } from "./backtestConfig";
import type { SweepAxis } from "./sweep";
import { literalLabel } from "./expr/sweepLiterals";

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

function cap(side: string): string {
  return side === "long" ? "Long" : "Short";
}

function groupFor(cfg: LabelConfig, side: string, group: string): RuleGroup | undefined {
  if (group === "entry") return side === "long" ? cfg.longEntry : cfg.shortEntry;
  return side === "long" ? cfg.longExit : cfg.shortExit;
}

function litLabel(target: string, cfg: LabelConfig): string | null {
  // "lit:<side>.<group>.<rowIdx>.<ordinal>". rowIdx is the FULL-list row index
  // (the expression request ships every row), NOT the enabled-only index that
  // rule:/op: use. Resolves the literal's context label ("EMA length"); returns
  // null when the row or that ordinal no longer exists so a stale axis is pruned.
  const [, side, group, idxStr, ordStr] = target.split(/[:.]/);
  const g = groupFor(cfg, side, group);
  const row = g?.rules[Number(idxStr)];
  if (!row || row.expr == null) return null;
  return literalLabel(row.expr, Number(ordStr)) || null;
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
  if (target.startsWith("lit:")) return litLabel(target, cfg);
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
