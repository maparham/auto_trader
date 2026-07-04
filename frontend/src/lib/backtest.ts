// Backtest visualization (task 7): trade markers as overlays + an equity curve
// in its own sub-pane via a custom "EQUITY" indicator.
//
// The equity series is dynamic (it depends on the backtest params), but an
// indicator's calc only sees the kline dataList. So we stash the equity series
// on the EQUITY instance's OWN extendData (a ts→value map) and the calc looks
// each bar up there. It must NOT live in a module global: the app runs one chart
// per cell but shares the single registered EQUITY template, so a global would
// let a backtest in one cell overwrite/clear another cell's curve. Per-chart
// bookkeeping (pane id + marker ids, for clearing) lives in a WeakMap keyed by
// the chart instance. Markers are created directly on the chart (NOT via the
// overlays manager) so they aren't persisted as user drawings — they're
// ephemeral backtest artifacts.

import {
  registerIndicator,
  IndicatorSeries,
  LineType,
  PolygonType,
  registerOverlay,
  type Chart,
  type Indicator,
  type OverlayTemplate,
  type OverlayFigure,
} from "klinecharts";
import { runBacktest, type BacktestRequest, type BacktestResult } from "../api";
import { applyVisibleRange } from "./chartSync";
import { backtestResultSignal, highlightTradeSignal, selectedTradeSignal } from "./signals";
import { tradeZones } from "./tradeZones";

type Trade = BacktestResult["trades"][number];

export const EQUITY_INDICATOR = "EQUITY";

const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";
// Entry-line accent — matches PositionLines' PRICE_COLOR (the role-based
// entry/price blue) so the selected-trade overlay reads consistently with the
// live trade lines, without importing that module's private const.
const ACCENT_COLOR = "#2962ff";

/** Chart marker label. Risk exits read by reason: stop/trailing => "SL",
 * target => "TP". Otherwise "+" opens a position and "-" closes it, prefixed by
 * the order side (B/S): open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  if (reason === "stop" || reason === "trail") return "SL";
  if (reason === "target") return "TP";
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}

// Per-chart backtest artifacts, so clearing one cell's backtest never touches
// another's. The equity series itself rides on the indicator instance's
// extendData (see calc), not here.
//
// Phase C: `trades` is the last run's result.trades (row.i indexes into it —
// same array the trades panel reads). `highlightOverlayId` is the single
// transient entry↔exit line drawn while a row/marker is hovered (never more
// than one at a time — see the highlightTradeSignal subscription below).
// `selectionOverlayIds` (Phase 2 Task 2) are the STICKY windowed risk/reward
// zone overlay ids drawn for the selectedTradeSignal trade — unlike the single
// transient highlight line, this is one `tradeZone` overlay (see below) but
// tracked as an array for symmetry with markerIds/removeAll and in case a
// future revision splits it into more than one overlay.
// `unsub` detaches BOTH the highlight and selection subscriptions this run
// installed, so a stale run's closures (over a now-cleared `trades`) can never
// fire after clearBacktest/re-run.
interface BacktestArtifacts {
  equityPaneId: string | null;
  markerIds: string[];
  trades: Trade[];
  highlightOverlayId: string | null;
  selectionOverlayIds: string[];
  // The result THIS chart rendered, so clearBacktest resets the global
  // hover/selection signals only when this chart owns the currently-active
  // backtest — closing an unrelated cell must not wipe another cell's selection.
  result: BacktestResult | null;
  unsub: (() => void) | null;
}
const artifactsByChart = new WeakMap<Chart, BacktestArtifacts>();

function artifactsFor(chart: Chart): BacktestArtifacts {
  let a = artifactsByChart.get(chart);
  if (!a) {
    a = {
      equityPaneId: null,
      markerIds: [],
      trades: [],
      highlightOverlayId: null,
      selectionOverlayIds: [],
      result: null,
      unsub: null,
    };
    artifactsByChart.set(chart, a);
  }
  return a;
}

/** Remove every overlay drawn for the sticky selection (windowed zone) and
 * reset the bookkeeping — shared by the reset-at-top-of-run, clearBacktest,
 * and the selectedTradeSignal subscription's own "replace" step. */
