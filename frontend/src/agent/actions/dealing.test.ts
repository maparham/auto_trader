import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { handleFrame } from "../bridge";
import { clearRegistryForTest, listActions } from "../registry";
import { registerDealingActions } from "./dealing";
import { setCellReplaying } from "../../lib/replayingCells";

vi.mock("../confirm");
vi.mock("../../lib/trading", () => ({
  getTradesAccount: () => "capital:paper",
  placeOrder: vi.fn(async () => ({ dealId: "d1" })),
  closePosition: vi.fn(async () => ({ dealId: "d2" })),
  cancelWorkingOrder: vi.fn(async () => ({ dealId: "d3" })),
}));

// Driven through the bridge rather than by reaching into the registry: the
// warning only matters if it survives the whole path to requestAgentConfirm,
// and that path is also where confirmContext is merged and the handler's args
// are kept clean.
const approve = async (action: string, args: Record<string, unknown>) => {
  const { requestAgentConfirm } = await import("../confirm");
  vi.mocked(requestAgentConfirm).mockResolvedValue(true);
  await handleFrame({ id: "1", op: "invoke", action, args }, () => {});
  await new Promise((r) => setTimeout(r, 0));
  return vi.mocked(requestAgentConfirm).mock.calls.at(-1)?.[0];
};

const CASES: Array<[string, Record<string, unknown>]> = [
  ["order.place", { epic: "US100", side: "buy", quantity: 1, type: "market" }],
  ["position.close", { dealId: "d1" }],
  ["order.cancel", { orderId: "o1" }],
];

beforeEach(() => {
  vi.clearAllMocks();
  clearRegistryForTest();
  setCellReplaying("cell-a", false);
  setCellReplaying("cell-elsewhere", false);
  registerDealingActions();
});

describe("dealing actions during a chart replay session", () => {
  // The whole point: nothing about the ARGS changes, so without this the dialog
  // is identical to the practice orders the user has been approving all session.
  it.each(CASES)("%s warns that the order is real", async (action, args) => {
    setCellReplaying("cell-a", true);
    expect((await approve(action, args))?.warning).toMatch(/REAL/);
  });

  it.each(CASES)("%s says nothing when no cell is replaying", async (action, args) => {
    expect((await approve(action, args))?.warning).toBeNull();
  });

  // Any cell, not the focused one: the session that primes a user to read an
  // order as practice need not be the cell they are looking at.
  it("warns for a session on a cell other than the one in view", async () => {
    setCellReplaying("cell-elsewhere", true);
    expect((await approve(...CASES[0]))?.warning).toMatch(/REAL/);
  });

  it("stops warning once that session ends", async () => {
    setCellReplaying("cell-elsewhere", true);
    setCellReplaying("cell-elsewhere", false);
    expect((await approve(...CASES[0]))?.warning).toBeNull();
  });

  // A warning is not a block: these act on the ACCOUNT, and a chart replaying
  // somewhere is no reason to refuse a deliberate, approved order.
  it("never withdraws the actions themselves", async () => {
    setCellReplaying("cell-a", true);
    const names = listActions().map((a) => a.name);
    for (const [action] of CASES) expect(names).toContain(action);
  });
});
