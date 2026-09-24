// Per-line user marks on TRENDLINES: Hide (dimmed to a hairline), Highlight
// (bolder than the instance's style), plus the session-only selection and the
// line-body hit targets the right-click / long-press menu reads.
//
// A LEAF with no runtime imports, so the draw path, ChartCore and the tests can
// all pull it in without klinecharts' runtime.
//
// Marks are RENDER-ONLY. They never reach parseTrendlinesConfig, never change
// which lines are selected for drawing (the chart still draws exactly what an
// operand reads), and only restyle a line that is drawn anyway. They persist in
// the saved indicator config (extendData.lineMarks), which the backend mirrors,
// so they follow the user across reloads and devices. Keyed by EPIC first:
// lineKey is two anchor timestamps, and two symbols share bar timestamps, so a
// bare key would restyle a different symbol's line that happens to share them.

export interface LineMarks {
  hidden?: string[];
  bold?: string[];
}
export type LineMarksByEpic = Record<string, LineMarks>;
export type LineMarkKind = keyof LineMarks;

/** Opacity of a hidden line: there, but barely. */
export const TL_HIDDEN_ALPHA = 0.15;
/** Pixels a highlighted line gains over the instance's own line width. */
export const TL_BOLD_EXTRA = 2;
/** Extra pixels of the translucent under-stroke that marks the selected line. */
export const TL_SELECT_GLOW = 6;
export const TL_SELECT_GLOW_ALPHA = 0.25;
/** The hovered line's under-stroke: the same glow, fainter than a pick. */
export const TL_HOVER_GLOW_ALPHA = 0.12;
/** Line-body hit slop in pixels (mouse / touch). */
export const TL_LINE_HIT = 6;
export const TL_LINE_HIT_TOUCH = 14;

export function marksFor(
  all: LineMarksByEpic | null | undefined,
  epic: string | undefined,
): { hidden: Set<string>; bold: Set<string> } {
  const m = epic && all && typeof all === "object" ? all[epic] : undefined;
  return {
    hidden: new Set(Array.isArray(m?.hidden) ? m.hidden : []),
    bold: new Set(Array.isArray(m?.bold) ? m.bold : []),
  };
}

/** Flip one key in one mark list for one epic. Pure; empty lists and empty
 * epics are dropped, and the result is undefined when nothing is marked, so an
 * unmarked instance carries no `lineMarks` key at all. */
export function toggleMark(
  all: LineMarksByEpic | null | undefined,
  epic: string,
  kind: LineMarkKind,
  key: string,
): LineMarksByEpic | undefined {
  const out: LineMarksByEpic = {};
  for (const [e, m] of Object.entries(all ?? {})) out[e] = { ...m };
  const cur = out[epic] ?? {};
  const set = new Set(cur[kind] ?? []);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  const next: LineMarks = { ...cur, [kind]: [...set] };
  if (!next[kind]!.length) delete next[kind];
  if (Object.keys(next).length) out[epic] = next;
  else delete out[epic];
  return Object.keys(out).length ? out : undefined;
}

/** How one drawn line paints given its marks. Hidden wins over bold. A hidden
 * line drops its furniture (rings, crossing dots, pin handle, ×N tag, pivot
 * stems) so it takes no tag slot and nothing about it competes for attention;
 * a bold line ignores the dim fade so it stands at the instance's own
 * opacity. */
export function markedLineStyle(
  base: { width: number; alpha: number; opacity: number },
  marks: { hidden: boolean; bold: boolean },
): { width: number; alpha: number; furniture: boolean } {
  if (marks.hidden) return { width: 1, alpha: TL_HIDDEN_ALPHA, furniture: false };
  if (marks.bold)
    return { width: base.width + TL_BOLD_EXTRA, alpha: base.opacity, furniture: true };
  return { width: base.width, alpha: base.alpha, furniture: true };
}

// --- clone to drawing -------------------------------------------------------

