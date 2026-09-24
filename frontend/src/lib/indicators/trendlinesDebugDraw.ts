// The debug layer: every non-drawn candidate, rejected pivots and the user's
// target line. NO HUE (owner's rule, near color-blind user): one color, the
// instance's own, and distinctions by dash, weight, opacity, glyph and text.
//   failed a gate        dotted, thin, 0.45
//   outranked            dashed, thin, 0.45
//   forced (lookup)      long dash, 1.5px, 0.7
//   selected             solid, 2px, full, select glow, reason tag
//   winner of selected   select glow, "winner" tag
//   rejected pivot       x with S (size) or R (reach) under or over it
//   target               two parallel 1px strokes, 3px apart
import { clipSegmentToRect, DRAW_CLIP_PAD } from "./shared";
import { lineStart, projectAt, type PivotKind } from "./trendlines";
import { TL_HOVER_GLOW_ALPHA, TL_SELECT_GLOW, TL_SELECT_GLOW_ALPHA, type TrendlineClone, type TrendlineSegment } from "./trendlineMarks";
import { GATE_GROUP, groupOf, type DebugCandidate, type TlDebugResult } from "./trendlinesDebugExplain";
import type { TargetIdx } from "./trendlinesDebugLookup";

export const DBG_FAILED_DASH = [1, 3];
export const DBG_OUTRANKED_DASH = [5, 4];
export const DBG_FORCED_DASH = [10, 4];
export const DBG_ALPHA = 0.45;
export const DBG_FORCED_ALPHA = 0.7;
export const DBG_KEY_PREFIX = "dbg:";
const X_ARM = 3;

export function candidateLook(
  c: DebugCandidate, selected: boolean, hovered: boolean,
): { dash: number[]; alpha: number; width: number; glow: number } {
  if (selected) return { dash: [], alpha: 1, width: 2, glow: TL_SELECT_GLOW_ALPHA };
  const forced = c.origin === "forced";
  return {
    dash: forced ? DBG_FORCED_DASH : c.outranked ? DBG_OUTRANKED_DASH : DBG_FAILED_DASH,
    alpha: forced ? DBG_FORCED_ALPHA : DBG_ALPHA,
    width: forced ? 1.5 : 1,
    glow: hovered ? TL_HOVER_GLOW_ALPHA : 0,
  };
}

/** The strip group a candidate is tallied under. Must match explain()'s tally
 * labels exactly, so hiding a group hides exactly the lines it counted. */
export const debugGroupOf = (c: DebugCandidate): string => groupOf(c);

