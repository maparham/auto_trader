// Rule Proximity Heatmap: paints each display bar with a translucent full-height
// column colored by how close the active entry rule group sits to firing on that
// bar (0 cold .. 1 firing). Figure-less overlay on the candle pane, mirroring
// timeHighlight.ts: `calc` stores per-bar closeness on indicator.result and
// `draw` paints in pure pixel space (returning true so klinecharts skips its
// default figure loop). The per-bar closeness arrives via extendData.values,
// aligned to dataList by index by the controller.
import {
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { heatAlpha, heatColor } from "../proximityHeatmap";

export interface ProximityHeatmapExtend {
  values?: (number | null)[]; // per display bar, aligned to dataList by index
}

export interface HeatmapPoint {
  v: number | null;
}

export function computeHeatmapPoints(
  dataList: KLineData[],
  ext: ProximityHeatmapExtend,
): HeatmapPoint[] {
  const values = ext.values ?? [];
  return dataList.map((_, i) => ({ v: i < values.length ? values[i] ?? null : null }));
}

function drawHeatmap(
  params: IndicatorDrawParams<HeatmapPoint, unknown, unknown>,
): boolean {
  const { ctx, chart, indicator, xAxis, bounding } = params;
  const barSpace = chart.getBarSpace();
  const points = indicator.result ?? [];
  const halfBar = barSpace.halfBar;
  const H = bounding.height;
  ctx.save();
  for (let i = 0; i < points.length; i++) {
    const v = points[i].v;
    if (v == null) continue;
    const a = heatAlpha(v);
    if (a <= 0) continue;
    const x = xAxis.convertToPixel(i);
    const left = x - halfBar;
    const width = halfBar * 2;
    if (width <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = heatColor(v);
    ctx.fillRect(left, 0, width, H);
  }
  ctx.restore();
  return true;
}

export const PROXIMITY_HEATMAP_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Rule Proximity",
  series: "price",
  precision: 0,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeHeatmapPoints(dataList, (ind.extendData ?? {}) as ProximityHeatmapExtend),
  draw: (params) =>
    drawHeatmap(params as IndicatorDrawParams<HeatmapPoint, unknown, unknown>),
};
