// Sweep setup persistence: (1) a per-field "last used from/to/step" memory so
// re-toggling a sweep restores the previous round's range, and (2) the whole
// axis set saved per context so the panel's sweep setup survives close/apply/
// reload. Context is "rules" for rules mode or "coded.<filename>" for a coded
// strategy, so the same target name on two .py files never collides.
// (Spec: docs/superpowers/specs/2026-07-15-sweep-setup-persistence-design.md)

import { load, save, PREFIX } from "./persist/core";
import type { SweepAxis } from "./sweep";
import { sweepAxisLabel, type LabelConfig } from "./sweepLabels";

export interface SweepRange {
  from: number;
  to: number;
  step: number;
}

const RANGES_KEY = `${PREFIX}.sweepRanges`;
const RANGES_CAP = 300;
const axesKey = (ctx: string) => `${PREFIX}.sweepAxes.${ctx}`;

export function sweepContext(
  mode: "rules" | "coded" | undefined,
  codedStrategy?: string | null,
): string {
  return mode === "coded" ? `coded.${codedStrategy ?? ""}` : "rules";
}

// Stored as an entry list in least-recently-recorded order (oldest first),
// so the cap can evict from the front without a separate timestamp.
type RangeEntries = Array<[string, SweepRange]>;

function loadRanges(): RangeEntries {
  const raw = load<RangeEntries>(RANGES_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

export function recallSweepRange(ctx: string, target: string): SweepRange | null {
  const key = `${ctx}|${target}`;
  const hit = loadRanges().find(([k]) => k === key);
  return hit ? hit[1] : null;
}

/** Records every RANGE axis's from/to/step under the context. Called when a
 * sweep actually runs: "last used" means "last swept with", not "last typed". */
export function recordSweepRanges(ctx: string, axes: SweepAxis[]): void {
  const fresh: RangeEntries = axes
    .filter((a): a is Extract<SweepAxis, { kind: "range" }> => a.kind === "range")
    .map((a) => [`${ctx}|${a.target}`, { from: a.from, to: a.to, step: a.step }]);
  if (!fresh.length) return;
  const freshKeys = new Set(fresh.map(([k]) => k));
  const entries = loadRanges().filter(([k]) => !freshKeys.has(k));
  entries.push(...fresh);
  save(RANGES_KEY, entries.slice(-RANGES_CAP));
}

export function loadSweepAxes(ctx: string): SweepAxis[] {
  const raw = load<SweepAxis[]>(axesKey(ctx), []);
  return Array.isArray(raw) ? raw : [];
}

export function saveSweepAxes(ctx: string, axes: SweepAxis[]): void {
  save(axesKey(ctx), axes);
}

/** Restore-time validation: drop any axis whose target no longer resolves
 * against the current config (e.g. a rule deleted since the axis was saved).
 * param axes pass here (the strategy schema loads async; the modal prunes them
 * once it arrives), and period/timeWindow axes always resolve. */
export function pruneSweepAxes(axes: SweepAxis[], cfg: LabelConfig): SweepAxis[] {
  return axes.filter((a) => {
    const t = a.target;
    if (t.startsWith("param:") || t === "period" || t === "timeWindow") return true;
    return sweepAxisLabel(t, cfg) !== null;
  });
}
