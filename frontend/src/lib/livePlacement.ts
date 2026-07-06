import type { LiveAction } from "./liveTypes";
import { deriveOrderId } from "./liveHelpers";
import { placeOrder as realPlaceOrder, closePosition as realClosePosition, type TradeView } from "./trading";

interface Deps {
  placeOrder: typeof realPlaceOrder;
  closePosition: typeof realClosePosition;
}

export interface PlacementParams {
  strategyId: string;
  barTsSec: number;
  epic: string;
  account: string;
  quantity: number;
  confirm: boolean;
  openPosition: TradeView | null;
  _deps?: Deps;
}

export interface PlacementOutcome {
  action: LiveAction;
  ok: boolean;
  detail: string;
  dealId?: string | null; // broker deal id of a filled open, for strat-tagging
  fillPrice?: number | null; // fill price of a filled close, for journal P&L
}

export async function placeActions(
  actions: LiveAction[],
  params: PlacementParams,
): Promise<PlacementOutcome[]> {
  const deps = params._deps ?? { placeOrder: realPlaceOrder, closePosition: realClosePosition };
  const out: PlacementOutcome[] = [];
  for (const action of actions) {
    try {
      if (action.kind === "open") {
        const res = await deps.placeOrder({
          epic: params.epic,
          side: action.side,
          quantity: params.quantity,
          account: params.account,
          source: "strategy",
          type: "market",
          stop_level: action.stop_level ?? null,
          take_profit_level: action.take_profit_level ?? null,
          confirm: params.confirm,
          client_order_id: deriveOrderId(params.strategyId, params.barTsSec, action.leg, action.side),
        });
        out.push({ action, ok: res.status !== "rejected", detail: res.status, dealId: res.deal_id });
      } else {
        if (!params.openPosition) {
          out.push({ action, ok: true, detail: "already flat" });
          continue;
        }
        const res = await deps.closePosition(params.openPosition.id, params.account);
        out.push({ action, ok: res.status !== "rejected", detail: res.status, fillPrice: res.fill_price });
      }
    } catch (e) {
      out.push({ action, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
