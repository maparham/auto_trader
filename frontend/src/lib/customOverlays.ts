// Custom drawing overlays that ADD text labels + a midpoint marker on top of the
// built-in trend-line shapes, driven entirely by the overlay's extendData
// (DrawingExtra.text / .showMiddle). Registered globally by OVERRIDING the
// built-in names (registerOverlay replaces a same-named built-in), so:
//   - text/marker are pure extendData — no extra overlay names, so setExtend()'s
//     segment↔rayLine↔straightLine name-swap keeps working untouched;
//   - a drawing with no text/marker renders byte-identical to the built-in (we
//     replicate the exact line figure), so the proven behaviour never regresses.
//
// The text + marker figures are positioned off the two anchor coordinates and are
// therefore geometry-independent — shared by all three line variants; only the
// LINE figure differs per geometry. Started with `segment` (trivial geometry =
// zero regression risk); ray/straight extend the same shared helper.

import { registerOverlay } from "klinecharts";
import type {
  OverlayTemplate,
  OverlayCreateFiguresCallbackParams,
  OverlayFigure,
  Coordinate,
  Bounding,
} from "klinecharts";
import { asDrawingExtra } from "./overlays";
import { measureMetrics } from "./measureMetrics";
import { UP, DOWN } from "./chartTheme";
import { hexToRgba } from "./lineStyle";

// --- line geometry, replicated from klinecharts' (non-exported) built-ins so the
// overridden variants paint byte-identically to the originals. ---------------
function linearSlopeIntercept(c1: Coordinate, c2: Coordinate): [number, number] | null {
  const difX = c1.x - c2.x;
  if (difX !== 0) {
    const k = (c1.y - c2.y) / difX;
    return [k, c1.y - k * c1.x];
  }
  return null;
}
function linearY(c1: Coordinate, c2: Coordinate, target: Coordinate): number {
  const kb = linearSlopeIntercept(c1, c2);
  return kb ? kb[0] * target.x + kb[1] : target.y;
}
// A ray from coordinates[0] through coordinates[1], extended to the chart edge.
function rayLineCoords(cs: Coordinate[], b: Bounding): Coordinate[] {
  if (cs.length <= 1) return cs;
  let end: Coordinate;
  if (cs[0].x === cs[1].x && cs[0].y !== cs[1].y) {
    end = { x: cs[0].x, y: cs[0].y < cs[1].y ? b.height : 0 };
  } else if (cs[0].x > cs[1].x) {
    end = { x: 0, y: linearY(cs[0], cs[1], { x: 0, y: cs[0].y }) };
  } else {
    end = { x: b.width, y: linearY(cs[0], cs[1], { x: b.width, y: cs[0].y }) };
  }
  return [cs[0], end];
}
// A line through both points, extended to both chart edges.
function straightLineCoords(cs: Coordinate[], b: Bounding): Coordinate[] {
  if (cs[0].x === cs[1].x) {
    return [{ x: cs[0].x, y: 0 }, { x: cs[0].x, y: b.height }];
  }
  return [
    { x: 0, y: linearY(cs[0], cs[1], { x: 0, y: cs[0].y }) },
    { x: b.width, y: linearY(cs[0], cs[1], { x: b.width, y: cs[0].y }) },
  ];
}

const MARKER_COLOR = "#2962ff";
const TEXT_COLOR = "#2962ff";

// Build the optional text + midpoint figures from extendData. Shared across every
// line geometry — both are anchored to the segment's two endpoints.
function decorations(params: OverlayCreateFiguresCallbackParams): OverlayFigure[] {
  const { overlay, coordinates } = params;
  if (coordinates.length < 2) return [];
  const extra = asDrawingExtra(overlay.extendData);
  const out: OverlayFigure[] = [];
  const [a, b] = coordinates;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  if (extra.showMiddle) {
    out.push({
      type: "circle",
      attrs: { x: mid.x, y: mid.y, r: 4 },
      styles: { style: "fill", color: MARKER_COLOR },
      // Don't let the marker swallow drags meant for the line.
      ignoreEvent: true,
    });
  }
  if (extra.text && extra.text.trim()) {
    out.push({
      type: "text",
      // Label sits just above the midpoint of the line.
      attrs: { x: mid.x, y: mid.y - 8, text: extra.text, align: "center", baseline: "bottom" },
      // Canvas font family — a real stack, not "inherit" (not a valid canvas token).
      styles: { color: TEXT_COLOR, size: 12, family: "-apple-system, system-ui, sans-serif" },
      ignoreEvent: true,
    });
  }
  return out;
}

