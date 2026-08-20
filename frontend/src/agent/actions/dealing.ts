// Confirm-gated dealing actions. The registry kind "confirm" means bridge.ts
// parks execution on an in-browser Approve click (agent/confirm.ts); these
// handlers only run after approval.
//
// Account: every handler acts against getTradesAccount() (the account the
// trades feed / dock currently targets), the same choice the chart trade pills
// make. placeOrder otherwise defaults the body to DEFAULT_ACCOUNT, which is NOT
// the user's selection, so it is passed explicitly. The agent never names the
// account, so each action publishes it through confirmContext: the Approve
// dialog must state which account is about to be traded, and each handler
// resolves it ONCE at entry and reuses that value for every call it makes.
//
// Param names mirror the real OrderRequest in lib/trading (limit_level /
// stop_level / take_profit_level), not friendlier aliases, so what an agent
// sends is exactly what the API receives.
import { registerAction } from "../registry";
import {
  cancelWorkingOrder, closePosition, getTradesAccount, placeOrder,
  type OrderRequest, type OrderSide,
} from "../../lib/trading";
import { anyCellReplaying } from "../../lib/replayingCells";

// These actions are REAL dealing, always — a replay session is a per-cell study
// mode with a local ledger, and it has no bearing on an account. That is exactly
// why the warning exists rather than a block: blocking the account because one
// chart is replaying would be wrong, but so is letting the approval dialog look
// identical when the user has spent the last ten minutes placing practice
// orders on a blind chart. The dialog says which account; this says which WORLD.
//
// Any cell, not the focused one: the session that primes the user to read an
// order as practice does not have to be the cell they are looking at now.
const REPLAY_WARNING =
  "A chart replay session is running. This is a REAL order on the live account, not a replay trade.";
const dealingWarning = (): string | null => (anyCellReplaying() ? REPLAY_WARNING : null);

export function registerDealingActions(): void {
  registerAction({
    name: "order.place",
    description:
      "Place an order on the currently selected trading account (requires in-browser approval; the approval dialog shows the target account)",
    kind: "confirm",
    confirmContext: () => ({ account: getTradesAccount() }),
    confirmWarning: dealingWarning,
    params: {
      type: "object",
      properties: {
        epic: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number" },
        type: { type: "string", enum: ["market", "limit"] },
        limit_level: { type: "number", description: "entry level (limit orders only)" },
        stop_level: { type: "number", description: "stop loss level" },
        take_profit_level: { type: "number", description: "take profit level" },
        expires_at: {
          type: "string",
          description: "UTC ISO good-till-date for a limit order; absent = GTC",
        },
      },
      required: ["epic", "side", "quantity", "type"],
    },
    handler: async (args) => {
      const account = getTradesAccount();
      const req: OrderRequest = {
        epic: args.epic as string,
        side: args.side as OrderSide,
        quantity: args.quantity as number,
        account,
        source: "manual",
        type: args.type as "market" | "limit",
        limit_level: (args.limit_level as number | undefined) ?? null,
        stop_level: (args.stop_level as number | undefined) ?? null,
        take_profit_level: (args.take_profit_level as number | undefined) ?? null,
        expires_at: (args.expires_at as string | undefined) ?? null,
        // The API requires this for a real-money account. The in-browser Approve
        // click is the human gate that backs it, so it is always set here.
        confirm: true,
      };
      // Echo the account back so the agent's transcript records which one was
      // actually traded, not just which one was selected when it asked.
      return { account, ...(await placeOrder(req)) };
    },
  });

  registerAction({
    name: "position.close",
    description:
      "Close an open position on the currently selected trading account, fully or partially (requires in-browser approval; the approval dialog shows the target account)",
    kind: "confirm",
    confirmContext: () => ({ account: getTradesAccount() }),
    confirmWarning: dealingWarning,
    params: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        quantity: { type: "number", description: "partial size; absent = close in full" },
      },
      required: ["dealId"],
    },
    handler: async (args) => {
      const account = getTradesAccount();
      const result = await closePosition(
        args.dealId as string,
        account,
        args.quantity as number | undefined,
      );
      return { account, ...result };
    },
  });

  registerAction({
    name: "order.cancel",
    description:
      "Cancel a resting working order on the currently selected trading account (requires in-browser approval; the approval dialog shows the target account)",
    kind: "confirm",
    confirmContext: () => ({ account: getTradesAccount() }),
    confirmWarning: dealingWarning,
    params: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
    handler: async (args) => {
      const account = getTradesAccount();
      return { account, ...(await cancelWorkingOrder(args.orderId as string, account)) };
    },
  });
}
