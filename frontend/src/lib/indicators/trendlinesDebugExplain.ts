// Why is a candidate not on the chart? Every gate the pipeline applies, asked of
// one line at the eval bar, plus which stage 3 step (merge, per pivot, Max
// Trendlines) dropped a line that passed them all. The gate predicates are the
// detector's own exported functions; the measured numbers beside them are
// display values for the popup and the fix search.
import { isPivotAt } from "./pivots";
import {
  aboveSlope,
  addLevelPositions,
  hasBackClearance,
  hasSwingReach,
  isSignificantSwing,
  lineKey,
  lineStart,
  mergeTolerance,
  nearestFirst,
  pivotCapNeeded,
  poolable,
  projectAt,
  sameTrend,
  sideSign,
  swingStrength,
  trendlineGate,
  withinLookback,
  withinSlope,
  type PivotKind,
  type TrendLine,
} from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";
import type { DebugRecord, DebugRun, RejectedPivot } from "./trendlinesDebug";

export type Gate =
  | "unconfirmed" | "fractal" | "size" | "reach" | "window"
  | "lookback" | "slopeMax" | "slopeMin" | "backClearance" | "liveCap" | "stale"
  | "maxTouches" | "maxSpan" | "maxTouchSpacing" | "minTouchSpacing" | "maxCrossings"
  | "minTouches" | "minSpan" | "minCrossings" | "distanceAtr" | "distancePct"
  | "merged" | "perPivot" | "maxLines";

/** Pipeline order: the first failing gate in this order is the primary reason. */
export const GATE_ORDER: Gate[] = [
  "unconfirmed", "fractal", "size", "reach", "window",
  "lookback", "slopeMax", "slopeMin", "backClearance", "liveCap", "stale",
  "maxTouches", "maxSpan", "maxTouchSpacing", "minTouchSpacing", "maxCrossings",
  "minTouches", "minSpan", "minCrossings", "distanceAtr", "distancePct",
  "merged", "perPivot", "maxLines",
];

/** The strip's reason groups, one short word each. */
export const GATE_GROUP: Record<Gate, string> = {
  unconfirmed: "anchors", fractal: "anchors", size: "anchors", reach: "anchors", window: "anchors",
  lookback: "lookback", slopeMax: "slope", slopeMin: "slope", backClearance: "back clearance",
  liveCap: "live cap", stale: "projection",
  maxTouches: "touches", minTouches: "touches", maxSpan: "span", minSpan: "span",
  maxTouchSpacing: "spacing", minTouchSpacing: "spacing",
  maxCrossings: "crossings", minCrossings: "crossings",
  distanceAtr: "distance", distancePct: "distance",
  merged: "outranked", perPivot: "outranked", maxLines: "outranked",
};

export interface Verdict {
  gate: Gate;
  field: keyof TrendlinesConfig | null;
  measured: number | null;
  limit: number | null;
  pass: boolean;
  /** Anchor gates: which anchor (1 = left). */
  anchor?: 1 | 2;
  /** The setting is at its "no limit" value (0), so the gate is off. */
  off?: boolean;
}

/** Gates whose setting at 0 means no limit rather than a literal 0. */
const OFF_AT_ZERO: ReadonlySet<Gate> = new Set<Gate>([
  "lookback", "slopeMax", "slopeMin", "backClearance", "maxTouches", "maxSpan",
  "maxTouchSpacing", "minTouchSpacing", "maxCrossings", "minCrossings", "minSpan",
]);

export type Fate =
  | { kind: "drawn" }
  | { kind: "merged"; into: TrendLine; gap: number }
  | { kind: "perPivot"; need: number }
  | { kind: "maxLines"; rank: number };

export interface DebugCandidate {
  key: string;
  line: TrendLine;
  origin: "live" | DebugRecord["origin"];
  record: DebugRecord | null;
  verdicts: Verdict[];
  failed: Verdict[];
  fate: Fate | null;
  drawn: boolean;
  outranked: boolean;
  /** Last bar the debug layer draws it to. */
  end: number;
  /** |line - close| in ATR(14) at min(end, eval bar): the sampling rank. */
  dist: number;
  /** Among its reason group's DEBUG_SAMPLE nearest the price: painted even
   * when the group is not expanded (the strip's "(10 shown)"). */
  shown: boolean;
}

