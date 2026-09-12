// @vitest-environment jsdom
// Demo mode's BacktestPanel branch: a picker over the published canned
// backtests (by name) feeding the SAME result-rendering path a live run uses,
// a "Sign up to run your own" CTA in place of any run affordance, and the
// empty-list message when nothing has been published yet.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

beforeAll(() => {
  // jsdom implements no ResizeObserver (the trades table measures its viewport).
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(async () => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("./lib/demoMode");
  vi.doUnmock("./lib/demoSnapshot");
  const { backtestResultSignal } = await import("./lib/signals");
  backtestResultSignal.set(null);
});

const RESULT_A = {
  epic: "US100",
  resolution: "MINUTE",
  candles: [],
  markers: [],
  trades: [],
  equity: [],
  summary: { net_pnl: 4200, n_trades: 3, win_rate: 0.6, max_drawdown: 50 },
  metrics: {
    return_pct: 42, profit_factor: 1.5, expectancy: 1400, avg_win: 2000, avg_loss: 800,
    avg_win_loss_ratio: 2.5, largest_win: 3000, largest_loss: 1000, max_drawdown_pct: 5,
    avg_duration_bars: 10, max_consec_wins: 2, max_consec_losses: 1, sharpe: 1.1,
  },
};

const RESULT_B = {
  ...RESULT_A,
  epic: "EURUSD",
  summary: { ...RESULT_A.summary, net_pnl: 9900 },
};

async function mockDemo(backtests: { name: string; result: unknown }[]) {
  vi.doMock("./lib/demoMode", () => ({ isDemoMode: () => true, setDemoMode: () => {} }));
  vi.doMock("./lib/demoSnapshot", () => ({
    getDemoSnapshot: () => ({ version: 1, layout: {}, watchlist: ["US100"], backtests }),
  }));
  const { default: BacktestPanel } = await import("./BacktestPanel");
  return BacktestPanel;
}

describe("BacktestPanel demo mode", () => {
  it("lists both published names, auto-selects the first, and offers the sign-up CTA", async () => {
    const BacktestPanel = await mockDemo([
      { name: "NQ breakout", result: RESULT_A },
      { name: "EUR mean reversion", result: RESULT_B },
    ]);
    render(<BacktestPanel />);

    expect(screen.getByRole("tab", { name: "NQ breakout" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "EUR mean reversion" })).toBeTruthy();

    const cta = screen.getByText("Sign up to run your own");
    expect(cta.getAttribute("href")).toBe("/?sign_in=1");

    // No run control of any kind.
    expect(screen.queryByRole("button", { name: /run backtest/i })).toBeNull();

    // Auto-selected the first entry: its net P&L renders through the real path
    // (split across two text nodes: the sign and the number).
    expect(document.querySelector(".bt-summary .pos")?.textContent).toBe("+4200.00");
  });

  it("switches the rendered result when a different name is picked", async () => {
    const BacktestPanel = await mockDemo([
      { name: "NQ breakout", result: RESULT_A },
      { name: "EUR mean reversion", result: RESULT_B },
    ]);
    render(<BacktestPanel />);
    expect(document.querySelector(".bt-summary .pos")?.textContent).toBe("+4200.00");

    fireEvent.click(screen.getByRole("tab", { name: "EUR mean reversion" }));
    expect(document.querySelector(".bt-summary .pos")?.textContent).toBe("+9900.00");
  });

  it("selects by index, so two backtests sharing a name stay independently selectable", async () => {
    const BacktestPanel = await mockDemo([
      { name: "NQ breakout", result: RESULT_A },
      { name: "NQ breakout", result: RESULT_B },
    ]);
    render(<BacktestPanel />);
    const tabs = screen.getAllByRole("tab", { name: "NQ breakout" });
    expect(tabs).toHaveLength(2);

    // Auto-selected the FIRST entry (index 0), not "whichever matched the name".
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector(".bt-summary .pos")?.textContent).toBe("+4200.00");

    fireEvent.click(tabs[1]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".bt-summary .pos")?.textContent).toBe("+9900.00");
  });

  it("shows the empty-list message and CTA when nothing is published", async () => {
    const BacktestPanel = await mockDemo([]);
    render(<BacktestPanel />);

    expect(screen.getByText("No demo backtests published")).toBeTruthy();
    expect(screen.getByText("Sign up to run your own")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
