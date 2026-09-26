// Hit targets for indicators that paint their own lines. With no line
// figures they add nothing to the chart's line cache, so the draw records
// each stroke as painted and the chart's hover / click / double-click read
// them back here. Trendlines keeps a richer registry of its own (per-line
// keys and clones for its line menu, in trendlineMarks.ts).
import { distToSegment } from "./trendlineMarks";

/** One stroke as DRAWN, pane-relative pixels. */
export interface PaintedLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ChartLike {
  getIndicators: (filter: { paneId: string; name: string }) => Array<{ visible?: boolean }>;
}

/** Per chart, then "paneId:name". */
const LINES = new WeakMap<object, Map<string, readonly PaintedLine[]>>();

export function setPaintedLines(
  chart: object,
  paneId: string,
  name: string,
  lines: readonly PaintedLine[] | null,
): void {
  let byPane = LINES.get(chart);
  if (!byPane) {
    if (lines === null) return;
    byPane = new Map();
    LINES.set(chart, byPane);
  }
  if (lines === null) byPane.delete(`${paneId}:${name}`);
  else byPane.set(`${paneId}:${name}`, lines);
}

export function dropPaintedLines(chart: object, name: string): void {
  const byPane = LINES.get(chart);
  if (!byPane) return;
  for (const key of [...byPane.keys()])
    if (key.slice(key.indexOf(":") + 1) === name) byPane.delete(key);
}

/** The instance whose painted line is nearest (px, py) within `slop`.
 * Candle pane only, like hitTrendline: the recorded pixels are pane-relative
 * and callers hand in container-relative points, which agree only for the
 * topmost pane. A hidden instance is skipped: klinecharts stops calling its
 * draw, so its last frame stays recorded. */
export function hitPaintedLine(
  chart: ChartLike,
  px: number,
  py: number,
  slop: number,
): { paneId: string; name: string } | null {
  const byPane = LINES.get(chart);
  if (!byPane) return null;
  let best: { paneId: string; name: string; d: number } | null = null;
  for (const [k, lines] of byPane) {
    const cut = k.indexOf(":");
    const paneId = k.slice(0, cut);
    if (paneId !== "candle_pane") continue;
    const name = k.slice(cut + 1);
    let d = Infinity;
    for (const l of lines) d = Math.min(d, distToSegment(px, py, l.x0, l.y0, l.x1, l.y1));
    if (d > slop || (best && best.d <= d)) continue;
    const ind = chart.getIndicators({ paneId, name })[0];
    if (!ind || ind.visible === false) continue;
    best = { paneId, name, d };
  }
  return best ? { paneId: best.paneId, name: best.name } : null;
}
