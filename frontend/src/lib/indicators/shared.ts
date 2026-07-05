// Cross-indicator plumbing shared by every custom-indicator module: the legend
// tooltip source, the indicator-type resolver, and the FULL SmoothLineStyle helper
// their default styles are built from.
import {
  LineType,
  type Indicator,
  type IndicatorTooltipData,
  type SmoothLineStyle,
} from "klinecharts";

// The real indicator TYPE (EMA/MA/AVWAP/RSI/…). For multi-instance indicators the
// klinecharts `name` is a unique per-instance id (e.g. "EMA#a1b2"); the type lives
// in extendData.indType. Built-ins added straight by klinecharts name (RSI/MACD)
// have no indType, so fall back to the name. This is THE function to branch on
// anywhere logic used to compare `ind.name === 'EMA'` etc.
export function indTypeOf(
  ind: { name: string; extendData?: unknown } | Indicator,
): string {
  const t = (ind.extendData as { indType?: string } | undefined)?.indType;
  return typeof t === "string" && t ? t : ind.name;
}

// Per-indicator legend behavior, attached to every indicator at creation
// (Toolbar.createIndicatorOn). klinecharts only exposes per-indicator legend
// control through this hook.
//
// EVERY indicator's legend is now crisp DOM (<ChartLegend> for the candle pane,
// <SubPaneLegend> for Volume/MACD/RSI/etc.), so the canvas draws no legend for any
// of them. Returning empty name + values makes klinecharts skip the whole tooltip
// row (IndicatorTooltipView.drawIndicatorTooltip), avoiding a blurry duplicate.
export function legendTooltipSource(): IndicatorTooltipData {
  return { name: "", calcParamsText: "", values: [], icons: [] } as IndicatorTooltipData;
}

// FULL SmoothLineStyle entries — klinecharts' line drawer reads style/smooth/
// dashedValue, so a partial entry crashes it (the same trap the settings modal's
// lineOverrides guards against). Every indicator's default line styles are built
// from this helper.
export const fullLine = (color: string, style: LineType): SmoothLineStyle => ({
  style,
  size: 1,
  color,
  dashedValue: [3, 3],
  smooth: false,
});
