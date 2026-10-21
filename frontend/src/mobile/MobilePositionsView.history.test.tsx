// @vitest-environment jsdom
// Tapping a History row on the phone opens that symbol on the chart tab.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  subscribeTrades: (fn: (t: unknown[]) => void) => {
    fn([]);
    return () => {};
  },
  getTradesAccount: () => "capital:demo",
  fetchAccountSummary: () => new Promise(() => {}),
  fetchBrokers: () => Promise.resolve({ data: [], exec: [] }),
}));
vi.mock("../HistoryPane", () => ({
  default: ({ onJumpToEpic }: { onJumpToEpic?: (epic: string, precisionGuess: number) => void }) => (
    <button onClick={() => onJumpToEpic?.("EURUSD", 5)}>history row</button>
  ),
}));

import MobilePositionsView from "./MobilePositionsView";
import { mobileSymbol, mobileTabSignal } from "./mobileChartState";
import { noteHistoryAccounts } from "../lib/trading";

afterEach(cleanup);

describe("MobilePositionsView History tab", () => {
  it("opens a tapped history row's symbol on the chart tab", async () => {
    noteHistoryAccounts([{ key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false, history: true }]);
    mobileTabSignal.set("positions");
    mobileSymbol.set(null);
    render(<MobilePositionsView />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "history row" }));
    await waitFor(() => expect(mobileTabSignal.value).toBe("chart"));
    expect(mobileSymbol.value?.epic).toBe("EURUSD");
    expect(mobileSymbol.value?.pricePrecision).toBe(5);
  });
});
