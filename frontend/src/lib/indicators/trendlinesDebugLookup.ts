// REVERSE LOOKUP: the user's own line against the debug result. "Covered"
// means the indicator draws a line visually very close to it (owner's rule,
// 2026-09-24), not one with the same anchors, so matching is by similarity:
// within `priceAtr` ATR(14) of it over its span, covering `spanPct` of it.
import { isPivotAt } from "./pivots";
import { lineStart, projectAt, type PivotKind, type TrendLine } from "./trendlines";
import type { ForcedPair } from "./trendlinesDebug";
import type { DebugCandidate, TlDebugResult } from "./trendlinesDebugExplain";

export interface TargetLine { t1: number; p1: number; t2: number; p2: number }
export interface TargetIdx { x1: number; p1: number; x2: number; p2: number }
export interface SimLimits { priceAtr: number; spanPct: number }
export const SIM_DEFAULTS: SimLimits = { priceAtr: 0.5, spanPct: 0.8 };

/** Nearest bar to `ts`, or -1 when it lies more than one bar outside the data. */
function nearestIdx(times: readonly number[], ts: number): number {
  const n = times.length;
  if (!n) return -1;
  const step = n > 1 ? times[n - 1] - times[n - 2] : 0;
  if (ts < times[0] - step || ts > times[n - 1] + step) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - ts) <= Math.abs(times[lo] - ts)) return lo - 1;
  return lo;
}

export function targetToIdx(times: readonly number[], t: TargetLine): TargetIdx | { error: string } {
  const a = nearestIdx(times, t.t1);
  const b = nearestIdx(times, t.t2);
  if (a < 0 || b < 0) return { error: "A point is outside the loaded bars." };
  if (a === b) return { error: "Pick two points on different bars." };
  return a < b ? { x1: a, p1: t.p1, x2: b, p2: t.p2 } : { x1: b, p1: t.p2, x2: a, p2: t.p1 };
}

const targetAt = (t: TargetIdx, x: number) => t.p1 + ((t.p2 - t.p1) * (x - t.x1)) / (t.x2 - t.x1);

/** Anchor choices near bar x: the bar itself (its extreme nearer `price`),
 * then fractal pivots at `pivotLen` within pivotLen bars, nearest first. */
function anchorsNear(
  highs: readonly number[], lows: readonly number[], x: number, price: number, pivotLen: number,
): Array<{ i: number; kind: PivotKind }> {
  const out: Array<{ i: number; kind: PivotKind }> = [
    { i: x, kind: Math.abs(highs[x] - price) <= Math.abs(lows[x] - price) ? "high" : "low" },
  ];
  for (let d = 1; d <= pivotLen && out.length < 3; d++) {
    for (const j of [x - d, x + d]) {
      if (j < 0 || j >= highs.length) continue;
      for (const kind of ["high", "low"] as const) {
        const vals = kind === "high" ? highs : lows;
        if (out.length < 3 && isPivotAt(vals, j, pivotLen, pivotLen, kind, true)) out.push({ i: j, kind });
      }
    }
  }
  return out;
}

/** The exact snapped pair first, then pairs of nearby pivots: at most 9. */
export function forcedPairsFor(
  highs: readonly number[], lows: readonly number[], tgt: TargetIdx, pivotLen: number,
): ForcedPair[] {
  const a = anchorsNear(highs, lows, tgt.x1, tgt.p1, pivotLen);
  const b = anchorsNear(highs, lows, tgt.x2, tgt.p2, pivotLen);
  const out: ForcedPair[] = [];
  for (const u of a)
    for (const v of b)
      if (u.i < v.i && out.length < 9) out.push({ i1: u.i, k1: u.kind, i2: v.i, k2: v.kind });
  return out;
}

/** Max deviation from the target in ATR(14), over the bars both exist, and
 * the fraction of the target's span the line covers. `end` is the last bar
 * the line is drawn to. Overlap starts at the line's DRAWN start
 * (lineStart: i0 when Extend Left moved it back, else i1) rather than i1,
 * since projectAt already extrapolates correctly from the i1/i2 anchors. */
export function similarity(
  tgt: TargetIdx, line: TrendLine, end: number, atr: ReadonlyArray<number | null>,
): { dev: number; cover: number } {
  const a = Math.max(tgt.x1, lineStart(line));
  const b = Math.min(tgt.x2, end);
  if (b <= a) return { dev: Infinity, cover: 0 };
  let dev = 0;
  for (let x = a; x <= b; x++) {
    const at = atr[x];
    if (at === null || !(at > 0)) continue;
    const d = Math.abs(projectAt(line, x) - targetAt(tgt, x)) / at;
    if (d > dev) dev = d;
  }
  return { dev, cover: (b - a) / (tgt.x2 - tgt.x1) };
}

export interface Match { cand: DebugCandidate; dev: number; cover: number }

export function lookup(
  res: TlDebugResult, tgt: TargetIdx, limits: SimLimits,
): { matches: Match[]; covered: Match | null } {
  const matches: Match[] = [];
  for (const cand of res.candidates) {
    const s = similarity(tgt, cand.line, cand.end, res.atr);
    if (s.dev <= limits.priceAtr && s.cover >= limits.spanPct) matches.push({ cand, ...s });
  }
  matches.sort((x, y) => x.dev - y.dev || y.cover - x.cover);
  return { matches, covered: matches.find((m) => m.cand.drawn) ?? null };
}