/** Candidates painted per reason group until the group is expanded. A group
 * of hundreds of lines is a wall no one can click; the nearest to the price
 * are the ones that matter. */
export const DEBUG_SAMPLE = 10;

/** The strip group a candidate is tallied under: its primary reason's group,
 * "drawn", or "passes" (a died/evicted/forced snapshot that fails nothing
 * now, which selection never actually outranked). */
export function groupOf(c: Pick<DebugCandidate, "drawn" | "failed">): string {
  return c.drawn ? "drawn" : c.failed.length ? GATE_GROUP[c.failed[0].gate] : "passes";
}

export interface TlDebugResult {
  evalIdx: number;
  close: number;
  atr: ReadonlyArray<number | null>;
  cfg: TrendlinesConfig;
  startIdx: number;
  highs: readonly number[];
  lows: readonly number[];
  candidates: DebugCandidate[];
  byKey: Map<string, DebugCandidate>;
  rejectedPivots: RejectedPivot[];
  /** Per reason group: how many, and how many of them are sampled. */
  counts: Array<{ group: string; n: number; shown: number }>;
  overflow: number;
  /** The gate-passing live lines at the eval bar (the what-if base). */
  passing: TrendLine[];
  keyOf: (l: TrendLine) => string;
}

/** selectLevels, walked to the end, recording each line's fate. Kept in step
 * with selectLevels by trendlinesDebugExplain.test.ts. */
export function explainSelection(
  ranked: readonly TrendLine[],
  atIdx: number,
  tol: number,
  maxPerPivot: number,
  maxLines: number,
): Map<TrendLine, Fate> {
  const leaders: TrendLine[] = [];
  const proj: number[] = [];
  const pos = new Map<number, Map<number, number>>();
  const fates = new Map<TrendLine, Fate>();
  let accepted = 0;
  for (const line of ranked) {
    const p = projectAt(line, atIdx);
    const into =
      tol > 0
        ? leaders.findIndex((g, idx) => Math.abs(proj[idx] - p) <= tol && sameTrend(g, line, atIdx, tol))
        : -1;
    if (into >= 0) {
      const g = leaders[into];
      // Mirrors sameTrend's own stretch: from the bar the YOUNGER line
      // starts (lineStart, not i1 -- Extend Left can move that back) to atIdx.
      const start = Math.max(lineStart(g), lineStart(line));
      const gap = Math.max(
        Math.abs(projectAt(g, atIdx) - p),
        Math.abs(projectAt(g, start) - projectAt(line, start)),
      );
      fates.set(line, { kind: "merged", into: g, gap });
      continue;
    }
    const lvl = leaders.length;
    leaders.push(line);
    proj.push(p);
    addLevelPositions(pos, line, lvl);
    if (maxPerPivot >= 1) {
      const need = pivotCapNeeded(line, pos, lvl);
      if (need > maxPerPivot) {
        fates.set(line, { kind: "perPivot", need });
        continue;
      }
    }
    accepted++;
    fates.set(line, maxLines > 0 && accepted > maxLines ? { kind: "maxLines", rank: accepted } : { kind: "drawn" });
  }
  return fates;
}

/** Largest fractal length in 1..cap at which bar k is a strict pivot of
 * `kind`; 0 when none. */
export function maxFractalLen(vals: readonly number[], k: number, kind: PivotKind, cap: number): number {
  for (let L = cap; L >= 1; L--) if (isPivotAt(vals, k, L, L, kind, true)) return L;
  return 0;
}

/** Bars bar k dominates to its left, consecutively, up to `cap`. */
export function leftReach(vals: readonly number[], k: number, kind: PivotKind, cap: number): number {
  let n = 0;
  for (let j = k - 1; j >= 0 && n < cap; j--) {
    if (kind === "high" ? vals[j] >= vals[k] : vals[j] <= vals[k]) break;
    n++;
  }
  return n;
}

/** Bars before i1 whose closes stay on one side of the line's backward
 * extension, up to `cap` (never below the compute floor). */
