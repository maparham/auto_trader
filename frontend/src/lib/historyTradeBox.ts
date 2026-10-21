// The selected History row's trade box (spec 2026-10-21-capital-account-history):
// a LOCKED, grip-less overlay (tradeBoxView) created straight on the chart, never through the drawing
// controller, so it can't be moved or edited and is never persisted. It lives
// exactly as long as the selection: deselecting, switching account or a reload
// (the selection is session state) takes it away.
import type { Chart, KLineData } from "klinecharts";
import type { ClosedTradeView } from "./accountHistory";
import { historyTradeRow } from "./historyTable";
import { tradeBoxSpec } from "./tradeList";
import { TRADE_BOX_VIEW } from "./tradeOverlay";

type BoxChart = Pick<Chart, "createOverlay" | "removeOverlay">;
type BoxBar = Pick<KLineData, "timestamp" | "high" | "low">;

export interface HistoryTradeBox {
  /** Draw `trade` when it belongs on `epic`, else nothing. Cheap to call on
   * every paint: the overlay is only rebuilt when its shape changes (the stop
   * reshapes once the loaded bars come to cover the trade). */
  sync(trade: ClosedTradeView | null | undefined, epic: string, bars: readonly BoxBar[]): void;
  dispose(): void;
}

export function createHistoryTradeBox(chart: BoxChart): HistoryTradeBox {
  let id: string | null = null;
  let sig = "";
  const clear = () => {
    if (id) chart.removeOverlay({ id });
    id = null;
  };
  return {
    sync(trade, epic, bars) {
      const row = trade && trade.epic === epic ? historyTradeRow(trade) : null;
      const spec = row ? tradeBoxSpec(row, bars) : null;
      const covered = row != null && bars.length > 0 && bars[0].timestamp <= row.entryTs;
      const next = spec ? `${JSON.stringify(spec)}|${covered}` : "";
      if (next === sig) return;
      sig = next;
      clear();
      if (!spec) return;
      const created = chart.createOverlay({
        name: TRADE_BOX_VIEW,
        lock: true,
        points: spec.points,
        extendData: { text: spec.text, priceLabels: true },
      });
      id = typeof created === "string" ? created : null;
    },
    dispose() {
      clear();
      sig = "";
    },
  };
}
