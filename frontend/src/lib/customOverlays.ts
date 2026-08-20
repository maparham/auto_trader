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
import { asFibConfig, fibLevelSegments } from "./fibConfig";
import { measureMetrics } from "./measureMetrics";
import { slopeMetrics } from "./slopeMetrics";
import { slopeHandles } from "./slopeHandles";
import { UP, DOWN } from "./chartTheme";
import { hexToRgba } from "./lineStyle";
import { bandEdges, formatTimeRangeReadout } from "./timeRangeMetrics";
import {
  ghostPrices,
  ghostGeometry,
  ghostLabelLines,
  overallSimilarity,
  prefixSimilarity,
  similarityTint,
  formatSimilarity,
  windowUnder,
  readoutLayout,
  asGhostStyle,
  type GhostStyle,
} from "./patternGhost";
import { periodFromTf } from "../chart/chartDataFacade";

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
function decorations(params: OverlayCreateFiguresCallbackParams<unknown>): OverlayFigure[] {
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
    // Label sits just above the midpoint of the line.
    out.push(labelFigure(mid.x, mid.y - 8, extra.text, "center", "bottom"));
  }
  return out;
}

// A drawing's text label, styled once so lines and the rectangle read identically.
// Canvas font family — a real stack, not "inherit" (not a valid canvas token).
// klinecharts' default overlay-text style paints a BLUE box (backgroundColor +
// borderColor); without nulling those out the blue label text renders on a blue box
// and is unreadable (same gotcha the measure/slope pills document below).
function labelFigure(
  x: number,
  y: number,
  text: string,
  align: "left" | "center" | "right",
  baseline: "top" | "middle" | "bottom",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline },
    styles: {
      color: TEXT_COLOR,
      size: 12,
      family: "-apple-system, system-ui, sans-serif",
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderSize: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
    },
    ignoreEvent: true,
  };
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

// rect: a persistent, interactive rectangle — two draggable corner points with a
// translucent fill + border box between them. Unlike rangeBand (transient, fixed
// color, full-pane height) this is a real drawing: the polygon figure carries NO
// explicit styles so klinecharts resolves them from `overlay.styles.polygon`
// (⊕ defaultStyles.polygon), which is what makes fill/border editable in the
// settings modal and persisted per-instance. Corner handles come from
// needDefaultPointFigure.
const rect: OverlayTemplate = {
  name: "rect",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { overlay, coordinates } = params;
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const left = Math.min(c0.x, c1.x);
    const right = Math.max(c0.x, c1.x);
    const top = Math.min(c0.y, c1.y);
    const bottom = Math.max(c0.y, c1.y);
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
      },
    ];
    // Optional centered label (extendData.text) — same styling as line labels.
    const extra = asDrawingExtra(overlay.extendData);
    if (extra.text && extra.text.trim()) {
      figures.push(labelFigure((left + right) / 2, (top + bottom) / 2, extra.text, "center", "middle"));
    }
    return figures;
  },
};

