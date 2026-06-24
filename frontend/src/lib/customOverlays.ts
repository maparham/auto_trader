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

let registered = false;
// Idempotent — safe to call on every chart mount (registration is global).
export function registerCustomOverlays(): void {
  if (registered) return;
  registered = true;
  registerOverlay(segment);
  registerOverlay(rayLine);
  registerOverlay(straightLine);
}
