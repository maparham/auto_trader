// Agent chart actions: let MCP agents see and steer the focused chart the way
// a human does, as direct calls (never simulated clicks). Same provider
// idiom as drawings.ts: App re-sets the provider every render, handlers read
// through it at call time.
import { ActionError, registerAction } from "../registry";
import type { Chart } from "klinecharts";
import type { ChartController } from "../../lib/chartController";
import type { Period } from "../../lib/feed";
import { ALL_PERIODS, periodByResolution } from "../../lib/feed";
import { getIndicatorsByPane } from "../../lib/indicators";

export interface FocusedChart {
  chart: Chart;
  controller: ChartController;
  scope: string;
  epic: string;
  cellId: string;
  resolution: string;
  broker: string;
  setPeriod: (p: Period) => void;
}

type Provider = () => FocusedChart | null;
let provider: Provider | null = null;

export function setFocusedChartProvider(fn: Provider): void {
  provider = fn;
}

export function focusedChart(): FocusedChart {
  const cur = provider?.() ?? null;
  if (!cur) {
    throw new ActionError(
      "NO_FOCUSED_CHART",
      "no focused chart (is a chart with a symbol open and focused?)",
    );
  }
  return cur;
}

const MAX_BARS = 500;
const DEFAULT_BARS = 100;

interface Bar {
  timestamp: number; open: number; high: number; low: number; close: number; volume?: number;
}