// fibonacciLine: TV-style fib retracement OVERRIDING klinecharts' built-in, which
// paints every level across the full chart width. Levels/extend/reverse/labels
// live in extendData.fib (asFibConfig defaults when absent — including for fibs
// saved before this existed). Level lines span the anchors' x-range unless
// extended; width/dash come from styles.line, color is per-level.
const fibonacciLine: OverlayTemplate = {
  name: "fibonacciLine",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: (params) => {
    const { overlay, coordinates, bounding, chart } = params;
    const pricePrecision = chart.getSymbol()?.pricePrecision ?? 2;
    if (coordinates.length < 2) return [];
    const cfg = asFibConfig((overlay.extendData as { fib?: unknown } | undefined)?.fib);
    const p0 = overlay.points?.[0]?.value;
    const p1 = overlay.points?.[1]?.value;
    if (typeof p0 !== "number" || typeof p1 !== "number") return [];
    const segs = fibLevelSegments({
      cfg,
      coordinates,
      values: [p0, p1],
      boundingWidth: bounding.width,
      precision: pricePrecision,
    });
    const line = (overlay.styles?.line ?? {}) as {
      size?: number;
      style?: string;
      dashedValue?: number[];
    };
    const figures: OverlayFigure[] = [];
    if (cfg.trendLine) {
      figures.push({
        type: "line",
        attrs: { coordinates: [coordinates[0], coordinates[1]] },
        styles: { color: "#787b86", size: 1, style: "dashed", dashedValue: [4, 4] },
        ignoreEvent: true, // the level lines + handles are the drag targets
      });
    }
    for (const s of segs) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: s.x1, y: s.y }, { x: s.x2, y: s.y }] },
        styles: {
          color: s.color,
          size: s.size ?? line.size ?? 1,
          style: s.style ?? line.style ?? "solid",
          dashedValue: line.dashedValue ?? [4, 4],
        },
      });
      if (cfg.labels) {
        // Label at the right end, just above the line; hug the pane edge when the
        // span is extended to it so the text never clips off-screen.
        const atEdge = s.x2 >= bounding.width - 1;
        figures.push({
          type: "text",
          attrs: {
            x: atEdge ? bounding.width - 2 : s.x2 + 4,
            y: s.y - 2,
            text: s.label,
            align: atEdge ? "right" : "left",
            baseline: "bottom",
          },
          styles: {
            color: s.color,
            size: 12,
            family: "-apple-system, system-ui, sans-serif",
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
      }
    }
    return figures;
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
    const { overlay, coordinates, bounding, chart } = params;
    const pricePrecision = chart.getSymbol()?.pricePrecision ?? 2;
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
      precision: pricePrecision,
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

// --- slope: the transient, interactive angle ruler --------------------------
// A two-anchor line that reports its slope as an angle (data geometry: +1%/bar = 45°,
// zoom- and instrument-independent) plus %/bar, %/hr, price/bar, price/time. Sibling to
// measure but STAYS interactive after drawing — ChartCore drags its endpoints, a
// midpoint (translate), and a rotate knob. This template only PAINTS; the handle
// pixel geometry (midpoint, stem, knob) comes from the shared slopeHandles helper so
// the drawn knob and its click target can't drift. All figures ignoreEvent:true — the
// overlay itself is inert; ChartCore's capture-phase handlers own the interaction.
const HANDLE_R = 4.5; // endpoint / midpoint handle radius
const KNOB_R = 5.5; // rotate-knob radius
const slope: OverlayTemplate = {
  name: "slope",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: (params) => {
    const { overlay, coordinates, bounding, chart } = params;
    const pricePrecision = chart.getSymbol()?.pricePrecision ?? 2;
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const p0 = overlay.points?.[0] ?? {};
    const p1 = overlay.points?.[1] ?? {};
    const ext = overlay.extendData as { baseIntervalMinutes?: number } | undefined;
    const m = slopeMetrics({
      price0: p0.value ?? 0,
      price1: p1.value ?? 0,
      index0: p0.dataIndex ?? 0,
      index1: p1.dataIndex ?? 0,
      time0: p0.timestamp ?? 0,
      time1: p1.timestamp ?? 0,
      precision: pricePrecision,
      baseIntervalMinutes: ext?.baseIntervalMinutes,
    });
    const palette = m.up ? MEASURE_UP : MEASURE_DOWN;
    const h = slopeHandles(c0, c1);

    const figures: OverlayFigure[] = [
      // The slope line itself.
      { type: "line", attrs: { coordinates: [c0, c1] }, styles: { color: palette.stroke, size: 2 }, ignoreEvent: true },
      // Perpendicular stem out to the rotate knob (dashed, quieter than the line).
      {
        type: "line",
        attrs: { coordinates: [h.mid, h.knob] },
        styles: { color: palette.stroke, size: 1, style: "dashed", dashedValue: [3, 3] },
        ignoreEvent: true,
      },
    ];
    // Endpoint + midpoint handles: hollow white rings (TV-style grab dots).
    const ring = (c: Coordinate): OverlayFigure => ({
      type: "circle",
      attrs: { x: c.x, y: c.y, r: HANDLE_R },
      styles: { style: "stroke_fill", color: "#ffffff", borderColor: palette.stroke, borderSize: 2 },
      ignoreEvent: true,
    });
    figures.push(ring(c0), ring(c1), ring(h.mid));
    // The rotate knob: a solid dot at the stem's end.
    figures.push({
      type: "circle",
      attrs: { x: h.knob.x, y: h.knob.y, r: KNOB_R },
      styles: { style: "fill", color: palette.stroke },
      ignoreEvent: true,
    });

    // Readout pill: angle big, then the rate lines — percentages first (bar, then the
    // %/hr a slope rule compares against), then absolute price (bar, then per time).
    const rows = [
      { text: m.angleText, tier: PRIMARY },
      { text: m.pctText, tier: SECONDARY },
      { text: m.pctTimeText, tier: SECONDARY },
      { text: m.priceBarText, tier: SECONDARY },
      { text: m.priceTimeText, tier: SECONDARY },
    ];
    const padX = 11;
    const padTop = 6;
    const padBottom = 7;
    const gap = 3;
    const textW = Math.max(...rows.map((r) => textWidth(r.text, r.tier.size, r.tier.weight)));
    const pillW = Math.ceil(textW) + padX * 2;
    const pillH = padTop + padBottom + rows.reduce((s, r, i) => s + r.tier.size + (i > 0 ? gap : 0), 0);

    // Anchor near the far (second) end: to its right, flipping left / clamping so the
    // whole pill stays inside the pane.
    let pillLeft = c1.x + 14;
    if (pillLeft + pillW > bounding.width - 2) pillLeft = c1.x - 14 - pillW;
    pillLeft = Math.max(2, Math.min(pillLeft, bounding.width - pillW - 2));
    let pillTop = c1.y - pillH / 2;
    pillTop = Math.max(2, Math.min(pillTop, bounding.height - pillH - 2));
    const pillCX = pillLeft + pillW / 2;

    figures.push({
      type: "rect",
      attrs: { x: pillLeft, y: pillTop, width: pillW, height: pillH },
      styles: { style: "fill", color: palette.pill, borderRadius: 7 },
      ignoreEvent: true,
    });
    // Text figures MUST null klinecharts' default blue text-box (backgroundColor +
    // borderColor), same gotcha as the measure pill — the rect above IS the pill.
    let y = pillTop + padTop;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0) y += gap;
      figures.push({
        type: "text",
        attrs: { x: pillCX, y, text: r.text, align: "center", baseline: "top" },
        styles: {
          color: r.tier.color,
          size: r.tier.size,
          weight: r.tier.weight,
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
      y += r.tier.size;
    }
    return figures;
  },
};

// --- rangeBand: the transient backtest "Pick Range" selection ---------------
// A two-anchor overlay that shades a FULL-HEIGHT vertical band between the two
// anchors' x positions (time-only — the y anchors are ignored). Like measure it
// is never persisted; OverlayManager drives it directly via override during the
// drag and removes it on finish. Fixed accent color, non-interactive.
const RANGE_BAND_FILL = "rgba(41, 98, 255, 0.12)";
const RANGE_BAND_STROKE = "rgba(41, 98, 255, 0.7)";
const rangeBand: OverlayTemplate = {
  name: "rangeBand",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const left = Math.min(c0.x, c1.x);
    const right = Math.max(c0.x, c1.x);
    const h = bounding.height;
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: left, y: 0 },
            { x: right, y: 0 },
            { x: right, y: h },
            { x: left, y: h },
          ],
        },
        styles: { style: "stroke_fill", color: RANGE_BAND_FILL, borderColor: RANGE_BAND_STROKE, borderSize: 1 },
        ignoreEvent: true,
      },
    ];
  },
};