const fmt = (n: number | null) => (n === null ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The selected candidate's end tag: its primary reason, measured / limit. */
export function reasonTag(c: DebugCandidate): string {
  if (c.drawn) return "drawn";
  const v = c.failed[0];
  // No failed verdict: a died, evicted or forced line that passes every
  // current gate (explain tallies it as "passes").
  if (!v) return "passes gates";
  if (v.gate === "merged") return "merged";
  if (v.gate === "liveCap") return "live cap";
  return `${GATE_GROUP[v.gate]} ${fmt(v.measured)}/${fmt(v.limit)}`.slice(0, 24);
}

export interface DebugPaint {
  ctx: CanvasRenderingContext2D;
  lineColor: string;
  xAt: (j: number) => number;
  xAtPivot: (j: number, kind: PivotKind) => number;
  yPx: (price: number) => number;
  width: number;
  height: number;
  tagRight: number;
  selectedKey?: string;
  hoveredKey?: string;
  /** lineKey of the line that outranked the selected candidate. */
  winnerKey?: string;
  target: TargetIdx | null;
  /** Reason groups the user expanded: every candidate paints, not just the
   * sampled nearest (DebugCandidate.shown). */
  expanded?: ReadonlySet<string>;
  /** With a target set: the keys of its lookup matches. Only those (plus
   * forced lines) paint, so the user's line is not lost in the wall. */
  matchKeys?: ReadonlySet<string> | null;
  /** Painted with the selected look though not selected: the closest lookup
   * match, the one the strip says to click. */
  highlightKey?: string;
  /** Bar (line space) a still-live candidate is painted to: past the eval
   * bar under a pin, where the chart runs on after the last closed HTF bar.
   * Default: the candidate's own end. */
  liveEdge?: number;
  /** Debug layers to paint (Debug tab); each defaults on. The selected line
   * and its winner paint whatever this says. */
  show?: { failed: boolean; outranked: boolean; forced: boolean };
  /** A line from (ja, pa) to (jb, pb) in line space as two chart points
   * (bar-open time, price) on the painted stroke, for To drawing. Without it
   * a debug line cannot be turned into a drawing. */
  pointsFor?: (ja: number, pa: number, jb: number, pb: number) => TrendlineClone["points"] | null;
}

function stroke(ctx: CanvasRenderingContext2D, s: number[]): void {
  ctx.beginPath();
  ctx.moveTo(s[0], s[1]);
  ctx.lineTo(s[2], s[3]);
  ctx.stroke();
}

/** Last bar a candidate is painted to: live ones (ending at the eval bar)
 * run on to the live edge. */
const paintEnd = (c: DebugCandidate, res: TlDebugResult, liveEdge: number | undefined): number =>
  liveEdge !== undefined && c.end >= res.evalIdx ? Math.max(c.end, liveEdge) : c.end;

export function paintDebug(p: DebugPaint, res: TlDebugResult, hidden: ReadonlySet<string>): TrendlineSegment[] {
  const { ctx } = p;
  const segs: TrendlineSegment[] = [];
  ctx.save();
  ctx.strokeStyle = p.lineColor;
  ctx.fillStyle = p.lineColor;
  ctx.font = "10px sans-serif";
  // Explicit, not inherited: the tags below must not pick up whatever the
  // previous drawer left on the shared context.
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const c of res.candidates) {
    if (c.drawn) continue;
    const key = DBG_KEY_PREFIX + c.key;
    // Selected, the winner and forced (the user's own) lines always paint;
    // the rest only when sampled, their group is expanded, or they match
    // the target.
    const always = key === p.selectedKey || c.key === p.winnerKey;
    if (!always) {
      const layer = c.origin === "forced" ? "forced" : c.outranked ? "outranked" : "failed";
      if (p.show && !p.show[layer]) continue;
      const g = debugGroupOf(c);
      if (hidden.has(g)) continue;
      if (c.origin !== "forced") {
        if (p.matchKeys) {
          if (!p.matchKeys.has(c.key)) continue;
        } else if (!c.shown && !p.expanded?.has(g)) continue;
      }
    }
    const emph = key === p.selectedKey || key === p.highlightKey;
    // From where the line STARTS (Extend Left may have moved it before i1).
    const s0 = lineStart(c.line);
    const e1 = paintEnd(c, res, p.liveEdge);
    const x0 = p.xAt(s0);
    const x1 = p.xAt(e1);
    const y0 = p.yPx(projectAt(c.line, s0));
    const y1 = p.yPx(projectAt(c.line, e1));
    const seg = clipSegmentToRect(
      x0, y0, x1, y1, -DRAW_CLIP_PAD, -DRAW_CLIP_PAD, p.width + DRAW_CLIP_PAD, p.height + DRAW_CLIP_PAD,
    );
    if (!seg) continue;
    const look = candidateLook(c, emph, key === p.hoveredKey);
    if (look.glow > 0) {
      ctx.setLineDash([]);
      ctx.globalAlpha = look.glow;
      ctx.lineWidth = look.width + TL_SELECT_GLOW;
      stroke(ctx, seg);
    }
    ctx.setLineDash(look.dash);
    ctx.globalAlpha = look.alpha;
    ctx.lineWidth = look.width;
    stroke(ctx, seg);
    const hit = clipSegmentToRect(x0, y0, x1, y1, 0, 0, p.tagRight, p.height);
    // To drawing: a segment over the stroke as painted, start to end, not
    // just its on-screen part. Built in data space, never from these pixels:
    // the menu can outlive this frame's scroll and zoom.
    const pointsFor = p.pointsFor;
    const line = c.line;
    const clone = pointsFor
      ? (): TrendlineClone | null => {
        const points = pointsFor(s0, projectAt(line, s0), e1, projectAt(line, e1));
        return points ? { tool: "segment", points } : null;
      }
      : () => null;
    if (hit) segs.push({ key, x0: hit[0], y0: hit[1], x1: hit[2], y1: hit[3], clone });
    if (emph) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillText(reasonTag(c), Math.min(seg[2] + 6, p.tagRight - 60), seg[3]);
    }
  }
  // The winner of a selected outranked candidate: glow plus a text tag.
  const win = p.winnerKey ? res.byKey.get(p.winnerKey) : undefined;
  if (win) {
    const ws = lineStart(win.line);
    const we = paintEnd(win, res, p.liveEdge);
    const s = clipSegmentToRect(
      p.xAt(ws), p.yPx(projectAt(win.line, ws)), p.xAt(we), p.yPx(projectAt(win.line, we)),
      0, 0, p.width, p.height,
    );
    if (s) {
      ctx.setLineDash([]);
      ctx.globalAlpha = TL_SELECT_GLOW_ALPHA;
      ctx.lineWidth = 1 + TL_SELECT_GLOW;
      stroke(ctx, s);
      ctx.globalAlpha = 1;
      ctx.fillText("winner", Math.min(s[2] + 6, p.tagRight - 40), s[3]);
    }
  }
  // Rejected pivots: an x at the wick, a letter clear of it.
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.textAlign = "center";
  for (const rp of res.rejectedPivots) {
    if (hidden.has("pivots")) break;
    const x = p.xAtPivot(rp.idx, rp.kind);
    const price = rp.kind === "high" ? res.highs[rp.idx] : res.lows[rp.idx];
    const dir = rp.kind === "high" ? -1 : 1;
    const y = p.yPx(price) + dir * 6;
    if (x < 0 || x > p.tagRight || y < 0 || y > p.height) continue;
    ctx.beginPath();
    ctx.moveTo(x - X_ARM, y - X_ARM);
    ctx.lineTo(x + X_ARM, y + X_ARM);
    ctx.moveTo(x - X_ARM, y + X_ARM);
    ctx.lineTo(x + X_ARM, y - X_ARM);
    ctx.stroke();
    ctx.fillText(rp.gate === "size" ? "S" : "R", x, y + dir * 10);
  }
  // Target: a double stroke.
  if (p.target) {
    const t = p.target;
    const ax = p.xAt(t.x1), ay = p.yPx(t.p1), bx = p.xAt(t.x2), by = p.yPx(t.p2);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * 1.5;
    const ny = ((bx - ax) / len) * 1.5;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    for (const s of [1, -1]) stroke(ctx, [ax + s * nx, ay + s * ny, bx + s * nx, by + s * ny]);
  }
  ctx.restore();
  return segs;
}