// segment: a plain two-point line (built-in geometry is exactly this).
const segment: OverlayTemplate = {
  name: "segment",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { coordinates } = params;
    const figures: OverlayFigure[] = [];
    if (coordinates.length === 2) {
      figures.push({ type: "line", attrs: { coordinates } });
    }
    return [...figures, ...decorations(params)];
  },
};

// rayLine: from the first point through the second, extended to one edge.
const rayLine: OverlayTemplate = {
  name: "rayLine",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { coordinates, bounding } = params;
    const figures: OverlayFigure[] = [];
    if (coordinates.length > 1) {
      figures.push({ type: "line", attrs: { coordinates: rayLineCoords(coordinates, bounding) } });
    }
    return [...figures, ...decorations(params)];
  },
};

// straightLine: through both points, extended to both edges.
const straightLine: OverlayTemplate = {
  name: "straightLine",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { coordinates, bounding } = params;
    const figures: OverlayFigure[] = [];
    if (coordinates.length === 2) {
      figures.push({ type: "line", attrs: { coordinates: straightLineCoords(coordinates, bounding) } });
    }
    return [...figures, ...decorations(params)];
  },
};

// --- measure: the transient TradingView-style ruler ------------------------
// A two-point overlay that paints a translucent box between the anchors, arrows
// for the price + time direction, and a readout pill with the price/%/ticks and
// bars/duration. It is NEVER persisted (OverlayManager owns its transient
// lifecycle); it just renders whatever two points it currently holds. All figures
// are ignoreEvent so the ruler is fully non-interactive (no hover/select/drag) —
// OverlayManager drives it directly via override.
//
// The readout is designed as a precision-caliper display: the box color IS the
// chart's own candle up/down language (imported UP/DOWN, not lookalike constants),
// and the pill gives the price MAGNITUDE primacy — 12px/700 — over the bars·time
// context line — 10.5px/500 at reduced opacity — so the number you measured for
// reads first. The pill is snapped to its real text width (measured, not estimated)
// and clamped inside the pane so it never clips off an edge.
const MEASURE_UP = { fill: hexToRgba(UP, 0.14), stroke: hexToRgba(UP, 0.9), pill: UP };
const MEASURE_DOWN = { fill: hexToRgba(DOWN, 0.14), stroke: hexToRgba(DOWN, 0.9), pill: DOWN };
const MEASURE_FONT = "-apple-system, system-ui, sans-serif";
// Readout type scale: primary = the magnitude line, secondary = bars·time context.
const PRIMARY = { size: 12, weight: "700", color: "#ffffff" };
const SECONDARY = { size: 10.5, weight: "500", color: "rgba(255,255,255,0.78)" };

// One shared offscreen 2D context for text metrics — the figure builder gets no
// canvas, and a measured pill (snug, symmetric) beats a char-count estimate. Lazily
// created; falls back to an em-estimate where no DOM canvas exists (e.g. SSR/tests).
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, size: number, weight: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  }
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = `${weight} ${size}px ${MEASURE_FONT}`;
  return measureCtx.measureText(text).width;
}

// Shaft + a two-stroke arrowhead at `to`, pointing from `from` toward `to`.
function arrow(from: Coordinate, to: Coordinate, color: string): OverlayFigure[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = 7;
  const ang = Math.PI / 6;
  // Barb = the reversed direction (-u) rotated by ±ang, scaled from the tip.
  const barb = (a: number): Coordinate => ({
    x: to.x + head * (-ux * Math.cos(a) - -uy * Math.sin(a)),
    y: to.y + head * (-ux * Math.sin(a) + -uy * Math.cos(a)),
  });
  const line = (coordinates: Coordinate[]): OverlayFigure => ({
    type: "line",
    attrs: { coordinates },
    styles: { color },
    ignoreEvent: true,
  });
  return [line([from, to]), line([to, barb(ang)]), line([to, barb(-ang)])];
}

