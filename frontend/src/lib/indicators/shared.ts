// Cross-indicator plumbing shared by every custom-indicator module: the legend
// tooltip source, the indicator-type resolver, and the FULL SmoothLineStyle helper
// their default styles are built from.
// Fully type-only (`import type`, not `{ type ... }`): the specifier form
// keeps a runtime import of klinecharts, which breaks every node-side test
// that imports this module without mocking klinecharts' window access.
import type {
  LineType,
  Indicator,
  IndicatorTooltipData,
  SmoothLineStyle,
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
  return { name: "", calcParamsText: "", legends: [], features: [] };
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

/** How far past a pane a stroke may run before it must be clipped. Generous on
 * purpose: normal overshoots (a few thousand px) rasterize for free and keep
 * dash phase / joins byte-identical, while the pathological ones — an MTF
 * projection converting to millions of pixels — never reach Skia. */
export const DRAW_CLIP_PAD = 2000;

/** Liang-Barsky clip of the segment (x0,y0)-(x1,y1) to the rectangle
 * [xMin,xMax]x[yMin,yMax]; null when they don't intersect.
 *
 * Draw paths MUST clip strokes whose endpoints can run far off-pane (an MTF
 * pin converts higher-timeframe indices/prices to coordinates millions of
 * pixels out; dashed strokes are worst, since dash generation walks the full
 * geometric length). Stroking such paths every frame dropped pan/zoom to
 * ~20fps, with all the time in compositor Commit — invisible to JS profiles.
 * The segment is straight, so clipping is visually exact. */
export function clipSegmentToRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  // One edge per iteration: p is the direction against the edge, q the
  // distance to it; p === 0 means parallel (reject iff outside).
  const edges: Array<[number, number]> = [
    [-dx, x0 - xMin],
    [dx, xMax - x0],
    [-dy, y0 - yMin],
    [dy, yMax - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}
