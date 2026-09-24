// THE SMALLEST FIX. A threshold gate that does not change the pivot pool has an
// exact answer (the measured value, rounded in the permissive direction). A
// setting that changes the pool (Min Length, Min Size, Min Reach, Max Pairs)
// moves touches and pairings everywhere, so its proposal is only a guess until
// a re-run with it draws the target. findFix therefore VERIFIES everything by
// re-running, and iterates: fix what blocks the closest near matches, re-run,
// repeat, at most MAX_ROUNDS times.
import {
  buildTlState,
  mergeTolerance,
  lineKey,
  poolable,
  selectDrawnLines,
  trendlineGate,
} from "./trendlines";
import { MAX_MAX_LINES, parseTrendlinesConfig, type TrendlinesConfig } from "./trendlinesOutputs";
import { runDebugAsync, type DebugRunInput } from "./trendlinesDebug";
import { explain, type DebugCandidate, type Verdict } from "./trendlinesDebugExplain";
import { forcedPairsFor, lookup, targetToIdx, type SimLimits, type TargetLine } from "./trendlinesDebugLookup";

export interface SettingChange {
  field: keyof TrendlinesConfig;
  from: number;
  to: number;
  pool: boolean;
}

export const POOL_FIELDS: ReadonlySet<keyof TrendlinesConfig> = new Set([
  "pivotLen", "minSwingAtr", "minSwingReach", "pairPivots",
]);

const MAX_ROUNDS = 4;
const floorTo = (v: number, step: number) => Math.floor(v / step + 1e-9) * step;
const ceilTo = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;
const round = (v: number) => Number(v.toFixed(6));

/** Integer slots parseTrendlinesConfig floors, grouped by which direction is
 * permissive: a MAX-type slot must be rounded UP before parsing (parsing only
 * ever floors, so a raw ceiling like 3.5 must become 4, never 3, or the
 * parsed value undershoots what the gate needs); a MIN-type slot rounding
 * down is already what parsing does, so it only needs the parse pass itself. */
const MAX_TYPE_INT_FIELDS = new Set<keyof TrendlinesConfig>([
  "maxTouches", "maxSpanBars", "maxTouchSpacing", "maxCrossings",
  "maxProjBars", "lookbackBars", "pairPivots", "maxLines", "maxPerPivot",
]);
const MIN_TYPE_INT_FIELDS = new Set<keyof TrendlinesConfig>([
  "minTouches", "minSpanBars", "minSwingReach", "minTouchSpacing", "minCrossings", "minBackBars", "pivotLen",
]);

/** A proposed value the app's own settings can actually hold: rounded to an
 * integer in the permissive direction for an integer slot, then run through
 * the real parser so every other clamp (minTouches >= 2, maxLines <= 50,
 * pivotLen >= 1, ...) applies exactly as it would to a saved pane. */
function normalizeField(field: keyof TrendlinesConfig, raw: number, cfg: TrendlinesConfig): number {
  let v = raw;
  if (MAX_TYPE_INT_FIELDS.has(field)) v = Math.ceil(v - 1e-9);
  else if (MIN_TYPE_INT_FIELDS.has(field)) v = Math.floor(v + 1e-9);
  const candidate = { ...cfg, [field]: v } as TrendlinesConfig;
  const parsed = parseTrendlinesConfig(Object.values(candidate));
  return parsed[field] as number;
}

/** The value one failing verdict needs, or null when no setting helps. */
function needFor(v: Verdict, cfg: TrendlinesConfig): number | null {
  const m = v.measured;
  switch (v.gate) {
    case "minTouches": return m === null ? null : floorTo(m, 0.5);
    case "maxTouches": return m === null ? null : ceilTo(m, 0.5);
    case "minSpan": case "maxSpan": case "maxTouchSpacing": case "minTouchSpacing":
    case "minCrossings": case "maxCrossings": case "stale": case "lookback":
    case "backClearance": case "reach": case "window":
      return m;
    case "slopeMax": return m === null ? null : ceilTo(m, 0.01);
    case "slopeMin": return m === null ? null : floorTo(m, 0.01);
    case "distanceAtr": return m === null ? null : ceilTo(m, 0.1);
    case "distancePct": return m === null ? null : ceilTo(m, 0.01);
    case "size": return m === null ? null : floorTo(m, 0.01);
    case "fractal": case "unconfirmed":
      // Largest Min Length at which the anchor is a fractal, or confirms.
      return v.gate === "unconfirmed" ? (m !== null && m >= 1 ? Math.min(m, cfg.pivotLen - 1) : null) : m;
    // floorTo's own -1e-9 nudge already forces a strictly-lower grid point
    // when m sits exactly on one, so no extra step down is needed to keep the
    // tolerance strictly below the merge gap (sameTrend merges at <= tol).
    case "merged": return m === null ? null : Math.max(0, floorTo(m - 1e-9, 0.01));
    case "perPivot": return m;
    case "maxLines": return m !== null && m <= MAX_MAX_LINES ? m : null;
    case "liveCap": return null;
  }
}

/** One change per failing verdict's setting. Two verdicts on one field (both
 * anchors) keep the more permissive value. */
