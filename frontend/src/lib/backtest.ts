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
  type Chart,
  type Indicator,
} from "klinecharts";
import { runBacktest, type BacktestRequest, type BacktestResult } from "../api";

export const EQUITY_INDICATOR = "EQUITY";

const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";

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
interface BacktestArtifacts {
  equityPaneId: string | null;
  markerIds: string[];
}
const artifactsByChart = new WeakMap<Chart, BacktestArtifacts>();

function artifactsFor(chart: Chart): BacktestArtifacts {
  let a = artifactsByChart.get(chart);
  if (!a) {
    a = { equityPaneId: null, markerIds: [] };
    artifactsByChart.set(chart, a);
  }
  return a;
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

  // Trade markers -> locked simpleAnnotation overlays (arrow + label).
  for (const m of result.markers) {
    const id = chart.createOverlay({
      name: "simpleAnnotation",
      points: [{ timestamp: m.time * 1000, value: m.price }],
      lock: true, // backtest artifacts: not user-editable
      extendData: markerLabel(m.side, m.leg, m.reason),
      styles: { line: { color: m.side === "buy" ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
    });
    if (typeof id === "string") artifacts.markerIds.push(id);
  }
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
}