// --- matchBand: the "Find similar" match highlight -------------------------
// Same full-height two-anchor geometry as rangeBand, but the polygon figure sets
// NO styles of its own, so klinecharts falls back to overlay.styles.polygon (the
// way timeRange's band does). That is the whole difference: one template renders
// both bands a jump paints — the matched candles and, beside them, the dimmer
// aftermath the panel measured — at different strengths from the same code.
// Transient like rangeBand: never persisted, never interactive.
//
// Geometry note (the same centre-anchor gotcha bandEdges documents below):
// klinecharts resolves a non-continuous overlay's timestamp to an integer bar
// INDEX and returns that bar's CENTER x. There is no sub-bar precision, so
// nudging the ANCHORS by half a timeframe cannot work — the floor search either
// snaps a whole bar over or not at all. The half-bar has to be taken in PIXEL
// space, here, off getBarSpace().bar: push the left edge half a bar left and the
// right edge half a bar right and the band lands on bar boundaries, exactly
// enclosing the anchored candles instead of stopping at their centres.
// Adjacency between the two bands a jump paints is exact for free: klinecharts
// lays bars out by index, so the first aftermath bar's left edge IS the last
// matched bar's right edge, session gaps and all.
// Exported for the geometry test, which drives createPointFigures with a stub
// chart rather than booting a real one.
export const matchBand: OverlayTemplate = {
  name: "matchBand",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, chart }) => {
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const halfBar = chart.getBarSpace().bar / 2;
    const left = Math.min(c0.x, c1.x) - halfBar;
    const right = Math.max(c0.x, c1.x) + halfBar;
    const h = bounding.height;
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: left, y: 0 },
            { x: right, y: 0 },
            { x: right, y: h },
            { x: left, y: h },
          ],
        },
        ignoreEvent: true,
      },
    ];
  },
};

