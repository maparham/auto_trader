// A screen's own copy of the chart panes its expressions reference. The copy
// wins for every id it holds; the active chart only supplies ids the copy
// lacks, so a saved screen applies the settings it was saved with whatever
// chart is focused. "Refresh from chart" is the one way a copied pane changes.
import type { ExprInstance } from "./expr/catalog";
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
 * Timeframe-pinned panes are dropped: screens refuse them, so the editor
 * should flag them as unknown instead of accepting them. */
export function editorInstances(copy: PaneCopy, chart: readonly ExprInstance[]): ExprInstance[] {
  const own = exprInstancesFor(copyAsLive(copy));
  const ids = new Set(own.map((i) => i.id));
  return [...own, ...chart.filter((i) => !ids.has(i.id))].filter((i) => i.timeframe == null);
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

/** One short label per copied pane, e.g. "RSI (14)", or "RSI (14), RSI 14 ·
 * pivots 5/5 · divergence fires 5 bars after pivot" when the pane's own
 * `ExprInstance.detail` (exprInstances.ts) says more than the id and params
 * can, e.g. whether divergence is configured. Panes with no detail (or
 * whose type isn't one `exprInstancesFor` recognizes) keep the plain form. */
export function paneLabels(copy: PaneCopy): string[] {
  const details = new Map(exprInstancesFor(copyAsLive(copy)).map((i) => [i.id, i.detail] as const));
  return Object.entries(copy).map(([id, p]) => {
    const base = p.calcParams.length ? `${id} (${p.calcParams.join(", ")})` : id;
    const detail = details.get(id);
    return detail ? `${base}, ${detail}` : base;
  });
}