export function backClearBars(line: TrendLine, closes: readonly number[], startIdx: number, cap: number): number {
  let last = 0;
  let b = 0;
  for (let j = line.i1 - 1; j >= Math.max(startIdx, line.i1 - cap); j--) {
    const s = sideSign(line, j, closes[j]);
    if (s !== 0) {
      if (last !== 0 && s !== last) break;
      last = s;
    }
    b++;
  }
  return b;
}

function anchorVerdicts(rec: DebugRecord, run: DebugRun): Verdict[] {
  const f = rec.forced;
  if (!f) return [];
  const { st, input } = run;
  const cfg = input.cfg;
  const out: Verdict[] = [];
  if (f.unconfirmed)
    out.push({
      gate: "unconfirmed", field: "pivotLen", measured: input.evalIdx - f.i2,
      limit: cfg.pivotLen, pass: false, anchor: 2,
    });
  const anchors: Array<[1 | 2, number, PivotKind]> = [[1, f.i1, f.k1], [2, f.i2, f.k2]];
  for (const [n, idx, kind] of anchors) {
    const vals = kind === "high" ? st.highs : st.lows;
    const isFrac = isPivotAt(vals, idx, cfg.pivotLen, cfg.pivotLen, kind, true);
    out.push({
      gate: "fractal", field: "pivotLen", anchor: n, limit: cfg.pivotLen, pass: isFrac,
      measured: isFrac ? cfg.pivotLen : maxFractalLen(vals, idx, kind, cfg.pivotLen - 1) || null,
    });
    if (cfg.minSwingAtr > 0) {
      const opposite = st.turns[kind === "high" ? "low" : "high"];
      const atrK = st.atr[idx];
      out.push({
        gate: "size", field: "minSwingAtr", anchor: n, limit: cfg.minSwingAtr,
        measured: swingStrength(st.highs, st.lows, opposite, idx, kind, atrK),
        pass: atrK !== null && isSignificantSwing(st.highs, st.lows, opposite, idx, kind, atrK, cfg.minSwingAtr),
      });
    }
    if (cfg.minSwingReach > 0)
      out.push({
        gate: "reach", field: "minSwingReach", anchor: n, limit: cfg.minSwingReach,
        measured: leftReach(vals, idx, kind, cfg.minSwingReach),
        pass: hasSwingReach(vals, idx, kind, cfg.minSwingReach),
      });
  }
  if (f.poolGap !== null)
    out.push({
      gate: "window", field: "pairPivots", measured: f.poolGap, limit: cfg.pairPivots,
      pass: f.inMajor || f.poolGap <= cfg.pairPivots,
    });
  return out;
}

/** The close a run is measured at when the caller names none: the draw's
 * (input.evalClose), else the eval bar's own. */
export const evalCloseOf = (run: DebugRun): number => run.input.evalClose ?? run.st.closes[run.input.evalIdx];

/** Every per-line gate for `line` at the run's eval bar, pass and fail,
 * with the distance gates measured against `close`. */