// --- timeRange: a PERSISTENT full-height time-range highlight ---------------
// Marks a time interval [from, to) as a full-height shaded vertical band. Unlike
// the transient rangeBand it is a real drawing: persisted, selectable, colorable
// (fill/border from overlay.styles.polygon, editable in the settings modal), with
// an optional label (extendData.text). Stored as two anchor TIMESTAMPS so the same
// interval stays highlighted across timeframe changes (mark a 4H candle, see the 4
// hours on 15m). The y anchors are ignored — the band always spans the pane height.
//
// Geometry note (bandEdges): klinecharts anchors overlay points at the candle's
// CENTER x, so the raw coordinates sit half a bar right of the boundary. bandEdges
// shifts both edges left by half a bar width so the band lands on bar boundaries
// and exactly encloses the covered candles. Bar width comes from getBarSpace().bar,
// not by differencing the two coords (that fails for a single-candle band).
const TIME_RANGE_READOUT = "rgba(41, 98, 255, 0.9)";
const timeRange: OverlayTemplate = {
  name: "timeRange",
  totalStep: 3,
  needDefaultPointFigure: true, // top-edge grips → free horizontal resize
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: false, // time-only; no price tag
  createPointFigures: (params) => {
    const { overlay, coordinates, bounding, chart } = params;
    if (coordinates.length < 2) return [];
    const barWidth = chart.getBarSpace().bar;
    const { left, right } = bandEdges(coordinates[0].x, coordinates[1].x, barWidth);
    const h = bounding.height;
    const figures: OverlayFigure[] = [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: left, y: 0 },
            { x: right, y: 0 },
            { x: right, y: h },
            { x: left, y: h },
          ],
        },
      },
    ];
    // Readout (span · bar count) + optional label, stacked at the top-left inside
    // the band. Bars = loaded candles whose open falls in [from, to) — robust to
    // session gaps and always reflects the CURRENT timeframe.
    const t0 = overlay.points?.[0]?.timestamp;
    const t1 = overlay.points?.[1]?.timestamp;
    const width = right - left;
    if (typeof t0 === "number" && typeof t1 === "number" && width > 28) {
      const from = Math.min(t0, t1);
      const to = Math.max(t0, t1);
      const bars = chart.getDataList().filter((k) => k.timestamp >= from && k.timestamp < to).length;
      const readout = formatTimeRangeReadout(to - from, bars);
      figures.push({
        type: "text",
        attrs: { x: left + 4, y: 3, text: readout, align: "left", baseline: "top" },
        styles: {
          color: TIME_RANGE_READOUT,
          size: 11,
          family: "-apple-system, system-ui, sans-serif",
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
      const extra = asDrawingExtra(overlay.extendData);
      if (extra.text && extra.text.trim()) {
        figures.push(labelFigure(left + 4, 18, extra.text, "left", "top"));
      }
    }
    return figures;
  },
};


// --- patternGhost: a copied run of candles, pasted anywhere ------------------
// The pattern-overlay tool. extendData carries the copied shape (DrawingExtra.ghost)
// and a single anchor point says where it starts; everything else is derived here on
// every repaint, which is what makes the score live as the user drags it, pans, or
// zooms.
//
// Vertical placement has two modes, and they exist because the SCORE is blind to
// price level and volatility (it z-normalizes both away). Left alone, a ghost would
// happily read 95% while floating visibly above the candles it is scoring. So by
// default the shape is re-expressed in the underlying window's own price space
// (fitToWindow) and what you see is what is being measured. Once the user drags the
// ghost vertically, extendData.ghostPinned says "I placed this", and the stored
// ratios hang off the anchor price instead (anchorToPrice) — the score is unchanged
// either way. The Re-align menu item clears the pin.
//
// Axis note: the fit matches mean and sd in PRICE space and paints through
// yAxis.convertToPixel, so on the logarithmic axis the drawn shape is a close
// approximation rather than an exact picture of what the score measures (the
// score itself is axis-independent). Negligible over a normal window, visible
// over one spanning a wide price range.
//
// Exported for the geometry test, which drives createPointFigures with a stub chart
// (same idiom as matchBand above).
const GHOST_LABEL = "#8a93a3";
// Outline strength over fill: at a low opacity a flat body all but disappears,
// and the edge is what keeps the shape readable against the real candles.
const GHOST_EDGE_BOOST = 0.35;

// What a ghost bar is painted in: the chart's own up/down colours, or the one
// colour the user chose, at the ghost's opacity. Style only — the score is
// z-normalized and cannot see any of it.
function ghostColors(up: boolean, style: GhostStyle): { fill: string; line: string } {
  const base = style.color === "direction" ? (up ? UP : DOWN) : style.color;
  return {
    fill: hexToRgba(base, style.opacity),
    line: hexToRgba(base, Math.min(1, style.opacity + GHOST_EDGE_BOOST)),
  };
}
const STRIP_H = 13;
// The two stacked label lines (11px + 10px, snug), and the provenance line alone.
const LABEL_H = 26;
const SUB_LABEL_H = 13;
const STRIP_GAP = 6;
// Below this the cell is too narrow for "91%" and shows colour only.
const STRIP_TEXT_MIN_W = 22;
const GHOST_FONT = "-apple-system, system-ui, sans-serif";

function plainText(
  x: number,
  y: number,
  text: string,
  color: string,
  size: number,
  align: "left" | "center",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline: "top" },
    styles: {
      color,
      size,
      family: GHOST_FONT,
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderSize: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
    },
    ignoreEvent: true,
  };
}

