// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import BacktestClusterPopover from "./BacktestClusterPopover";
import { backtestClusterHoverSignal } from "./lib/signals";
import type { StoredBacktestResult } from "./lib/persist";

type Trade = StoredBacktestResult["trades"][number];

function trade(over: Partial<Trade>): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: 1000,
    entry_price: 100,
    exit_time: 2000,
    exit_price: 101,
    pnl: 1,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
    mae: 0,
    mfe: 0,
    mae_r: null,
    mfe_r: null,
    context: null,
    ...over,
  } as Trade;
}

beforeEach(() => {
  backtestClusterHoverSignal.set(null);
});
afterEach(cleanup);

describe("BacktestClusterPopover", () => {
  it("renders nothing without a hover", () => {
    const { container } = render(<BacktestClusterPopover />);
    expect(container.firstChild).toBeNull();
  });

  it("shows each trade's run-sequence number from its index", () => {
    backtestClusterHoverSignal.set({
      trades: [
        { trade: trade({ pnl: -54.8 }), index: 11 },
        { trade: trade({ entry_time: 1500, pnl: -42.21 }), index: 12 },
      ],
      x: 10,
      y: 10,
    });
    render(<BacktestClusterPopover />);
    expect(screen.getByText("#12")).toBeTruthy();
    expect(screen.getByText("#13")).toBeTruthy();
    expect(screen.getAllByText("Long")).toHaveLength(2);
  });
});
