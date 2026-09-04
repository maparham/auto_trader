// Agent drawing actions: let MCP agents use the chart's drawing tools
// (same klinecharts overlays the left sidebar drives) on the focused chart.
//
// Wiring: App.tsx owns the focused controller (readyRef + focusedCell), which
// lives outside React state, so this module exposes setFocusedDrawingsProvider
// (same idiom as patternPanelStore.setPatternSeriesProvider). App sets it every
// render; the handlers read through it at call time, never closing over stale
// tabs. Registration happens once in agent/index.ts initAgentBridge().
import { ActionError, registerAction } from "../registry";
import type { OverlayManager } from "../../lib/overlays";
import { DRAW_TOOLS } from "../../lib/drawTools";
import { hexToRgba } from "../../lib/lineStyle";

export interface FocusedDrawings {
  overlays: OverlayManager;
  epic: string;
  cellId: string;
}

type Provider = () => FocusedDrawings | null;

let provider: Provider | null = null;

export function setFocusedDrawingsProvider(fn: Provider): void {
  provider = fn;
}

function focused(): FocusedDrawings {
  const cur = provider?.() ?? null;
  if (!cur) {
    throw new ActionError(
      "NO_FOCUSED_CHART",
      "no focused chart (is a chart with a symbol open and focused?)",
    );
  }
  return cur;
}

const TOOL_NAMES = new Set(DRAW_TOOLS.map((t) => t.name));

interface InPoint {
  timestamp?: unknown;
  value?: unknown;
  dataIndex?: unknown;
}

function toPoints(raw: unknown): Array<{ timestamp?: number; value?: number }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ActionError("INVALID_ARGS", "points: non-empty array required");
  }
  return (raw as InPoint[]).map((p, i) => {
    if (p == null || typeof p !== "object") {
      throw new ActionError("INVALID_ARGS", `points[${i}]: expected {timestamp?, value?}`);
    }
    const out: { timestamp?: number; value?: number } = {};
    if (p.timestamp !== undefined) {
      const ts = Number(p.timestamp);
      if (!Number.isFinite(ts)) {
        throw new ActionError("INVALID_ARGS", `points[${i}].timestamp: expected a number (ms)`);
      }
      // Accept seconds (10-digit) as well as ms (13-digit): candle times from
      // /api/candles are seconds, overlay anchors are ms.
      out.timestamp = ts < 1e12 ? ts * 1000 : ts;
    }
    if (p.value !== undefined) {
      const v = Number(p.value);
      if (!Number.isFinite(v)) {
        throw new ActionError("INVALID_ARGS", `points[${i}].value: expected a number`);
      }
      out.value = v;
    }
    if (out.timestamp === undefined && out.value === undefined) {
      throw new ActionError("INVALID_ARGS", `points[${i}]: need at least timestamp or value`);
    }
    return out;
  });
}

export function registerDrawingActions(): void {
  registerAction({
    name: "drawing.list",
    description:
      "List the focused chart's user drawings (id, tool name, points, label, color). Read-only.",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => {
      const { overlays, epic, cellId } = focused();
      return { epic, cellId, drawings: overlays.listDrawings() };
    },
  });

  registerAction({
    name: "drawing.add",
    description:
      "Draw on the focused chart with a sidebar tool (horizontalStraightLine for S/R levels, segment for trend lines, rect for zones, fibonacciLine for fibs). points: [{timestamp (ms, seconds accepted), value}]; horizontal lines need [{value}]. text sets the label, color sets the line color (hex). Returns the drawing id.",
    kind: "write",
    params: {
      type: "object",
      properties: {
        tool: { type: "string", description: "DRAW_TOOLS overlay name, e.g. horizontalStraightLine" },
        points: { type: "array", description: "[{timestamp (ms), value}] anchors" },
        text: { type: "string", description: "label shown near the drawing" },
        color: { type: "string", description: "line color hex, e.g. #FF4D4F" },
      },
      required: ["tool", "points"],
    },
    handler: async (args) => {
      const { overlays, epic, cellId } = focused();
      const tool = args.tool as string;
      if (!TOOL_NAMES.has(tool)) {
        throw new ActionError(
          "INVALID_ARGS",
          `unknown tool: ${tool} (one of ${[...TOOL_NAMES].join(", ")})`,
        );
      }
      const points = toPoints(args.points);
      const text = typeof args.text === "string" ? args.text : undefined;
      const color = typeof args.color === "string" ? args.color : undefined;

      // placeDrawing carries styles + extendData so the drawing reappears
      // identical (and persists) — unlike addDrawing's interactive path. The
      // label rides extendData.text here, so no follow-up setText: that would
      // rewrite the same value and cost a second persist (and a second history
      // capture, making one drawing take two undos).
      const styles =
        color && /^#[0-9a-fA-F]{6}$/.test(color)
          ? tool === "rect"
            ? {
                line: { color },
                polygon: { color: hexToRgba(color, 0.12), borderColor: color },
              }
            : { line: { color } }
          : undefined;
      const id = overlays.placeDrawing({
        name: tool,
        points,
        styles,
        extendData: text ? { text, priceLabels: true } : { priceLabels: true },
      });
      if (!id) throw new ActionError("DRAW_FAILED", "could not create the drawing");
      return { id, epic, cellId, tool };
    },
  });

  registerAction({
    name: "drawing.remove",
    description: "Remove one drawing from the focused chart by id (see drawing.list)",
    kind: "write",
    params: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (args) => {
      const { overlays, cellId } = focused();
      const id = args.id as string;
      const existing = overlays.getDrawing(id);
      if (!existing) throw new ActionError("NOT_FOUND", `no drawing with id ${id}`);
      overlays.remove(id);
      return { removed: id, cellId };
    },
  });

  registerAction({
    name: "drawing.clear",
    description: "Remove ALL user drawings from the focused chart",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => {
      const { overlays, epic, cellId } = focused();
      const before = overlays.listDrawings().length;
      overlays.clearDrawings();
      return { cleared: before, epic, cellId };
    },
  });
}
