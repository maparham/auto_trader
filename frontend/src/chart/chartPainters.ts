// Canvas painters + small formatting/precision helpers extracted from ChartCore.
// Pure functions: they take a 2D context (or plain values) and draw / return —
// no React, no shared state. They consume the pixel-resolved LineCache and the
// selection-marker constants from chartGeometry.
import { minPositiveGap } from "../lib/barInterval";
import { curveLabel, curveLabelConfig, curveLabelPosFor, indTypeOf } from "../lib/customIndicators";
import { slopeMaLines, slopeLengths, type SlopeMaSource } from "../lib/indicators/slope";
import { getIndicatorsByPane } from "../lib/indicators";
import { MA_KIND_LABEL } from "../lib/indicators/ma";
import { normalizeMaKind } from "../lib/mtf";
import { type CurveLabelPill } from "../CurveLabels";
import type { Chart } from "klinecharts";
import { type LineCache, type PivotDeltaLabel, DOT_RADIUS, ANCHOR_HANDLE_R } from "./chartGeometry";
import { PIVOT_DELTA_PLATE, PIVOT_LABEL_COLOR } from "../lib/indicators/pivotAnalysis";
import { type CrossingDot } from "./curveCrossings";

// The browser's IANA timezone (e.g. "Europe/London"), used when the user picks
// "Browser time". klinecharts needs an explicit name; passing "" can leave the
// previous timezone in place, so we always resolve to a concrete zone.
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// convertFromPixel/convertToPixel are typed to return T | T[]; we always pass a
// one-element array, so normalize to the single result.
export function first<T>(r: T | T[]): T {
  return (Array.isArray(r) ? r[0] : r) as T;
}

// Decimals for ~5 significant figures on a synthetic ratio/spread of unknown magnitude. Clamped 0..8.
export function synthPrecision(sampleClose: number): number {
  const v = Math.abs(sampleClose);
  if (!Number.isFinite(v) || v === 0) return 2;
  const digitsLeft = Math.floor(Math.log10(v)) + 1;
  return Math.min(8, Math.max(0, 5 - digitsLeft));
}

// Selection markers are anchored to fixed BARS (every DOT_STEP-th bar by
// timestamp phase), NOT to fixed screen spacing — so they stay glued to the
// chart through zoom/scroll instead of sliding along the curve. When zoomed out
// far enough that they'd crowd below MIN_DOT_GAP_PX, the step doubles (octave
// thinning): half the dots drop out but the rest stay put (a multiple of the
// base step), so they still never slide.
const DOT_STEP = 6; // ~48px apart at the default bar spacing (8px)
const MIN_DOT_GAP_PX = 30;

