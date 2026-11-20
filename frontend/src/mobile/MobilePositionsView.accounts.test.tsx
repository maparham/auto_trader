// @vitest-environment jsdom
// The phone's "All accounts" tab: the desktop pane on the shared polling hook,
// shown with two or more dealing accounts, a row tap routed to
// openMobileAccountPosition.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { BrokerAccount, TradeView } from "../lib/trading";

const exec = vi.hoisted(() => ({ list: [] as BrokerAccount[] }));
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  subscribeTrades: (fn: (t: unknown[]) => void) => {
    fn([]);
    return () => {};
  },
  getTradesAccount: () => "capital:demo",
  fetchAccountSummary: () => new Promise(() => {}),
  cachedBrokers: () => ({ data: [], exec: exec.list }),
  fetchBrokers: () => Promise.resolve({ data: [], exec: exec.list }),
}));

const hookArgs = vi.hoisted(() => ({ last: null as null | { open: boolean; enabled?: boolean } }));
const pos: TradeView = {
  kind: "position",
  id: "deal-9",
  epic: "GOLD",
  side: "buy",
  quantity: 1,
  priceLevel: 2400.5,
  stop: null,
  takeProfit: null,
  upnl: 3,
  openedAt: 0,
  expiresAt: null,
  leverage: null,
  margin: null,
};
vi.mock("../app/useAllAccounts", () => ({
  useAllAccounts: (opts: { open: boolean; enabled?: boolean; accounts: BrokerAccount[] }) => {
    hookArgs.last = opts;
    const visible = opts.accounts.filter((a) => a.env !== "paper" && !a.dataOnly);
    return {
      visible,
      hidden: [],
      snaps: {
        "capital-live:live": { account: "capital-live:live", positions: [pos], summary: null, error: null, fetchedAt: 1 },
      },
      count: 1,
      updatedAt: 1,
      refresh: () => {},
      setHidden: () => {},
      hasAccounts: visible.length > 0,
    };
  },
}));

const openMobileAccountPosition = vi.fn();
vi.mock("./mobileChartState", async (orig) => ({
  ...(await orig<object>()),
  openMobileAccountPosition: (...a: unknown[]) => openMobileAccountPosition(...a),
}));

import MobilePositionsView from "./MobilePositionsView";

const demo: BrokerAccount = { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false };
const live: BrokerAccount = { key: "capital-live:live", broker: "capital-live", env: "live", isRealMoney: true };

beforeEach(() => {
  openMobileAccountPosition.mockReset();
  hookArgs.last = null;
});
afterEach(cleanup);

describe("MobilePositionsView All accounts tab", () => {
  it("is hidden with fewer than two dealing accounts", async () => {
    exec.list = [demo, { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false }];
    render(<MobilePositionsView />);
    await waitFor(() => expect(hookArgs.last).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^All accounts/ })).toBeNull();
  });

  it("shows the count, polls fast only while open, and opens a tapped row", async () => {
    exec.list = [demo, live];
    render(<MobilePositionsView />);
    const tab = await screen.findByRole("button", { name: /^All accounts\s*1$/ });
    expect(hookArgs.last?.open).toBe(false);
    fireEvent.click(tab);
    expect(hookArgs.last?.open).toBe(true);
    fireEvent.click(screen.getByText("GOLD"));
    expect(openMobileAccountPosition).toHaveBeenCalledWith("capital-live:live", "GOLD", 2);
  });
});
