// @vitest-environment jsdom
// The History tab shows only for accounts with broker history, and opens the pane.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("./Mt5DeployButton", () => ({ default: () => null }));
vi.mock("./HistoryPane", () => ({ default: ({ account }: { account: string }) => <div>history for {account}</div> }));

import PositionsPanel from "./PositionsPanel";
import { noteHistoryAccounts, type BrokerAccount } from "./lib/trading";
import { DEFAULT_SETTINGS } from "./theme";

const accounts: BrokerAccount[] = [
  { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false, history: false },
  { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false, history: true },
];

function mount(account: string) {
  noteHistoryAccounts(accounts);
  render(<PositionsPanel account={account} accounts={accounts} trading={DEFAULT_SETTINGS.trading} />);
}

afterEach(cleanup);

describe("PositionsPanel History tab", () => {
  it("is absent on an account without broker history", () => {
    mount("capital:paper");
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("opens the history pane for a history account", () => {
    mount("capital:demo");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("history for capital:demo")).toBeTruthy();
    expect(screen.queryByText("No open positions.")).toBeNull();
  });
});
