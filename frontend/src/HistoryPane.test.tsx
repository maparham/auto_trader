// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { HistoryState } from "./lib/accountHistory";

let state: HistoryState = { loading: false, error: null, data: null };
const subscribe = vi.fn((_a: string, _d: number, fn: (s: HistoryState) => void) => {
  fn(state);
  return () => {};
});
const refresh = vi.fn();
vi.mock("./lib/accountHistory", async (orig) => ({
  ...(await orig<typeof import("./lib/accountHistory")>()),
  subscribeHistory: (a: string, d: number, fn: (s: HistoryState) => void) => subscribe(a, d, fn),
  refreshHistory: (a: string) => refresh(a),
}));

import HistoryPane from "./HistoryPane";

const totals = { realized: 0, funding: 0, deposits: 0, withdrawals: 0, currency: "EUR" };
afterEach(() => {
  cleanup();
  subscribe.mockClear();
});

describe("HistoryPane", () => {
  it("shows an empty state and zero totals for an account with no history", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("No closed trades in this range.")).toBeTruthy();
    expect(screen.getByText("Realized").parentElement!.textContent).toContain("0");
  });

  it("marks a trade opened before the range and colours P&L", () => {
    state = {
      loading: false, error: null,
      data: {
        trades: [{ dealId: "D1", epic: "TSLA", side: "buy", size: 1, entry: 400, exit: 430, openedAt: null,
          closedAt: 1_792_570_721_723, closeSource: "TP", pnl: 12.5, currency: "EUR" }],
        ledger: [], totals: { ...totals, realized: 12.5 },
      },
    };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("before range")).toBeTruthy();
    expect(screen.getByText("+12.50").className).toContain("pp-pos");
  });

  it("formats a 5-decimal price unrounded when no precisionFor is given", () => {
    state = {
      loading: false, error: null,
      data: {
        trades: [{ dealId: "D1", epic: "EURUSD", side: "buy", size: 1, entry: 1.08345, exit: 1.0845,
          openedAt: 1, closedAt: 2, closeSource: "TP", pnl: 1.2, currency: "EUR" }],
        ledger: [], totals: { ...totals, realized: 1.2 },
      },
    };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("1.08345")).toBeTruthy();
  });

  it("marks the trade row clickable only when onJumpToEpic is given", () => {
    state = {
      loading: false, error: null,
      data: {
        trades: [{ dealId: "D1", epic: "TSLA", side: "buy", size: 1, entry: 400, exit: 430, openedAt: 1,
          closedAt: 2, closeSource: "TP", pnl: 12.5, currency: "EUR" }],
        ledger: [], totals: { ...totals, realized: 12.5 },
      },
    };
    const { rerender } = render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("TSLA").closest("tr")!.className).not.toContain("pp-clickable");
    const jump = vi.fn();
    rerender(<HistoryPane account="capital:demo" onJumpToEpic={jump} />);
    expect(screen.getByText("TSLA").closest("tr")!.className).toContain("pp-clickable");
    fireEvent.click(screen.getByText("TSLA"));
    // A price, never: the second arg is jumpToEpic's precision guess.
    expect(jump).toHaveBeenCalledWith("TSLA", 0);
    cleanup();
    render(<HistoryPane account="capital:demo" precisionFor={() => 2} onJumpToEpic={jump} />);
    fireEvent.click(screen.getByText("TSLA"));
    expect(jump).toHaveBeenLastCalledWith("TSLA", 2);
  });

  it("routes a click to onSelectTrade, or to onJumpToEpic when the open time is unknown", () => {
    const row = { dealId: "D1", epic: "TSLA", side: "buy" as const, size: 1, entry: 400, exit: 430,
      closedAt: 2_000, closeSource: "TP", pnl: 12.5, currency: "EUR" };
    state = {
      loading: false, error: null,
      data: {
        trades: [{ ...row, openedAt: 1_000 }, { ...row, dealId: "D2", epic: "MSFT", openedAt: null }],
        ledger: [], totals,
      },
    };
    const select = vi.fn();
    const jump = vi.fn();
    render(<HistoryPane account="capital:demo" onSelectTrade={select} onJumpToEpic={jump} />);
    fireEvent.click(screen.getByText("TSLA"));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ symbol: "TSLA", entryTs: 1_000, exitTs: 2_000 }));
    expect(jump).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("MSFT"));
    expect(jump).toHaveBeenCalledWith("MSFT", 0);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps the clicked row selected across a remount, per account", () => {
    const row = { dealId: "D1", epic: "TSLA", side: "buy" as const, size: 1, entry: 400, exit: 430,
      openedAt: 1_000, closedAt: 2_000, closeSource: "TP", pnl: 12.5, currency: "EUR" };
    state = { loading: false, error: null, data: { trades: [row, { ...row, dealId: "D2", epic: "MSFT" }], ledger: [], totals } };
    render(<HistoryPane account="capital:sel" onSelectTrade={() => {}} />);
    fireEvent.click(screen.getByText("MSFT"));
    expect(screen.getByText("MSFT").closest("tr")!.className).toContain("pp-selected");
    expect(screen.getByText("TSLA").closest("tr")!.className).not.toContain("pp-selected");
    cleanup();
    render(<HistoryPane account="capital:sel" onSelectTrade={() => {}} />);
    expect(screen.getByText("MSFT").closest("tr")!.className).toContain("pp-selected");
    cleanup();
    render(<HistoryPane account="capital:other" onSelectTrade={() => {}} />);
    expect(screen.getByText("MSFT").closest("tr")!.className).not.toContain("pp-selected");
  });

  it("does not select rows that have no click handler", () => {
    const row = { dealId: "D9", epic: "TSLA", side: "buy" as const, size: 1, entry: 400, exit: 430,
      openedAt: 1_000, closedAt: 2_000, closeSource: "TP", pnl: 12.5, currency: "EUR" };
    state = { loading: false, error: null, data: { trades: [row], ledger: [], totals } };
    render(<HistoryPane account="capital:plain" />);
    fireEvent.click(screen.getByText("TSLA"));
    expect(screen.getByText("TSLA").closest("tr")!.className).not.toContain("pp-selected");
  });

  it("labels net cash and flags a truncated ledger only when the server says so", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText("Net cash in/out")).toBeTruthy();
    expect(screen.queryByText(/Totals partial/)).toBeNull();
    cleanup();
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals, ledgerTruncated: true } };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText(/Totals partial/)).toBeTruthy();
  });

  it("switches range and subscribes with the new days", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    render(<HistoryPane account="capital:demo" />);
    expect(subscribe).toHaveBeenLastCalledWith("capital:demo", 30, expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: "90d" }));
    expect(subscribe).toHaveBeenLastCalledWith("capital:demo", 90, expect.any(Function));
  });

  it("shows the error with a Retry that refetches", () => {
    state = { loading: false, error: "history failed: boom", data: null };
    render(<HistoryPane account="capital:demo" />);
    expect(screen.getByText(/boom/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledWith("capital:demo");
  });

  it("shows an info tip on the Overnight fees label by default, and hides it when tips=false", () => {
    state = { loading: false, error: null, data: { trades: [], ledger: [], totals } };
    const { rerender } = render(<HistoryPane account="capital:demo" />);
    expect(screen.getByRole("button", { name: "About Overnight fees" })).toBeTruthy();
    rerender(<HistoryPane account="capital:demo" tips={false} />);
    expect(screen.queryByRole("button", { name: "About Overnight fees" })).toBeNull();
  });

  it("lists ledger rows under the Ledger toggle", () => {
    state = {
      loading: false, error: null,
      data: { trades: [], totals, ledger: [{ at: 1, kind: "SWAP", epic: null, note: "swap r",
        amount: -0.42, currency: "EUR", reference: "r", dealId: null }] },
    };
    render(<HistoryPane account="capital:demo" />);
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(screen.getByText("Overnight fees")).toBeTruthy(); // totals label
    expect(screen.getByText("Overnight fee")).toBeTruthy(); // the row's type
  });
});
