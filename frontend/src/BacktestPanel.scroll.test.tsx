// @vitest-environment jsdom
// Regression: hovering a chart trade marker sets highlightTradeSignal, which
// must only highlight the matching trades-table row — scrolling the table into
// place is reserved for the sticky click-selection (selectedTradeSignal).
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

// jsdom's localStorage isn't wired up in this project's vitest config (see
// BacktestSettingsModal.test.tsx); persist must load against a stand-in.
installMemStorage();

import type { BacktestResult } from "./api";
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
} from "./lib/signals";
import BacktestPanel from "./BacktestPanel";

beforeAll(() => {
  // jsdom implements neither ResizeObserver (viewport measuring) nor
  // scrollIntoView (the behavior under test) — stub both.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

// vitest isn't run with jest-style globals, so RTL's automatic cleanup never
// registers (see BacktestSettingsModal.test.tsx). Signals are module singletons
// and must be reset or one test's selection leaks into the next.
afterEach(() => {
  cleanup();
  localStorage.clear();
  backtestResultSignal.set(null);
  highlightTradeSignal.set(null);
  selectedTradeSignal.set(null);
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
});

function makeTrade(i: number): BacktestResult["trades"][number] {
  const t0 = 1_700_000_000 + i * 3600;
  return {
    side: "BUY",
    quantity: 1,
    entry_time: t0,
    entry_price: 100,
    exit_time: t0 + 1800,
    exit_price: 101,
    pnl: 1,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
    mae: 0,
    mfe: 1,
    mae_r: null,
    mfe_r: null,
    context: null,
  };
}

const result: BacktestResult = {
  epic: "TEST",
  resolution: "MINUTE",
  candles: [],
  markers: [],
  trades: [makeTrade(0), makeTrade(1), makeTrade(2)],
  equity: [],
  summary: { net_pnl: 3, n_trades: 3, win_rate: 1, max_drawdown: 0 },
  metrics: {
    return_pct: 1,
    profit_factor: null,
    expectancy: 1,
    avg_win: 1,
    avg_loss: 0,
    avg_win_loss_ratio: null,
    largest_win: 1,
    largest_loss: 0,
    max_drawdown_pct: 0,
    avg_duration_bars: 30,
    max_consec_wins: 3,
    max_consec_losses: 0,
  },
};

function renderTradesTab() {
  act(() => backtestResultSignal.set(result));
  render(<BacktestPanel />);
  fireEvent.click(screen.getByRole("tab", { name: "Trades" }));
}

describe("BacktestPanel trades-table scroll", () => {
  it("does not scroll when a trade is merely highlighted (marker hover)", () => {
    renderTradesTab();
    act(() => highlightTradeSignal.set(1));
    expect(document.querySelector("tr.bt-trade-row.highlighted")).not.toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the selected row into view on selection (marker click)", () => {
    renderTradesTab();
    act(() => selectedTradeSignal.set(1));
    expect(document.querySelector("tr.bt-trade-row.selected")).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