// Draw TradingView-style hollow selection handles (background-filled circle +
// colored ring) at screen-equidistant points along the selected indicator's
// line(s), onto the dedicated overlay canvas (above klinecharts' canvases, so
// the ring sits ON TOP of the line). Returns nothing; clears nothing.
export function paintSelectionDots(
  ctx: CanvasRenderingContext2D,
  cache: LineCache[],
  sel: { paneId: string; name: string },
  fill: string,
  barSpace: number,
): void {
  for (const line of cache) {
    if (line.paneId !== sel.paneId || line.name !== sel.name) continue;
    const coords = line.coords;
    if (coords.length < 2) continue;
    // Bar interval (ms): the smallest positive gap between adjacent bars (so
    // weekend/overnight gaps don't distort the per-bar phase used for anchoring).
    const barMs = minPositiveGap(coords.map((c) => c.t));
    if (barMs == null) continue;
    // Octave-thin when zoomed out so dots never crowd, but only by doubling the
    // step (a multiple of the base) so the surviving dots stay anchored to the
    // same bars — they thin/reappear on zoom, never slide.
    let step = DOT_STEP;
    while (step * barSpace < MIN_DOT_GAP_PX) step *= 2;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = line.color;
    ctx.fillStyle = fill;
    for (const p of coords) {
      if (Math.round(p.t / barMs) % step !== 0) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// Crossing-marker arrow geometry: small enough to sit between 1m bars.
const CROSS_ARROW_W = 3.5; // half-width of the arrow base
const CROSS_ARROW_H = 7; // tip-to-base height

// Draw the crossing markers for the selected curve: a little arrow whose TIP
// sits exactly on each intersection with another candle-pane curve — an
// up-arrow (body below the crossing) when the selected curve crossed above,
// a down-arrow (body above) when it crossed below, in the app's candle up/down
// colors, outlined in the chart background so they read on top of both lines.
export function paintCrossingDots(
  ctx: CanvasRenderingContext2D,
  dots: CrossingDot[],
  upColor: string,
  downColor: string,
  ring: string,
): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = ring;
  ctx.lineJoin = "round";
  for (const d of dots) {
    const s = d.dir === "up" ? 1 : -1; // body extends below an up-arrow's tip
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x - CROSS_ARROW_W, d.y + s * CROSS_ARROW_H);
    ctx.lineTo(d.x + CROSS_ARROW_W, d.y + s * CROSS_ARROW_H);
    ctx.closePath();
    ctx.fillStyle = d.dir === "up" ? upColor : downColor;
    ctx.fill();
    ctx.stroke();
  }
}

// Build the curve-end label pills. A line gets a pill when its labels are enabled
// AND either (a) its config is "always" (permanent) or (b) the indicator is ACTIVE
// — selected/legend-hovered/curve-hovered, the same triggers that show the selection
// handles. One pill per figure that resolves a non-empty key-parameter tag. Anchored
// to the curve's last coord for side:"right", its first for side:"left" — both in
// container space.
export function buildCurveLabelPills(
  cache: LineCache[],
  targets: Array<{ paneId: string; name: string }>,
  maxX: number, // right edge of the main plot, so right-side pills stay on-chart
): CurveLabelPill[] {
  const active = (paneId: string, name: string) =>
    targets.some((t) => t.paneId === paneId && t.name === name);
  const pills: CurveLabelPill[] = [];
  for (const line of cache) {
    if (line.coords.length === 0) continue;
    const cfg = curveLabelConfig(line.extendData);
    if (!cfg.enabled) continue;
    if (!cfg.always && !active(line.paneId, line.name)) continue;
    const text = curveLabel(line.indType, line.figKey, line.extendData, line.calcParams);
    if (!text) continue;
    // High and Low curves get independently-configured positions.
    const pos = curveLabelPosFor(cfg, line.figKey);
    const end = pos.side === "right" ? line.coords[line.coords.length - 1] : line.coords[0];
    pills.push({
      key: `${line.paneId}:${line.name}:${line.figKey}`,
      text,
      x: end.x,
      y: end.y,
      color: line.color,
      side: pos.side,
      align: pos.align,
      maxX,
    });
  }
  return pills;
}

// Curve-end pills for a Slope's ON-CHART MA curves (self-drawn, so not in the figure
// LineCache that buildCurveLabelPills reads). One pill per MA line, text = MA type + length
// ("EMA 21"), colored to match the curve, placed at the chosen visible end. Gated by the same
// generic curve-label config (curveLabelConfig) as every other indicator, plus the on-chart
// MA being shown. `targets` are the selected/hovered indicators; a Slope is "active" when its
// instance name is among them (its selection lives in its own sub-pane, so match by name).
export function buildSlopeMaPills(
  chart: Chart,
  targets: Array<{ paneId: string; name: string }>,
  maxX: number,
): CurveLabelPill[] {
  const panes = getIndicatorsByPane(chart);
  if (!panes) return [];
  const dl = chart.getDataList();
  const vr = chart.getVisibleRange();
  const to = Math.min(vr.to, dl.length);
  const active = (name: string) => targets.some((t) => t.name === name);
  const pills: CurveLabelPill[] = [];
  for (const inds of panes.values()) {
    for (const ind of inds.values()) {
      if (indTypeOf(ind) !== "SLOPE") continue;
      const ext = (ind.extendData ?? {}) as { showMa?: boolean; maType?: string };
      if (!ext.showMa || ind.visible === false) continue;
      const cfg = curveLabelConfig(ext);
      if (!cfg.enabled) continue;
      if (!cfg.always && !active(ind.name)) continue;
      const lines = slopeMaLines(ind as SlopeMaSource, dl);
      if (!lines.length) continue;
      const lengths = slopeLengths(ind.calcParams);
      const maType = MA_KIND_LABEL[normalizeMaKind(ext.maType)];
      const pos = cfg.high; // single position slot (no High/Low split for the MA curves)
      lines.forEach((line, li) => {
        // The chosen visible END: right -> last defined visible point, left -> first.
        let idx = -1;
        if (pos.side === "right") {
          for (let i = to - 1; i >= Math.max(vr.from, 0); i--) {
            const v = line.values[i];
            if (typeof v === "number" && Number.isFinite(v)) {
              idx = i;
              break;
            }
          }
        } else {
          for (let i = Math.max(vr.from, 0); i < to; i++) {
            const v = line.values[i];
            if (typeof v === "number" && Number.isFinite(v)) {
              idx = i;
              break;
            }
          }
        }
        if (idx < 0) return;
        const k = dl[idx];
        const px = first(
          chart.convertToPixel([{ timestamp: k.timestamp, value: line.values[idx] as number }], {
            paneId: "candle_pane",
            absolute: true,
          }),
        ) as { x: number; y: number };
        if (px.x == null || px.y == null) return;
        pills.push({
          key: `${ind.name}:ma${li}`,
          text: `${maType} ${lengths[li]}`,
          x: px.x,
          y: px.y,
          color: line.color,
          side: pos.side,
          align: pos.align,
          maxX,
        });
      });
    }
  }
  return pills;
}

// Paint the AVWAP anchor grab handle: a solid disc with a white ring, larger than
// the selection dots so it reads as the draggable base of the anchored VWAP.
export function paintAnchorHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  ring: string,
): void {
  ctx.beginPath();
  ctx.arc(x, y, ANCHOR_HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ring;
  ctx.stroke();
}

// Draw ALL the Pivots-High/Low Δ%/Δt labels for a cell in one pass — the indicator
// no longer draws them itself, so this is the single owner and each pivot's label
// renders exactly once (no on-canvas + overlay doubling). Each label is small at
// rest; the one under the cursor (`hovered`, by object identity) is drawn in a
// larger font at the SAME anchor + baselines, so it reads as that label growing in
// place — no background plate, no second label. Above a high pivot / below a low.
const PIVOT_LABEL_LINE_H = 12; // at-rest line spacing (matches the 10px font)
export function paintPivotDeltaLabels(
  ctx: CanvasRenderingContext2D,
  labels: PivotDeltaLabel[],
  hovered: PivotDeltaLabel | null,
): void {
  ctx.save();
  ctx.textAlign = "left";
  ctx.fillStyle = PIVOT_LABEL_COLOR;
  for (const l of labels) {
    const big = l === hovered;
    // Enlarged label uses the plate's bigger font + wider line spacing so its two
    // lines don't collide; at rest it's the compact 10px.
    ctx.font = big ? PIVOT_DELTA_PLATE.font : "10px sans-serif";
    const lineH = big ? PIVOT_DELTA_PLATE.lineH : PIVOT_LABEL_LINE_H;
    const x = l.markerX + 4;
    const [l1, l2] = l.lines;
    if (l.side === "high") {
      ctx.textBaseline = "bottom";
      ctx.fillText(l1, x, l.anchorY - lineH - 2);
      ctx.fillText(l2, x, l.anchorY - 2);
    } else {
      ctx.textBaseline = "top";
      ctx.fillText(l1, x, l.anchorY + 2);
      ctx.fillText(l2, x, l.anchorY + 2 + lineH);
    }
  }
  ctx.restore();
}

export function fmtCountdown(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