export function registerChartActions(): void {
  registerAction({
    name: "chart.state",
    description:
      "Numeric state of the focused chart: epic, resolution, broker, visible time range, active indicators (id/type), a drawings summary (drawing.list's shape), and the last N visible candles (OHLCV). Read-only. Pair with chart.screenshot for the visual.",
    kind: "read",
    params: {
      type: "object",
      properties: {
        bars: { type: "number", description: `visible candles to return, newest last (default ${DEFAULT_BARS}, max ${MAX_BARS})` },
      },
    },
    handler: async (args) => {
      const { chart, controller, epic, cellId, resolution, broker } = focusedChart();
      const data = chart.getDataList() as Bar[];
      const vr = chart.getVisibleRange();
      const visFrom = Math.max(0, vr.from);
      const visTo = Math.min(data.length, vr.to);
      const visible = data.slice(visFrom, visTo);
      const want = Math.min(MAX_BARS, Math.max(1, Number(args.bars) || DEFAULT_BARS));
      const candles = visible.slice(-want).map((b) => ({
        timestamp: b.timestamp, open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume,
      }));
      return {
        epic, cellId, resolution, broker,
        visibleRange: {
          from: visible[0]?.timestamp ?? null,
          to: visible[visible.length - 1]?.timestamp ?? null,
          bars: visible.length,
        },
        barSpace: chart.getBarSpace().bar,
        indicators: controller.indicators.value.map((i) => ({ id: i.id, type: i.type, inset: i.inset })),
        drawings: controller.overlays.listDrawings(),
        candles,
        indicatorValues: indicatorValuesFor(chart, controller, candles.length, visTo),
      };
    },
  });

  registerAction({
    name: "chart.screenshot",
    description:
      "PNG of the focused chart exactly as rendered (candles, indicators, panes, drawings). Returns base64; use the ui_screenshot MCP tool to receive it as an image. Read-only. " +
        "Fails with TAB_HIDDEN when the app's browser tab is backgrounded; ask the user to focus the tab and retry.",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => {
      const { chart, epic, cellId, resolution } = focusedChart();
      // A backgrounded browser tab (document.hidden) cannot be screenshotted
      // reliably: live reproduction via the agent bridge probe showed the
      // per-pane canvas itself (chart._candlePane.getImage(true)) reading as
      // uniformly (0,0,0,0) - transparent, no drawn pixels - via BOTH
      // getImageData and that canvas's own toDataURL, even though the same
      // chart renders correctly once the tab is foregrounded again. That is
      // upstream of any compositing choice in this file (drawImage vs
      // getImageData/putImageData, background color, pane vs. chart-level
      // export all reproduced the same blank result), so there is nothing to
      // paper over here - failing loud beats silently returning a blank PNG.
      if (typeof document !== "undefined" && document.hidden) {
        throw new ActionError(
          "TAB_HIDDEN",
          "the app's browser tab is backgrounded; focus it and retry (chart rendering is unreliable while the tab is hidden)",
        );
      }
      const bg = chartBackgroundColor();
      const grab = (type: "png" | "jpeg") => {
        // Prefer our own pane-by-pane composite over klinecharts' own
        // getConvertPictureUrl, which draws each pane onto the output canvas
        // via ctx.drawImage(paneCanvas, ...) and, per the same live
        // reproduction, painted a background color underneath panes that
        // otherwise came out fully transparent. getImageData/putImageData is
        // a plain CPU pixel copy per pane instead. Falls back to the stock
        // export when the pane internals it depends on aren't there (fakes
        // in tests, or a future klinecharts version).
        const url = compositeChartPng(chart, bg, type) ?? chart.getConvertPictureUrl(true, type, bg);
        const comma = url.indexOf(",");
        const mime = url.slice(5, url.indexOf(";"));
        return { mime, b64: url.slice(comma + 1) };
      };
      try {
        let shot = grab("png");
        if (shot.b64.length > MAX_B64) shot = grab("jpeg");
        return { epic, cellId, resolution, mime: shot.mime, image_base64: shot.b64 };
      } catch (e) {
        throw new ActionError("SCREENSHOT_FAILED", `screenshot failed: ${String(e)}`);
      }
    },
  });

  registerAction({
    name: "chart.timeframe.set",
    description:
      "Switch the focused chart's timeframe. Accepts a resolution (HOUR_4) or its label (4H); see lib/feed ALL_PERIODS.",
    kind: "write",
    params: {
      type: "object",
      properties: { resolution: { type: "string", description: "e.g. HOUR, HOUR_4, DAY, or a label like 1H/4H/1D" } },
      required: ["resolution"],
    },
    handler: async (args) => {
      const f = focusedChart();
      const wanted = String(args.resolution);
      const period =
        periodByResolution(wanted) ??
        ALL_PERIODS.find((p) => p.label.toLowerCase() === wanted.toLowerCase());
      if (!period) {
        throw new ActionError(
          "INVALID_ARGS",
          `unknown timeframe: ${wanted} (one of ${ALL_PERIODS.map((p) => p.label).join(", ")})`,
        );
      }
      f.setPeriod(period);
      return { epic: f.epic, cellId: f.cellId, resolution: period.resolution };
    },
  });

  registerAction({
    name: "chart.range.set",
    description:
      "Scroll/zoom the focused chart to a time window. from/to are timestamps (ms; seconds accepted). Alternatively bars sets the visible bar count ending at the latest data.",
    kind: "write",
    params: {
      type: "object",
      properties: {
        from: { type: "number", description: "window start timestamp" },
        to: { type: "number", description: "window end timestamp" },
        bars: { type: "number", description: "visible bar count instead of from/to" },
      },
    },
    handler: async (args) => {
      const { chart, epic, cellId, resolution } = focusedChart();
      const toMs = (v: unknown): number | null => {
        if (v === undefined) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ActionError("INVALID_ARGS", "from/to: expected a number");
        return n < 1e12 ? n * 1000 : n;
      };
      const from = toMs(args.from);
      const to = toMs(args.to);
      const width = (chart as unknown as { getSize?: () => { width: number } | null }).getSize?.()?.width ?? 800;
      const data = chart.getDataList() as Array<{ timestamp: number }>;
      if (data.length < 2) throw new ActionError("NO_DATA", "chart has no data to navigate");
      const barMs = data[1].timestamp - data[0].timestamp;
      let bars = Number(args.bars) || 0;
      if (from != null && to != null) {
        if (to <= from) throw new ActionError("INVALID_ARGS", "to must be after from");
        bars = Math.max(2, Math.round((to - from) / barMs));
      }
      if (bars > 0) chart.setBarSpace(Math.max(0.5, Math.min(50, width / bars)));
      if (to != null) chart.scrollToTimestamp(to);
      else if (from != null) chart.scrollToTimestamp(from + (bars || 1) * barMs);
      else if (bars > 0) chart.scrollToTimestamp(data[data.length - 1].timestamp);
      return { epic, cellId, resolution, bars: bars || undefined };
    },
  });
}