export interface TrendlineClone {
  tool: "segment" | "rayLine" | "straightLine";
  points: Array<{ timestamp: number; value: number }>;
}

/** The drawing tool that reproduces an extend mode: a ray keeps running right,
 * "extended" runs both ways, every stopping mode (and a pinned line, which the
 * caller passes as "segment") is a plain segment. */
export function cloneToolFor(mode: string | undefined): TrendlineClone["tool"] {
  if (mode === "extended") return "straightLine";
  if (mode === "ray" || mode === undefined) return "rayLine";
  return "segment";
}

/** Bar-open timestamp of a chart bar index. Past the newest bar (a meeting or
 * a pinned edge in the future) it extrapolates at the last bar spacing, which
 * is what klinecharts does with a future overlay point too. */
export function tsAtIndex(timestamps: readonly number[], idx: number): number | null {
  const n = timestamps.length;
  if (!n) return null;
  const i = Math.round(idx);
  if (i < 0) {
    const step = n > 1 ? timestamps[1] - timestamps[0] : 0;
    return timestamps[0] + i * step;
  }
  if (i < n) return timestamps[i];
  const step = n > 1 ? timestamps[n - 1] - timestamps[n - 2] : 0;
  return timestamps[n - 1] + (i - (n - 1)) * step;
}

// --- line-body hit targets ---------------------------------------------------

export interface TrendlineSegment {
  key: string;
  /** Endpoints of the stroke as DRAWN, pane-relative pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Resolved lazily at menu time: only the line the user picked needs it. */
  clone: () => TrendlineClone | null;
}

/** Recorded by the draw, per chart then "paneId:name", like the end-handle
 * map beside it: hit targets are what was painted, never a recomputation. */
const SEGMENTS = new WeakMap<object, Map<string, TrendlineSegment[]>>();

export function setTrendlineSegments(
  chart: object,
  paneId: string,
  name: string,
  segs: TrendlineSegment[] | null,
): void {
  let byPane = SEGMENTS.get(chart);
  if (!byPane) {
    if (segs === null) return;
    byPane = new Map();
    SEGMENTS.set(chart, byPane);
  }
  if (segs === null) byPane.delete(`${paneId}:${name}`);
  else byPane.set(`${paneId}:${name}`, segs);
}

export function dropTrendlineSegments(chart: object, name: string): void {
  const byPane = SEGMENTS.get(chart);
  if (!byPane) return;
  for (const key of [...byPane.keys()])
    if (key.slice(key.indexOf(":") + 1) === name) byPane.delete(key);
}

/** Pixel distance from (px, py) to the segment (x0,y0)-(x1,y1). */
export function distToSegment(
  px: number, py: number, x0: number, y0: number, x1: number, y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

export interface TrendlineHit {
  paneId: string;
  name: string;
  seg: TrendlineSegment;
}

/** Nearest drawn trendline body within `slop` of (px, py), across every
 * instance on the chart. Candle pane only: the recorded pixels are pane-
 * relative and callers hand in container-relative points, which agree only
 * for the topmost pane (the end-handle click has the same convention). */
export function hitTrendline(
  chart: object,
  px: number,
  py: number,
  slop: number,
): TrendlineHit | null {
  const byPane = SEGMENTS.get(chart);
  if (!byPane) return null;
  let best: (TrendlineHit & { d: number }) | null = null;
  for (const [k, segs] of byPane) {
    const cut = k.indexOf(":");
    const paneId = k.slice(0, cut);
    if (paneId !== "candle_pane") continue;
    for (const seg of segs) {
      const d = distToSegment(px, py, seg.x0, seg.y0, seg.x1, seg.y1);
      if (d > slop) continue;
      if (!best || d < best.d) best = { paneId, name: k.slice(cut + 1), seg, d };
    }
  }
  return best ? { paneId: best.paneId, name: best.name, seg: best.seg } : null;
}