export function lineVerdicts(
  line: TrendLine, rec: DebugRecord | null, run: DebugRun, close: number = evalCloseOf(run),
): Verdict[] {
  const { st, input } = run;
  const cfg = input.cfg;
  const i = input.evalIdx;
  const v: Verdict[] = rec ? anchorVerdicts(rec, run) : [];
  const add = (gate: Gate, field: keyof TrendlinesConfig | null, measured: number | null, limit: number | null, pass: boolean) =>
    v.push(limit === 0 && OFF_AT_ZERO.has(gate)
      ? { gate, field, measured, limit, pass, off: true }
      : { gate, field, measured, limit, pass });
  // lineStart, not i1: isLive/isMajor/overCeilings all read a line's start
  // through lineStart (Extend Left can move it back past i1).
  const start = lineStart(line);
  const span = line.lastTouchIdx - start;
  add("lookback", "lookbackBars", i - start, cfg.lookbackBars, withinLookback(start, i, cfg));
  const atrK = st.atr[line.i2];
  if (atrK !== null) {
    // withinSlope/aboveSlope are cross-multiplied and hold at atrK === 0 (the
    // detector still applies them there); the ratio itself is only
    // meaningful, and only computed, once atrK is positive.
    const slope = atrK > 0 ? (line.p2 - line.p1) / ((line.i2 - line.i1) * atrK) : null;
    add("slopeMax", "maxSlopeAtr", slope, cfg.maxSlopeAtr, withinSlope(line, atrK, cfg.maxSlopeAtr));
    add("slopeMin", "minSlopeAtr", slope, cfg.minSlopeAtr, aboveSlope(line, atrK, cfg.minSlopeAtr));
  }
  add(
    "backClearance", "minBackBars",
    backClearBars(line, st.closes, st.startIdx, cfg.minBackBars), cfg.minBackBars,
    hasBackClearance(line, st.closes, st.startIdx, cfg.minBackBars),
  );
  if (rec?.origin === "evicted") add("liveCap", null, null, null, false);
  add("stale", "maxProjBars", i - line.lastTouchIdx, cfg.maxProjBars, i - line.lastTouchIdx <= cfg.maxProjBars);
  add("maxTouches", "maxTouches", line.touches, cfg.maxTouches, !(cfg.maxTouches > 0 && line.touches > cfg.maxTouches));
  add("maxSpan", "maxSpanBars", span, cfg.maxSpanBars, !(cfg.maxSpanBars > 0 && span > cfg.maxSpanBars));
  add("maxTouchSpacing", "maxTouchSpacing", line.maxTouchGap, cfg.maxTouchSpacing,
    !(cfg.maxTouchSpacing > 0 && line.maxTouchGap > cfg.maxTouchSpacing));
  add("minTouchSpacing", "minTouchSpacing", Number.isFinite(line.minTouchGap) ? line.minTouchGap : null,
    cfg.minTouchSpacing, !(cfg.minTouchSpacing > 0 && line.minTouchGap < cfg.minTouchSpacing));
  add("maxCrossings", "maxCrossings", line.crossings, cfg.maxCrossings, !(cfg.maxCrossings > 0 && line.crossings > cfg.maxCrossings));
  add("minTouches", "minTouches", line.touches, cfg.minTouches, line.touches >= cfg.minTouches);
  add("minSpan", "minSpanBars", span, cfg.minSpanBars, span >= cfg.minSpanBars);
  add("minCrossings", "minCrossings", line.crossings, cfg.minCrossings, line.crossings >= cfg.minCrossings);
  const d = Math.abs(projectAt(line, i) - close);
  const atrI = st.atr[i];
  // maxDistanceTol applies the ATR ceiling whenever atrI is a finite number,
  // even 0 (tol collapses to 0 there); only the displayed ratio needs atrI > 0.
  if (cfg.maxDistAtr > 0 && atrI !== null)
    add("distanceAtr", "maxDistAtr", atrI > 0 ? d / atrI : null, cfg.maxDistAtr, d <= cfg.maxDistAtr * atrI);
  if (cfg.maxDistPct > 0)
    add("distancePct", "maxDistPct", (d / Math.abs(close)) * 100, cfg.maxDistPct, d <= Math.abs(close) * (cfg.maxDistPct / 100));
  return v;
}

function fateVerdict(f: Fate, cfg: TrendlinesConfig, atrI: number | null, close: number): Verdict | null {
  if (f.kind === "merged") {
    const useAtr = cfg.mergeAtr > 0 && atrI !== null && atrI > 0;
    return useAtr
      ? { gate: "merged", field: "mergeAtr", measured: f.gap / (atrI as number), limit: cfg.mergeAtr, pass: false }
      : { gate: "merged", field: "mergePct", measured: (f.gap / Math.abs(close)) * 100, limit: cfg.mergePct, pass: false };
  }
  if (f.kind === "perPivot")
    return { gate: "perPivot", field: "maxPerPivot", measured: f.need, limit: cfg.maxPerPivot, pass: false };
  if (f.kind === "maxLines")
    return { gate: "maxLines", field: "maxLines", measured: f.rank, limit: cfg.maxLines, pass: false };
  return null;
}

const byOrder = (a: Verdict, b: Verdict) => GATE_ORDER.indexOf(a.gate) - GATE_ORDER.indexOf(b.gate);

/** `close` is what the gates, the ranking and the merge measure at; the
 * store passes the draw's newest one so a new tick re-explains the same run. */