// ~2 MB of base64 keeps the bridge frame well under the WS frame budget and
// the image big enough to read. Beyond it, drop to jpeg, which compresses
// candle charts far harder than png.
const MAX_B64 = 2_000_000;

interface InternalPane {
  getBounding: () => { top: number };
  getImage: (includeOverlay: boolean) => HTMLCanvasElement;
}
interface InternalChartInternals {
  _chartBounding: { width: number; height: number };
  _drawPanes: InternalPane[];
  _separatorPanes: Map<InternalPane, InternalPane>;
}

// Bypasses klinecharts' own multi-pane compositor (chart.getConvertPictureUrl,
// which composites each pane onto the output canvas via
// drawImage(paneCanvas, ...)) with a per-pane getImageData/putImageData copy
// instead, so a solid background can be painted underneath without the
// pane's own transparent pixels clobbering it (see the fillRect comment
// below). Only applies with the tab foregrounded - see the document.hidden
// guard at the chart.screenshot call site; every read/compositing strategy
// tried during live reproduction (this one included) came back blank while
// the tab was backgrounded, because the pane canvases themselves have no
// drawable content in that state, not because of how this function reads
// them. Returns null (the caller falls back to chart.getConvertPictureUrl)
// when the private fields it depends on aren't there, e.g. test doubles or a
// future klinecharts version.
function compositeChartPng(chart: Chart, backgroundColor: string, type: "png" | "jpeg"): string | null {
  const c = chart as unknown as Partial<InternalChartInternals>;
  if (!c._chartBounding || !Array.isArray(c._drawPanes)) return null;
  try {
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(c._chartBounding.width * ratio));
    canvas.height = Math.max(1, Math.round(c._chartBounding.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const putPane = (pane: InternalPane) => {
      const top = pane.getBounding().top;
      const img = pane.getImage(true);
      const ictx = img.getContext("2d");
      if (!ictx) return;
      const data = ictx.getImageData(0, 0, img.width, img.height);
      ctx.putImageData(data, 0, Math.round(top * ratio));
    };
    for (const pane of c._drawPanes) putPane(pane);
    // Thin dividers between panes (drag handles), skipped by putPane above
    // since they live in a separate map, not _drawPanes.
    if (c._separatorPanes instanceof Map) {
      for (const sep of c._separatorPanes.values()) putPane(sep);
    }
    // putImageData is a raw pixel replace, so every pane pixel it wrote above
    // (including fully transparent gaps) already overwrote alpha; painting
    // the background BEFORE the loop would just get clobbered. fillRect
    // respects globalCompositeOperation, so "destination-over" paints the
    // background only where the panes left nothing, without touching the
    // panes' own (already-final) pixels.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(`image/${type}`);
  } catch {
    return null;
  }
}

// Chart canvases paint on the page background (see chartTheme.ts's leading
// comment); read the same CSS custom property so a screenshot on the dark
// theme isn't stamped white. Falls back to white if neither resolves.
function chartBackgroundColor(): string {
  try {
    const style = getComputedStyle(document.documentElement);
    const v = style.getPropertyValue("--chart-bg").trim() || style.getPropertyValue("--bg").trim();
    return v || "#ffffff";
  } catch {
    return "#ffffff";
  }
}

// The values each indicator instance is DISPLAYING (its klinecharts result
// rows), aligned to the returned candles (newest last). Uses the real chart's
// indicator objects via getIndicatorsByPane; instances the chart hasn't
// computed yet just don't appear.
function indicatorValuesFor(
  chart: Chart,
  controller: ChartController,
  count: number,
  visTo: number,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const panes = getIndicatorsByPane(chart);
  const end = Math.max(0, visTo);
  const start = Math.max(0, end - count);
  for (const inst of controller.indicators.value) {
    for (const [, inds] of panes ?? []) {
      const ind = inds.get(inst.id) as { result?: unknown[] } | undefined;
      if (ind?.result?.length) {
        out[inst.id] = ind.result.slice(start, end);
        break;
      }
    }
  }
  return out;
}