function removeSelectionOverlays(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.selectionOverlayIds) chart.removeOverlay(id);
  artifacts.selectionOverlayIds = [];
}

/** Pan/zoom the chart to center the trade's entry↔exit time span, with padding
 * for context. Reuses the date-range-sync geometry (applyVisibleRange) rather
 * than a bespoke scroll — same "given a time window, fit it" primitive the
 * cross-chart range sync uses (see chartSync.ts). Padding falls back to a
 * few-bars minimum so a same-bar (entry===exit) trade still yields a real,
 * non-empty window. */
function scrollChartToTrade(chart: Chart, entryTs: number, exitTs: number): void {
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  const barMs = Math.max(1, data[data.length - 1].timestamp - data[data.length - 2].timestamp);
  const from = Math.min(entryTs, exitTs);
  const to = Math.max(entryTs, exitTs);
  const pad = Math.max((to - from) * 0.25, barMs * 3);
  applyVisibleRange(chart, from - pad, to + pad);
}

const ZONE_OVERLAY = "tradeZone";

// extendData for a `tradeZone` overlay instance: everything createPointFigures
// needs BESIDES the pixel-projected points (below) — which fields to draw and
// the precomputed labels (tradeZones() output), plus win/loss for the
// entry→exit segment + exit dot color.
interface ZoneExtra {
  hasReward: boolean;
  hasRisk: boolean;
  stopMoved: boolean;
  rewardPct: number | null;
  riskPct: number | null;
  rr: number | null;
  win: boolean;
}
function asZoneExtra(v: unknown): ZoneExtra {
  return v as ZoneExtra;
}

// Small filled pill (white text on a solid tag), matching the label style
// PositionLines' tradeLine/bracket pills use elsewhere on the chart.
function pillFigure(
  x: number,
  y: number,
  text: string,
  bg: string,
  align: "left" | "center" | "right" = "left",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline: "middle" },
    styles: {
      color: "#ffffff",
      backgroundColor: bg,
      size: 11,
      family: "-apple-system, system-ui, sans-serif",
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 2,
      paddingBottom: 2,
      borderRadius: 3,
    },
    ignoreEvent: true,
  };
}