export function explain(run: DebugRun, close: number = evalCloseOf(run)): TlDebugResult {
  const { st, input } = run;
  const cfg = input.cfg;
  const i = input.evalIdx;
  const [lo, hi] = input.window;
  const keyOf = (l: TrendLine) => lineKey(l, input.bars, input.starts);
  const atrI = st.atr[i];
  const passing = poolable(st.lines, i, cfg).filter(trendlineGate(i, close, st.atr[i], cfg));
  const ranked = nearestFirst(passing, i, close);
  const fates = explainSelection(ranked, i, mergeTolerance(cfg, st.atr[i], close), cfg.maxPerPivot, cfg.maxLines);
  const candidates: DebugCandidate[] = [];
  const byKey = new Map<string, DebugCandidate>();
  const push = (line: TrendLine, rec: DebugRecord | null) => {
    const key = keyOf(line);
    if (byKey.has(key)) return;
    const end = rec?.endedAt ?? i;
    if (line.i1 > hi || end < lo) return;
    const verdicts = lineVerdicts(line, rec, run, close);
    const fate = rec ? null : (fates.get(line) ?? null);
    const fv = fate ? fateVerdict(fate, cfg, st.atr[i], close) : null;
    if (fv) verdicts.push(fv);
    const failed = verdicts.filter((v) => !v.pass).sort(byOrder);
    // A seed reject's PRIMARY reason is the gate the seeder actually deleted
    // it for, at seed time. At the eval bar it can ALSO fail a later-pipeline
    // gate (Lookback most often, since it only ages), which byOrder would
    // otherwise sort ahead of the seed gate. Lead with the seed's own gate.
    if (rec?.seedGate) {
      const idx = failed.findIndex((v) => v.gate === rec.seedGate);
      if (idx > 0) failed.unshift(failed.splice(idx, 1)[0]);
    }
    const drawn = fate?.kind === "drawn";
    const d = Math.abs(projectAt(line, Math.min(end, i)) - close);
    const c: DebugCandidate = {
      key, line, origin: rec ? rec.origin : "live", record: rec, verdicts, failed, fate, drawn,
      outranked: !!fv && failed.length === 1, end, dist: atrI !== null && atrI > 0 ? d / atrI : d, shown: true,
    };
    candidates.push(c);
    byKey.set(key, c);
  };
  for (const line of st.lines) push(line, null);
  for (const rec of run.records) if (rec.origin !== "forced") push(rec.line, rec);
  // Forced last: push() dedupes by lineKey, so a forced pair that lands on
  // the SAME anchors as an already-live line is represented by that live
  // candidate, not a separate "forced" one.
  for (const rec of run.records) if (rec.origin === "forced") push(rec.line, rec);
  // Sampling: rank each group nearest the price first and flag the first
  // DEBUG_SAMPLE. Once per explain, never per paint (chart draw perf rule).
  const groups = new Map<string, DebugCandidate[]>();
  for (const c of candidates) {
    const g = groupOf(c);
    const list = groups.get(g);
    if (list) list.push(c);
    else groups.set(g, [c]);
  }
  for (const list of groups.values()) {
    if (list.length <= DEBUG_SAMPLE) continue;
    list.sort((a, b) => a.dist - b.dist);
    for (let n = DEBUG_SAMPLE; n < list.length; n++) list[n].shown = false;
  }
  return {
    evalIdx: i, close, atr: st.atr, cfg, startIdx: st.startIdx, highs: st.highs, lows: st.lows,
    candidates, byKey, rejectedPivots: run.rejectedPivots,
    counts: [...groups].map(([group, list]) => ({ group, n: list.length, shown: Math.min(list.length, DEBUG_SAMPLE) })).sort((a, b) => (a.group === "drawn" ? -1 : b.group === "drawn" ? 1 : b.n - a.n)),
    overflow: run.overflow, passing, keyOf,
  };
}

/** The fate `line` WOULD get if it were live and passing at the eval bar:
 * the popup's answer for a recorded line that passes every per-line gate. */
export function whatIfFate(res: TlDebugResult, line: TrendLine): Fate {
  const i = res.evalIdx;
  const ranked = nearestFirst([...res.passing, line], i, res.close);
  const fates = explainSelection(
    ranked, i, mergeTolerance(res.cfg, res.atr[i], res.close), res.cfg.maxPerPivot, res.cfg.maxLines,
  );
  return fates.get(line) ?? { kind: "drawn" };
}
