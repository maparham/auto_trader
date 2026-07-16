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

// Per-epic sweep pace memory: how long one combo took last time, keyed by
// epic|timeframe|run-target, so the footer can turn a combo count into a rough
// runtime estimate. Same capped entry-list eviction pattern as the ranges above.
const PACE_KEY = `${PREFIX}.sweepPace`;
const PACE_CAP = 100;
type PaceEntries = Array<[string, number]>;
const paceKey = (epic: string, tf: string, target: string) => `${epic}|${tf}|${target}`;

function loadPace(): PaceEntries {
  const raw = load<PaceEntries>(PACE_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/** Record the observed ms-per-combo for the epic/timeframe/target a sweep just
 * ran on. Called by BacktestButton on a successful sweep with produced rows. */
export function recordSweepPace(epic: string, tf: string, target: string, msPerCombo: number): void {
  const key = paceKey(epic, tf, target);
  const entries = loadPace().filter(([k]) => k !== key);
  entries.push([key, msPerCombo]);
  save(PACE_KEY, entries.slice(-PACE_CAP));
}

export function recallSweepPace(epic: string, tf: string, target: string): number | null {
  const key = paceKey(epic, tf, target);
  const entries = loadPace();
  const hit = entries.find(([k]) => k === key);
  if (hit) return hit[1];
  // No pace for this exact epic/tf/target yet: fall back to the most recently
  // recorded pace across ALL keys so a first-time run still gets a rough
  // estimate. The entry list is oldest-first, so the last entry is newest.
  return entries.length ? entries[entries.length - 1][1] : null;
}

/** Footer estimate copy. Without a pace we only know the combo count; with one
 * we add a rough runtime, rounded UP to whole minutes (sub-minute reads "under a
 * minute"). No em dashes in the copy. */
export function estimateSweepText(combos: number, msPerCombo: number | null): string {
  const noun = combos === 1 ? "combo" : "combos";
  if (msPerCombo == null) return `${combos} ${noun}`;
  const total = combos * msPerCombo;
  if (total < 60000) return `${combos} ${noun}, under a minute on this run target`;
  return `${combos} ${noun}, about ${Math.ceil(total / 60000)}m on this run target`;
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