// The windowed risk/reward zone for the STICKILY selected trade (Phase 2 Task
// 2). A single custom overlay (registered once, like PositionLines'
// `tradeLine`) rather than several linked ones: klinecharts only hands
// createPointFigures the pixel coordinates for the overlay's OWN `points`, so
// every price level the drawing needs (entry, target, stop_initial,
// stop_final, exit) rides its own point — even ones that don't have a
// meaningful x (target/stop_initial/stop_final share the entry timestamp;
// only their y-pixel is read):
//   0 entry(entryTs, entry_price)      3 stopInitial(entryTs, stop_initial)
//   1 windowEnd(exitTs+pad, entry_price) 4 stopFinal(entryTs, stop_final)
//   2 target(entryTs, target)          5 exit(exitTs, exit_price)
// (points 2-4 fall back to entry_price when the level is absent — harmless
// since the figures that would read them are gated on hasReward/hasRisk/
// stopMoved instead.)
// Read-only backtest artifact: `lock: true` on creation AND every figure
// `ignoreEvent: true`, so it never intercepts clicks/crosshair — same
// discipline as the marker/highlight overlays above.
const tradeZoneOverlay: OverlayTemplate = {
  name: ZONE_OVERLAY,
  totalStep: 6,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length < 6) return [];
    const z = asZoneExtra(overlay.extendData);
    const [c0, c1, c2, c3, c4, c5] = coordinates;
    const figures: OverlayFigure[] = [];
    // The TP/SL edge pills sit just right of the window's right edge — flip to
    // the LEFT (mirrors PositionLines' bracket-pill flip) when that would spill
    // past the pane, so a trade near the right edge doesn't clip its labels.
    const flip = c1.x > bounding.width - 70;
    const edgeX = flip ? c1.x - 4 : c1.x + 4;
    const edgeAlign: "left" | "right" = flip ? "right" : "left";
    // Clamp the R:R pill so it can't clip above the pane top for an entry
    // near the very top of the visible price range.
    const rrY = Math.max(c0.y - 14, 10);
    if (z.hasReward) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c2.y), width: c1.x - c0.x, height: Math.abs(c0.y - c2.y) },
        styles: { style: PolygonType.Fill, color: `${BUY_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.hasRisk) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c3.y), width: c1.x - c0.x, height: Math.abs(c0.y - c3.y) },
        styles: { style: PolygonType.Fill, color: `${SELL_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.stopMoved) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c4.y }, { x: c1.x, y: c4.y }] },
        styles: { style: LineType.Dashed, dashedValue: [4, 4], color: `${SELL_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    // entry -> exit (win/loss colored, like the transient highlight line).
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c5.x, y: c5.y }] },
      styles: { style: LineType.Solid, color: z.win ? BUY_COLOR : SELL_COLOR, size: 1 },
      ignoreEvent: true,
    });
    // entry line (accent), spanning the window.
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c1.x, y: c0.y }] },
      styles: { style: LineType.Solid, color: ACCENT_COLOR, size: 1.5 },
      ignoreEvent: true,
    });
    // entry / exit dots.
    figures.push({ type: "circle", attrs: { x: c0.x, y: c0.y, r: 3 }, styles: { style: PolygonType.Fill, color: ACCENT_COLOR }, ignoreEvent: true });
    figures.push({ type: "circle", attrs: { x: c5.x, y: c5.y, r: 3 }, styles: { style: PolygonType.Fill, color: z.win ? BUY_COLOR : SELL_COLOR }, ignoreEvent: true });
    // Labels: R:R centered above the entry line; +reward%/-risk% at the TP/SL edges.
    if (z.rr != null) {
      figures.push(pillFigure((c0.x + c1.x) / 2, rrY, `R:R 1:${z.rr.toFixed(2)}`, ACCENT_COLOR, "center"));
    }
    if (z.hasReward && z.rewardPct != null) {
      figures.push(pillFigure(edgeX, c2.y, `+${z.rewardPct.toFixed(1)}%`, BUY_COLOR, edgeAlign));
    }
    if (z.hasRisk && z.riskPct != null) {
      figures.push(pillFigure(edgeX, c3.y, `-${z.riskPct.toFixed(1)}%`, SELL_COLOR, edgeAlign));
    }
    return figures;
  },
};

let zoneOverlayRegistered = false;
function ensureZoneOverlayRegistered(): void {
  if (zoneOverlayRegistered) return;
  zoneOverlayRegistered = true;
  registerOverlay(tradeZoneOverlay);
}

/** Draw the windowed risk/reward zone overlay for trade `t` and scroll the
 * chart to its entry↔exit span. Pushes the created overlay's id into
 * `artifacts.selectionOverlayIds` (the caller is responsible for clearing any
 * prior selection first — see the selectedTradeSignal subscription). */
function drawSelectionZone(chart: Chart, artifacts: BacktestArtifacts, t: Trade): void {
  ensureZoneOverlayRegistered();
  const z = tradeZones(t);
  const entryTs = t.entry_time * 1000;
  const exitTs = t.exit_time * 1000;
  const data = chart.getDataList();
  const barMs =
    data && data.length >= 2
      ? Math.max(1, data[data.length - 1].timestamp - data[data.length - 2].timestamp)
      : 1;
  const pad = Math.max(Math.abs(exitTs - entryTs) * 0.15, barMs);
  const windowEnd = Math.max(entryTs, exitTs) + pad;
  const id = chart.createOverlay({
    name: ZONE_OVERLAY,
    lock: true,
    points: [
      { timestamp: entryTs, value: t.entry_price },
      { timestamp: windowEnd, value: t.entry_price },
      { timestamp: entryTs, value: z.hasReward ? (t.target as number) : t.entry_price },
      { timestamp: entryTs, value: z.hasRisk ? (t.stop_initial as number) : t.entry_price },
      { timestamp: entryTs, value: z.stopMoved ? (t.stop_final as number) : t.entry_price },
      { timestamp: exitTs, value: t.exit_price },
    ],
    extendData: {
      hasReward: z.hasReward,
      hasRisk: z.hasRisk,
      stopMoved: z.stopMoved,
      rewardPct: z.rewardPct,
      riskPct: z.riskPct,
      rr: z.rr,
      win: t.pnl >= 0,
    } satisfies ZoneExtra,
  });
  if (typeof id === "string") artifacts.selectionOverlayIds.push(id);
  scrollChartToTrade(chart, entryTs, exitTs);
}

export function registerBacktestIndicators(): void {
  registerIndicator<{ equity?: number }>({
    name: EQUITY_INDICATOR,
    shortName: "Equity",
    series: IndicatorSeries.Normal,
    precision: 2,
    figures: [{ key: "equity", title: "Equity: ", type: "line" }],
    // Read THIS instance's equity map off its extendData — never a module global,
    // so each cell's EQUITY pane plots its own backtest (see runAndRender).
    calc: (dataList, indicator: Indicator) => {
      const equity = indicator.extendData as Map<number, number> | undefined;
      if (!equity) return dataList.map(() => ({}));
      return dataList.map((k) => {
        const v = equity.get(k.timestamp);
        return v != null ? { equity: v } : {};
      });
    },
  });
}

export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
): Promise<BacktestResult> {
  const result = await runBacktest(req);
  // Drops the previous run's markers/equity/highlight/selection zone AND
  // detaches its highlight/selection subscriptions + resets
  // highlightTradeSignal/selectedTradeSignal — so a stale trade index from the
  // prior result can never draw against this run's data.
  clearBacktest(chart);
  const artifacts = artifactsFor(chart);

  // Equity curve -> own sub-pane. The series travels on the instance's
  // extendData so this chart's calc looks up its own values.
  const equityByTs = new Map(result.equity.map((p) => [p.time * 1000, p.value]));
  artifacts.equityPaneId =
    chart.createIndicator(
      { name: EQUITY_INDICATOR, extendData: equityByTs },
      false,
    ) ?? null;

  // time|leg -> trade index, so each fill marker can be tied back to the trade
  // it belongs to (its opening fill is at entry_time, its closing fill at
  // exit_time, both tagged with the trade's leg).
  const tradeIndexByFill = new Map<string, number>();
  result.trades.forEach((t, i) => {
    tradeIndexByFill.set(`${t.entry_time}|${t.leg}`, i);
    tradeIndexByFill.set(`${t.exit_time}|${t.leg}`, i);
  });

  // Trade markers -> locked simpleAnnotation overlays (arrow + label). Markers
  // that map to a trade also emphasize/scroll the trades panel row on hover
  // (chart -> row half of the two-way sync; the row -> chart half is the
  // highlightTradeSignal subscription below).
  //
  // highlightTradeSignal/selectedTradeSignal/backtestResultSignal are module-global
  // (one trades panel for the whole app), but a backtest can be running/rendered
  // in more than one cell's chart at once. Gate every emit/consume on
  // `backtestResultSignal.value === result` (identity, not equality — the panel
  // is set from this exact object in BacktestButton) so only the chart whose
  // result is the one actually shown in the panel participates; a
  // not-currently-displayed cell's markers/lines stay inert instead of
  // cross-talking into another chart's trade indices.
  for (const m of result.markers) {
    const idx = tradeIndexByFill.get(`${m.time}|${m.leg}`);
    const id = chart.createOverlay({
      name: "simpleAnnotation",
      points: [{ timestamp: m.time * 1000, value: m.price }],
      lock: true, // backtest artifacts: not user-editable
      extendData: markerLabel(m.side, m.leg, m.reason),
      styles: { line: { color: m.side === "buy" ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
      ...(idx !== undefined
        ? {
            onMouseEnter: () => {
              if (backtestResultSignal.value === result) highlightTradeSignal.set(idx);
              return false;
            },
            onMouseLeave: () => {
              if (backtestResultSignal.value === result) highlightTradeSignal.set(null);
              return false;
            },
          }
        : {}),
    });
    if (typeof id === "string") artifacts.markerIds.push(id);
  }

  artifacts.trades = result.trades;
  artifacts.result = result;

  // Row -> chart: draw ONE transient locked line spanning entry -> exit,
  // colored win/loss, while a row (or a marker, above) is highlighted; null
  // removes it. Never persisted, never more than one at a time.
  const unsubHighlight = highlightTradeSignal.subscribe((i) => {
    // Every subscriber clears its OWN leftover line unconditionally (so a chart
    // that just lost "active" status — the panel switched to another cell's
    // result — can't strand a stale line), but only the panel's currently
    // active backtest draws a new one (see note above).
    if (artifacts.highlightOverlayId) {
      chart.removeOverlay(artifacts.highlightOverlayId);
      artifacts.highlightOverlayId = null;
    }
    if (i == null || backtestResultSignal.value !== result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    const id = chart.createOverlay({
      name: "segment",
      points: [
        { timestamp: t.entry_time * 1000, value: t.entry_price },
        { timestamp: t.exit_time * 1000, value: t.exit_price },
      ],
      lock: true,
      needDefaultPointFigure: false,
      styles: { line: { color: t.pnl >= 0 ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
    });
    artifacts.highlightOverlayId = typeof id === "string" ? id : null;
  });

  // Row click -> chart: draw the STICKY windowed risk/reward zone for the
  // selected trade and pan/zoom to its span; null removes it. Unlike the
  // transient highlight above, this persists until the selection changes —
  // gated the same way (identity on backtestResultSignal) so only the chart
  // backing the panel's currently displayed result draws/moves.
  // (focusTradeSignal — the older one-shot "just scroll" signal — lost its
  // click publisher when the panel switched to selectedTradeSignal; this
  // subscription is the one that now does both the draw AND the scroll, so
  // focusTradeSignal is no longer consumed here.)
  const unsubSelection = selectedTradeSignal.subscribe((i) => {
    // Every subscriber clears its OWN leftover zone unconditionally (same
    // "active chart may have changed" reasoning as the highlight above).
    removeSelectionOverlays(chart, artifacts);
    if (i == null || backtestResultSignal.value !== result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    drawSelectionZone(chart, artifacts, t);
  });

  artifacts.unsub = () => {
    unsubHighlight();
    unsubSelection();
  };

  return result;
}

export function clearBacktest(chart: Chart): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts) return;
  for (const id of artifacts.markerIds) chart.removeOverlay(id);
  artifacts.markerIds = [];
  if (artifacts.equityPaneId) {
    chart.removeIndicator(artifacts.equityPaneId, EQUITY_INDICATOR);
    artifacts.equityPaneId = null;
  }
  if (artifacts.highlightOverlayId) {
    chart.removeOverlay(artifacts.highlightOverlayId);
    artifacts.highlightOverlayId = null;
  }
  removeSelectionOverlays(chart, artifacts);
  if (artifacts.unsub) {
    artifacts.unsub();
    artifacts.unsub = null;
  }
  artifacts.trades = [];
  // Reset the GLOBAL hover/selection signals ONLY when this chart owns the
  // currently-active backtest — otherwise clearing/unmounting an UNRELATED cell
  // would fire another cell's live subscription and wipe its shown selection.
  // Stale-index safety on re-run still holds: the owning chart's own
  // runAndRender calls clearBacktest at the top while it is still the active
  // result, so this condition is true and the reset happens.
  if (backtestResultSignal.value === artifacts.result) {
    highlightTradeSignal.set(null);
    selectedTradeSignal.set(null);
  }
  artifacts.result = null;
}
