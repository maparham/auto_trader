// trendlines_explain_line: whether a Trendlines pane draws a given line, what
// blocks it, and the smallest VERIFIED settings change that would draw it.
// A thin adapter over the pane's own debug tooling (trendlinesDebug*), run on
// the bars the pane computes on (a timeframe pin's stashed bars included) and
// judged at the chart's latest close, as the draw is.
import type { Chart, KLineData } from "klinecharts";
import { getIndicatorsByPane, liveExprInstances } from "../lib/indicators";
import {
  trendlinesHtfBars,
  type TrendlinesCalcPoint,
  type TrendlinesExtend,
} from "../lib/indicators/trendlines";
import { parseTrendlinesConfig, type TrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import { runDebugAsync, type DebugRunInput } from "../lib/indicators/trendlinesDebug";
import { explain, type Verdict } from "../lib/indicators/trendlinesDebugExplain";
import { forcedPairsFor, lookup, SIM_DEFAULTS, targetToIdx, type TargetLine } from "../lib/indicators/trendlinesDebugLookup";
import { findFix, sideEffects } from "../lib/indicators/trendlinesDebugFix";
import { debugInputFor } from "../lib/indicators/trendlinesDebugStore";
import { describeIndicator } from "./describe";

export interface ExplainDeps {
  chart: Chart;
  /** A drawing's points by id, or null when there is no such drawing. */
  drawingPoints: (id: string) => Array<{ timestamp?: number; value?: number }> | null;
}

export interface SettingOut { key: string; label: string; from: number; to: number }
export interface BlockOut { setting: string | null; key: string | null; measured: number | null; limit: number | null; gate: string }

export interface ExplainOut {
  id: string;
  drawn: boolean;
  /** Why the closest matching candidate is not drawn now (empty when drawn
   * or when nothing like the line exists at all). */
  blockedBy: BlockOut[];
  /** True when no candidate line comes close to the target: the pane never
   * paired pivots along it at these settings. */
  noCandidate: boolean;
  /** VERIFIED settings change that draws it, with what else it changes on
   * the chart; null when none was found. */
  fix: { changes: SettingOut[]; alsoAdds: number; alsoRemoves: number } | null;
  /** Unverified guess, only when no fix was verified. */
  attempted?: SettingOut[];
}

const round = (v: number | null) => (v === null || !Number.isFinite(v) ? v : Number(v.toFixed(4)));

/** The pane's setting key and label for a config field, as describe_indicator
 * and indicator_configure name it. */
function settingOf(field: keyof TrendlinesConfig): { key: string; label: string } | null {
  const slot = (Object.keys(parseTrendlinesConfig([])) as (keyof TrendlinesConfig)[]).indexOf(field);
  const input = describeIndicator("TRENDLINES").inputs.find((i) => i.source === "calcParam" && i.index === slot);
  return input ? { key: input.key, label: input.label } : null;
}

function blockOf(v: Verdict): BlockOut {
  const s = v.field ? settingOf(v.field) : null;
  return { gate: v.gate, setting: s?.label ?? null, key: s?.key ?? null, measured: round(v.measured), limit: round(v.limit) };
}

function changesOut(changes: Array<{ field: keyof TrendlinesConfig; from: number; to: number }>): SettingOut[] {
  return changes.map((c) => {
    const s = settingOf(c.field);
    return { key: s?.key ?? String(c.field), label: s?.label ?? String(c.field), from: c.from, to: c.to };
  });
}

function targetOf(input: Record<string, unknown>, deps: ExplainDeps): TargetLine | string {
  if (typeof input.drawingId === "string" && input.drawingId) {
    const pts = deps.drawingPoints(input.drawingId);
    if (!pts) return `NOT_FOUND: no drawing with id ${input.drawingId}`;
    const [a, b] = pts;
    if (!a || !b || ![a.timestamp, a.value, b.timestamp, b.value].every((x) => typeof x === "number" && Number.isFinite(x)))
      return "INVALID_ARGS: the drawing needs two points with a time and a price";
    const [p, q] = a.timestamp! <= b.timestamp! ? [a, b] : [b, a];
    return { t1: p.timestamp!, p1: p.value!, t2: q.timestamp!, p2: q.value! };
  }
  const n = ["t1", "p1", "t2", "p2"].map((k) => Number(input[k]));
  if (!n.every(Number.isFinite)) return "INVALID_ARGS: pass drawingId, or t1, p1, t2, p2 (ms and prices)";
  const [t1, p1, t2, p2] = n;
  return t1 <= t2 ? { t1, p1, t2, p2 } : { t1: t2, p1: p2, t2: t1, p2: p1 };
}

export async function explainTrendline(
  input: Record<string, unknown>, deps: ExplainDeps, signal?: AbortSignal,
): Promise<{ out: ExplainOut } | { error: string }> {
  const id = String(input.id ?? "");
  type Ind = { name: string; calcParams?: unknown; extendData?: unknown; result?: unknown[] };
  let ind: Ind | null = null;
  for (const inds of getIndicatorsByPane(deps.chart).values()) {
    const hit = inds.get(id);
    if (hit) { ind = hit as unknown as Ind; break; }
  }
  if (!ind) return { error: `NOT_FOUND: no indicator with id ${id}` };
  const ext = ind.extendData as TrendlinesExtend | undefined;
  if (liveExprInstances(deps.chart).find((i) => i.id === id)?.type !== "TRENDLINES")
    return { error: `INVALID_ARGS: ${id} is not a Trendlines indicator` };
  const target = targetOf(input, deps);
  if (typeof target === "string") return { error: target };

  const dataList: KLineData[] = deps.chart.getDataList();
  if (!dataList.length) return { error: "NO_DATA: no bars loaded" };
  const cfg = parseTrendlinesConfig(ind.calcParams, ind.extendData);
  const mtf = ext?.mtf?.timeframe ? ext.mtf : undefined;
  const result = (ind.result ?? []) as TrendlinesCalcPoint[];
  const last = result[result.length - 1];
  const lastIdx = mtf ? (last?.lineIdx ?? -1) : dataList.length - 1;
  if (lastIdx < 0) return { error: "NOT_READY: the pinned timeframe has no closed bar yet" };
  const dext = mtf
    ? { ...ext, mtf: { ...mtf, htfBars: trendlinesHtfBars(deps.chart, ind.name, mtf.htfStarts) } }
    : ext;
  const base = debugInputFor(dataList, cfg, dext, lastIdx, [0, lastIdx], dataList[dataList.length - 1].close);
  if ("error" in base) return { error: `NOT_READY: ${base.error}` };
  const full: DebugRunInput = { ...base, window: [0, base.evalIdx] };

  // Now: the closest candidate along the target and what blocks it.
  const times = (full.starts ?? full.bars.map((b) => b.timestamp)).slice(0, full.evalIdx + 1);
  const tgt = targetToIdx(times, target, full.starts ? "containing" : "nearest");
  if ("error" in tgt) return { error: `INVALID_ARGS: ${tgt.error}` };
  const highs = full.bars.map((b) => b.high);
  const lows = full.bars.map((b) => b.low);
  const run = await runDebugAsync(
    { ...full, window: [tgt.x1, full.evalIdx], forced: forcedPairsFor(highs, lows, tgt, cfg.pivotLen) },
    signal,
  );
  if (!run) return { error: "ABORTED" };
  const { matches, covered } = lookup(explain(run), tgt, SIM_DEFAULTS);
  const out: ExplainOut = {
    id,
    drawn: !!covered,
    blockedBy: covered ? [] : (matches[0]?.cand.failed ?? []).map(blockOf),
    noCandidate: !covered && matches.length === 0,
    fix: null,
  };
  if (covered) return { out };

  const fix = await findFix(full, target, SIM_DEFAULTS, signal);
  if (!fix) return { error: "ABORTED" };
  if (fix.error) return { error: `INVALID_ARGS: ${fix.error}` };
  if (fix.covered && fix.changes.length) {
    const next = { ...cfg };
    for (const c of fix.changes) (next as Record<string, number>)[c.field] = c.to;
    const fx = await sideEffects(full, next, signal);
    if (!fx) return { error: "ABORTED" };
    // The target itself is one of the added lines.
    out.fix = { changes: changesOut(fix.changes), alsoAdds: Math.max(0, fx.added - 1), alsoRemoves: fx.removed };
  } else if (fix.attempted.length) {
    out.attempted = changesOut(fix.attempted);
  }
  return { out };
}
