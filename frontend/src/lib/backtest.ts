// Backtest visualization (task 7): trade markers as overlays + an equity curve
// in its own sub-pane via a custom "EQUITY" indicator.
//
// The equity series is dynamic (it depends on the backtest params), but an
// indicator's calc only sees the kline dataList. So we stash the latest equity
// series in a module-level map keyed by timestamp; the calc looks each bar up.
// Markers are created directly on the chart (NOT via the overlays manager) so
// they aren't persisted as user drawings — they're ephemeral backtest artifacts.

import {
  registerIndicator,
  IndicatorSeries,
  LineType,
  type Chart,
} from "klinecharts";
import { runBacktest, type BacktestRequest, type BacktestResult } from "../api";

export const EQUITY_INDICATOR = "EQUITY";

const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";

/** Chart marker label: "+" opens a position, "-" closes it; the letter is the
 * order side (B/S). open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short"): string {
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}

let equityByTs = new Map<number, number>();
let equityPaneId: string | null = null;
let markerIds: string[] = [];

export function registerBacktestIndicators(): void {
  registerIndicator<{ equity?: number }>({
    name: EQUITY_INDICATOR,
    shortName: "Equity",
    series: IndicatorSeries.Normal,
    precision: 2,
    figures: [{ key: "equity", title: "Equity: ", type: "line" }],
    calc: (dataList) =>
      dataList.map((k) => {
        const v = equityByTs.get(k.timestamp);
        return v != null ? { equity: v } : {};
      }),
  });
}

export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
): Promise<BacktestResult> {
  const result = await runBacktest(req);
  clearBacktest(chart);

  // Equity curve -> own sub-pane.
  equityByTs = new Map(result.equity.map((p) => [p.time * 1000, p.value]));
  equityPaneId = chart.createIndicator(EQUITY_INDICATOR, false) ?? null;

  // Trade markers -> locked simpleAnnotation overlays (arrow + label).
  for (const m of result.markers) {
    const id = chart.createOverlay({
      name: "simpleAnnotation",
      points: [{ timestamp: m.time * 1000, value: m.price }],
      lock: true, // backtest artifacts: not user-editable
      extendData: markerLabel(m.side, m.leg),
      styles: { line: { color: m.side === "buy" ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
    });
    if (typeof id === "string") markerIds.push(id);
  }
  return result;
}

export function clearBacktest(chart: Chart): void {
  for (const id of markerIds) chart.removeOverlay(id);
  markerIds = [];
  if (equityPaneId) {
    chart.removeIndicator(equityPaneId, EQUITY_INDICATOR);
    equityPaneId = null;
  }
  equityByTs = new Map();
}
