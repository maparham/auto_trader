// A screen's own copy of the chart panes its expressions reference. The copy
// wins for every id it holds; the active chart only supplies ids the copy
// lacks, so a saved screen applies the settings it was saved with whatever
// chart is focused. "Refresh from chart" is the one way a copied pane changes.
import { tfSeconds, type ExprInstance } from "./expr/catalog";
import { tfSecondsOf } from "./timeframe";
import {
  collectExprInstances,
  exprInstancesFor,
  type ExprInstancePayload,
  type LiveInstance,
} from "./exprInstances";

export type PaneCopy = Record<string, ExprInstancePayload>;

export function copyAsLive(copy: PaneCopy): LiveInstance[] {
  return Object.entries(copy).map(([id, p]) => ({
    id,
    type: p.type,
    calcParams: p.calcParams,
    extendData: p.extendData,
  }));
}

/** The editor's list: the copy's panes, then chart panes the copy lacks.
 * A pane pinned in its settings stays only when its pin is the screen's
 * timeframe or coarser: screens refuse finer pins, so the editor should
 * flag such a ref as unknown instead of accepting it and failing on Run.
 * A pin tfSeconds cannot read is dropped for the same reason, and so is a
 * chart-only pane (Trendlines), which screens refuse. */
export function editorInstances(copy: PaneCopy, chart: readonly ExprInstance[], resolution: string): ExprInstance[] {
  const own = exprInstancesFor(copyAsLive(copy));
  const ids = new Set(own.map((i) => i.id));
  const baseS = tfSecondsOf(resolution) ?? 0;
  const ok = (i: ExprInstance) => {
    if (i.chartOnly) return false;
    if (i.timeframe == null) return true;
    const s = tfSeconds(i.timeframe);
    return s != null && s >= baseS;
  };
  return [...own, ...chart.filter((i) => !ids.has(i.id))].filter(ok);
}

/** The request's `indicators` map, which also becomes the new copy. */
export function screenPayload(
  copy: PaneCopy,
  chartLive: readonly LiveInstance[],
  exprs: string[],
): PaneCopy {
  const list = [...copyAsLive(copy), ...chartLive.filter((i) => !(i.id in copy))];
  return collectExprInstances(list, exprs);
}

export function refreshFromChart(copy: PaneCopy, chartLive: readonly LiveInstance[]): PaneCopy {
  const out: PaneCopy = { ...copy };
  for (const inst of chartLive) {
    if (!(inst.id in copy)) continue;
    out[inst.id] = {
      type: inst.type,
      calcParams: inst.calcParams ?? [],
      extendData: inst.extendData ?? {},
    };
  }
  return out;
}

/** One short label per copied pane: the id and the pane's own
 * `ExprInstance.detail` (exprInstances.ts), e.g. "RSI · length 14 · pivots
 * 5/5 · divergence on". The detail already says what the settings mean, so
 * the raw params are not restated beside it. A pane with no detail (a type
 * `exprInstancesFor` does not recognize) falls back to "<id> (<params>)". */
export function paneLabels(copy: PaneCopy): string[] {
  const known = new Map(exprInstancesFor(copyAsLive(copy)).map((i) => [i.id, i] as const));
  return Object.entries(copy).map(([id, p]) => {
    const inst = known.get(id);
    // The pin rides on the id ("FVG @W"): the detail line does not carry it.
    if (inst?.detail) return `${id}${inst.timeframe ? ` @${inst.timeframe}` : ""} · ${inst.detail}`;
    return p.calcParams.length ? `${id} (${p.calcParams.join(", ")})` : id;
  });
}