export function proposeChanges(
  c: DebugCandidate, cfg: TrendlinesConfig,
): { changes: SettingChange[]; impossible: Verdict[] } {
  const byField = new Map<keyof TrendlinesConfig, SettingChange>();
  const impossible: Verdict[] = [];
  for (const v of c.failed) {
    const raw = v.field ? needFor(v, cfg) : null;
    if (!v.field || raw === null || !Number.isFinite(raw)) {
      impossible.push(v);
      continue;
    }
    const to = normalizeField(v.field, raw, cfg);
    const prev = byField.get(v.field);
    const loosen = (a: number, b: number) =>
      v.gate.startsWith("min") || ["fractal", "unconfirmed", "size", "reach", "slopeMin", "backClearance", "merged"].includes(v.gate)
        ? Math.min(a, b) : Math.max(a, b);
    byField.set(v.field, {
      field: v.field, from: cfg[v.field] as number, to: round(prev ? loosen(prev.to, to) : to), pool: POOL_FIELDS.has(v.field),
    });
  }
  return { changes: [...byField.values()], impossible };
}

export interface FixResult {
  /** VERIFIED: a re-run with these applied covers the target. Empty when the
   * search never verified a fix; see `attempted` for the unverified guess. */
  changes: SettingChange[];
  covered: boolean;
  viaKey: string | null;
  /** The closest remaining near-match's failing verdicts, when not covered
   * (an empty array both when nothing came close and when covered is true). */
  blockers: Verdict[];
  /** UNVERIFIED: the last round's proposed changes, for the UI to show as
   * hints only, when the search gave up without covering the target. Always
   * empty when `covered` is true or `error` is set. */
  attempted: SettingChange[];
  /** Set, with everything else empty, when the target itself can't be
   * resolved against the loaded bars (targetToIdx's own error), before any
   * search runs. */
  error?: string;
}

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function findFix(
  base: DebugRunInput, target: TargetLine, limits: SimLimits, signal?: AbortSignal,
): Promise<FixResult | null> {
  const times = (base.starts ?? base.bars.map((b) => b.timestamp)).slice(0, base.evalIdx + 1);
  const tgt = targetToIdx(times, target);
  if ("error" in tgt) return { changes: [], covered: false, viaKey: null, blockers: [], attempted: [], error: tgt.error };
  const highs = base.bars.map((b) => b.high);
  const lows = base.bars.map((b) => b.low);
  const applied = new Map<keyof TrendlinesConfig, SettingChange>();
  let cfg = base.cfg;
  let blockers: Verdict[] = [];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const run = await runDebugAsync(
      { ...base, cfg, window: [tgt.x1, base.evalIdx], forced: forcedPairsFor(highs, lows, tgt, cfg.pivotLen) },
      signal,
    );
    if (!run) return null;
    const res = explain(run);
    const { matches, covered } = lookup(res, tgt, limits);
    if (covered) return { changes: [...applied.values()], covered: true, viaKey: covered.cand.key, blockers: [], attempted: [] };
    let best: SettingChange[] | null = null;
    for (const m of matches.slice(0, 3)) {
      const { changes, impossible } = proposeChanges(m.cand, cfg);
      const fresh = changes.filter((ch) => ch.to !== cfg[ch.field]);
      if (impossible.length || !fresh.length) continue;
      if (!best || fresh.length < best.length) best = fresh;
    }
    blockers = matches[0]?.cand.failed ?? [];
    if (!best || round === MAX_ROUNDS) break;
    const next = { ...cfg };
    for (const ch of best) {
      (next as Record<string, number>)[ch.field] = ch.to;
      applied.set(ch.field, { ...ch, from: base.cfg[ch.field] as number });
    }
    cfg = next;
    await yieldToMain();
    if (signal?.aborted) return null;
  }
  return { changes: [], covered: false, viaKey: null, blockers, attempted: [...applied.values()] };
}

/** lineKeys the normal pipeline draws at the eval bar under `cfg`. */
export function drawnKeys(input: DebugRunInput, cfg: TrendlinesConfig): Set<string> {
  const st = buildTlState(input.bars, input.evalIdx + 1, cfg, input.startIdx);
  const i = input.evalIdx;
  const close = st.closes[i];
  const drawn = selectDrawnLines(poolable(st.lines, i, cfg), i, close, cfg.maxLines, {
    tol: mergeTolerance(cfg, st.atr[i], close),
    keep: new Set(),
    perPivot: cfg.maxPerPivot,
    pass: trendlineGate(i, close, st.atr[i], cfg),
  });
  return new Set(drawn.map((l) => lineKey(l, input.bars, input.starts)));
}

export async function sideEffects(
  base: DebugRunInput, next: TrendlinesConfig, signal?: AbortSignal,
): Promise<{ added: number; removed: number } | null> {
  await yieldToMain();
  if (signal?.aborted) return null;
  const before = drawnKeys(base, base.cfg);
  await yieldToMain();
  if (signal?.aborted) return null;
  const after = drawnKeys(base, next);
  let added = 0;
  let removed = 0;
  for (const k of after) if (!before.has(k)) added++;
  for (const k of before) if (!after.has(k)) removed++;
  return { added, removed };
}
