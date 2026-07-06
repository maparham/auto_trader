// Impure glue: read the focused cell's live on-chart indicators + drawings off its
// ChartController and turn each into a picker row (chartOperandSources). Kept thin
// and separate from the pure builder so the picker/tests never touch klinecharts.
import type { ChartController } from "./chartController";
import { indTypeOf } from "./indicators/shared";
import { chartOperandSources, type ChartOperandSource } from "./chartOperand";

export function enumerateChartOperands(controller: ChartController | null): ChartOperandSource[] {
  const chart = controller?.chart;
  if (!controller || !chart) return [];
  const out: ChartOperandSource[] = [];
  const panes = chart.getIndicatorByPaneId() as Map<string, Map<string, { name: string; calcParams?: unknown[]; extendData?: unknown }>> | null | undefined;
  if (panes) {
    for (const [paneId, inds] of panes) {
      for (const [name, ind] of inds) {
        out.push(chartOperandSources({
          kind: "indicator",
          id: name,
          paneId,
          indType: indTypeOf(ind),
          calcParams: (ind.calcParams ?? []).map(Number),
          extendData: ind.extendData,
        }));
      }
    }
  }
  const candles = chart.getDataList();
  for (const d of controller.overlays.listDrawings()) {
    out.push(chartOperandSources({ kind: "drawing", id: d.id, name: d.name, points: d.points, candles, text: d.text, color: d.color }));
  }
  return out;
}