const measure: OverlayTemplate = {
  name: "measure",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: (params) => {
    const { overlay, coordinates, precision, bounding } = params;
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const p0 = overlay.points?.[0] ?? {};
    const p1 = overlay.points?.[1] ?? {};
    const price0 = p0.value ?? 0;
    const price1 = p1.value ?? 0;
    const palette = price1 >= price0 ? MEASURE_UP : MEASURE_DOWN;

    const left = Math.min(c0.x, c1.x);
    const right = Math.max(c0.x, c1.x);
    const top = Math.min(c0.y, c1.y);
    const bottom = Math.max(c0.y, c1.y);
    const midX = (c0.x + c1.x) / 2;
    const midY = (c0.y + c1.y) / 2;

    const figures: OverlayFigure[] = [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom },
          ],
        },
        styles: { style: "stroke_fill", color: palette.fill, borderColor: palette.stroke, borderSize: 1 },
        ignoreEvent: true,
      },
      // Price-direction arrow (vertical, start price → end price) and
      // time-direction arrow (horizontal, start bar → end bar).
      ...arrow({ x: midX, y: c0.y }, { x: midX, y: c1.y }, palette.stroke),
      ...arrow({ x: c0.x, y: midY }, { x: c1.x, y: midY }, palette.stroke),
    ];

    const m = measureMetrics({
      price0,
      price1,
      index0: p0.dataIndex ?? 0,
      index1: p1.dataIndex ?? 0,
      time0: p0.timestamp ?? 0,
      time1: p1.timestamp ?? 0,
      precision: precision.price,
    });
    // Snug the pill to whichever line is actually wider (primary is bigger type but
    // the bars·time line can run longer), measured at each line's own font.
    const padX = 11;
    const padTop = 6;
    const padBottom = 7;
    const gap = 3; // breathing room between the two lines
    const textW = Math.max(
      textWidth(m.line1, PRIMARY.size, PRIMARY.weight),
      textWidth(m.line2, SECONDARY.size, SECONDARY.weight),
    );
    const pillW = Math.ceil(textW) + padX * 2;
    const pillH = padTop + PRIMARY.size + gap + SECONDARY.size + padBottom;

    // Center under the box; below it, but flip above if it would fall off the pane
    // bottom. Clamp x so a box near an edge keeps the whole readout on-screen.
    const belowY = bottom + 10;
    const pillY = belowY + pillH <= bounding.height ? belowY : top - 10 - pillH;
    const half = pillW / 2;
    const pillCX = Math.min(Math.max(midX, half + 2), bounding.width - half - 2);

    figures.push({
      type: "rect",
      attrs: { x: pillCX - half, y: pillY, width: pillW, height: pillH },
      styles: { style: "fill", color: palette.pill, borderRadius: 7 },
      ignoreEvent: true,
    });
    // The two readout lines. klinecharts' default overlay-text style paints a BLUE
    // box (backgroundColor + borderColor), so every text figure must null those out
    // explicitly — the red/green rect above is the pill; the text just sits on it.
    const line = (text: string, y: number, tier: typeof PRIMARY): OverlayFigure => ({
      type: "text",
      attrs: { x: pillCX, y, text, align: "center", baseline: "top" },
      styles: {
        color: tier.color,
        size: tier.size,
        weight: tier.weight,
        family: MEASURE_FONT,
        backgroundColor: "transparent",
        borderColor: "transparent",
        borderSize: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      },
      ignoreEvent: true,
    });
    figures.push(line(m.line1, pillY + padTop, PRIMARY));
    figures.push(line(m.line2, pillY + padTop + PRIMARY.size + gap, SECONDARY));
    return figures;
  },
};

let registered = false;
// Idempotent — safe to call on every chart mount (registration is global).
export function registerCustomOverlays(): void {
  if (registered) return;
  registered = true;
  registerOverlay(segment);
  registerOverlay(rayLine);
  registerOverlay(straightLine);
  registerOverlay(measure);
}