export const patternGhost: OverlayTemplate = {
  name: "patternGhost",
  totalStep: 2, // one anchor click places it
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: (params) => {
    const { overlay, coordinates, chart, yAxis } = params;
    const extra = asDrawingExtra(overlay.extendData);
    const ghost = extra.ghost;
    if (!ghost || ghost.bars.length === 0 || coordinates.length < 1 || yAxis == null) return [];
    const style = asGhostStyle(extra.ghostStyle);

    // The real candles under the ghost, from its anchor bar rightwards. Short
    // (or empty) when the ghost hangs past the newest bar — every helper below
    // takes that as "no score yet" rather than guessing.
    const anchor = overlay.points?.[0] ?? {};
    const actual = windowUnder(chart.getDataList(), anchor, ghost.bars.length);


    const sims = prefixSimilarity(ghost.bars, actual);
    const overall = overallSimilarity(ghost.bars, actual);
    // One shared placement rule (pinned fit / fit to the candles / the chart's
    // own scale at the drop price), so what is drawn here and what a pin freezes
    // in OverlayManager cannot disagree.
    const dataList = chart.getDataList();
    const prices = ghostPrices(ghost.bars, {
      actual,
      reference: windowUnder(
        dataList,
        { dataIndex: Math.max(0, dataList.length - ghost.bars.length) },
        ghost.bars.length,
      ),
      anchorPrice: anchor.value ?? 0,
      pinned: extra.ghostPinned,
      pinnedFit: extra.ghostPinned ? extra.ghostFit ?? null : null,
    });

    const space = chart.getBarSpace();
    const candles = ghostGeometry(prices, {
      anchorX: coordinates[0].x,
      barSpace: space.bar,
      bodyWidth: space.gapBar,
      priceToY: (v) => yAxis.convertToPixel(v),
    });

    const figures: OverlayFigure[] = [];
    if (style.shape === "line") {
      // A close line reads better than bodies when the ghost sits directly on
      // top of real candles. Each segment takes its direction from the move it
      // draws, so the line still shows where the pattern turned.
      for (let i = 1; i < candles.length; i++) {
        const a = candles[i - 1];
        const b = candles[i];
        figures.push({
          type: "line",
          attrs: { coordinates: [{ x: a.x, y: a.closeY }, { x: b.x, y: b.closeY }] },
          styles: { color: ghostColors(b.closeY <= a.closeY, style).line, size: 2 },
        });
      }
      // A 2px polyline is a thin thing to grab, and a ghost has no default point
      // handles, so the candle boxes stay as invisible hit targets: dragging a
      // close-line ghost feels the same as dragging a candle one.
      for (const c of candles) {
        figures.push({
          type: "rect",
          attrs: { x: c.x - c.w / 2, y: c.wickTop, width: c.w, height: c.wickH },
          styles: { style: "fill", color: "rgba(0, 0, 0, 0)" },
        });
      }
    } else {
      for (const c of candles) {
        const { fill, line } = ghostColors(c.up, style);
        figures.push({
          type: "line",
          attrs: { coordinates: [{ x: c.x, y: c.wickTop }, { x: c.x, y: c.wickTop + c.wickH }] },
          styles: { color: line, size: 1 },
        });
        figures.push({
          type: "rect",
          attrs: { x: c.x - c.w / 2, y: c.bodyTop, width: c.w, height: c.bodyH },
          styles: { style: "stroke_fill", color: fill, borderColor: line, borderSize: 1 },
        });
      }
    }

    // The running-score strip, one cell per candle, clear of the shape it
    // describes — below it where there is room, above it where there is not.
    const bottom = Math.max(...candles.map((c) => c.wickTop + c.wickH));
    const top = Math.min(...candles.map((c) => c.wickTop));
    const { stripY, labelY } = readoutLayout({
      top,
      bottom,
      height: params.bounding.height,
      // With the score off there is no strip and only the provenance line, so
      // the layout reserves neither.
      stripH: style.score ? STRIP_H : 0,
      gap: STRIP_GAP,
      labelH: style.score ? LABEL_H : SUB_LABEL_H,
    });
    if (style.score) candles.forEach((c, i) => {
      const sim = sims[i] ?? null;
      const w = Math.max(1, space.bar - 1);
      figures.push({
        type: "rect",
        attrs: { x: c.x - space.bar / 2, y: stripY, width: w, height: STRIP_H },
        styles: { style: "fill", color: similarityTint(sim) },
        ignoreEvent: true,
      });
      if (space.bar >= STRIP_TEXT_MIN_W) {
        figures.push(plainText(c.x, stripY + 2, formatSimilarity(sim), "#ffffff", 9, "center"));
      }
    });

    // Provenance + overall score, on the far side of the strip.
    const period = chart.getPeriod();
    let sameTimeframe: boolean;
    try {
      const p = periodFromTf(ghost.resolution);
      sameTimeframe = period != null && p.span === period.span && p.type === period.type;
    } catch {
      sameTimeframe = false; // an unparseable stored resolution is worth showing
    }
    const [head, sub] = ghostLabelLines(ghost, overall, {
      epic: chart.getSymbol()?.ticker ?? "",
      sameTimeframe,
      compared: Math.min(actual.length, ghost.bars.length),
    });
    const labelX = candles[0].x - space.bar / 2;
    if (style.score) figures.push(plainText(labelX, labelY, head, GHOST_LABEL, 11, "left"));
    figures.push(
      plainText(labelX, style.score ? labelY + SUB_LABEL_H : labelY, sub, GHOST_LABEL, 10, "left"),
    );
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
  registerOverlay(rect);
  registerOverlay(fibonacciLine);
  registerOverlay(measure);
  registerOverlay(slope);
  registerOverlay(rangeBand);
  registerOverlay(matchBand);
  registerOverlay(timeRange);
  registerOverlay(patternGhost);
}
