// @vitest-environment jsdom
// Overview tab's Baselines section: the per-side null-signal and buy & hold
// reference runs plus the reversed run, and each one's Δ against the strategy.
// The two deltas read different sources: net comes from result.summary
// (result.metrics has no net_pnl) and return comes from result.metrics
// (result.summary has no return_pct).
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

// jsdom's localStorage isn't wired up in this project's vitest config (see
// BacktestSettingsModal.test.tsx); persist must load against a stand-in.
installMemStorage();

import type { BacktestResult, Baselines } from "./api";
import { backtestResultSignal } from "./lib/signals";
import BacktestPanel from "./BacktestPanel";

beforeAll(() => {
  // jsdom implements no ResizeObserver (the trades table measures its viewport).
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// vitest isn't run with jest-style globals, so RTL's automatic cleanup never
// registers (see BacktestSettingsModal.test.tsx). backtestResultSignal is a
// module singleton and must be reset or one test's result leaks into the next.
afterEach(() => {
  cleanup();
  backtestResultSignal.set(null);
});

const BASE: BacktestResult = {
  epic: "TEST",
  resolution: "MINUTE",
  candles: [],
  markers: [],
  trades: [],
  equity: [],
  // The strategy's own net P&L lives here, not on metrics — the Δ column reads it.
  summary: { net_pnl: 12500, n_trades: 4, win_rate: 0.5, max_drawdown: 100 },
  metrics: {
    return_pct: 416.67,
    profit_factor: 1.8,
    expectancy: 3125,
    avg_win: 5000,
    avg_loss: 1500,
    avg_win_loss_ratio: 3.33,
    largest_win: 7000,
    largest_loss: 2000,
    max_drawdown_pct: 12.5,
    avg_duration_bars: 30,
    max_consec_wins: 2,
    max_consec_losses: 1,
    sharpe: 1.4,
  },
};

function resultWith(over: Partial<BacktestResult>): BacktestResult {
  return { ...BASE, ...over };
}

function renderPanel(result: BacktestResult, props: { codedRun?: boolean } = {}) {
  act(() => backtestResultSignal.set(result));
  render(<BacktestPanel {...props} />);
}

// max_drawdown_pct is a positive magnitude on the wire (backend
// tests/test_metrics.py asserts 5.0 for a 5% drop), same as result.metrics.
const BASELINES: Baselines = {
  null_long: { net_pnl: 11966.73, return_pct: 398.89, sharpe: 1.06, max_drawdown_pct: 60.97 },
  null_short: null,
  hold_long: { net_pnl: 9000, return_pct: 300, sharpe: 0.9, max_drawdown_pct: 55 },
  hold_short: { net_pnl: -8100, return_pct: -270, sharpe: -0.8, max_drawdown_pct: 70 },
  reversed: { net_pnl: -4200, return_pct: -140, sharpe: -0.7, max_drawdown_pct: 80 },
};

describe("BacktestPanel Baselines section", () => {
  it("renders the Baselines section when the result carries baselines", () => {
    renderPanel(resultWith({ baselines: BASELINES }));
    expect(screen.getByText("Baselines", { selector: "h4" })).toBeTruthy();
    // One row per side that ran; the never-run null_short row is absent.
    expect(screen.getByText("Null signal (long)")).toBeTruthy();
    expect(screen.queryByText("Null signal (short)")).toBeNull();
    expect(screen.getByText("Enter & hold (long)")).toBeTruthy();
    expect(screen.getByText("Enter & hold (short)")).toBeTruthy();
    expect(screen.getByText("Reversed signals")).toBeTruthy();
    expect(screen.getByText("398.89%")).toBeTruthy();
    expect(screen.getByText("60.97%")).toBeTruthy();
    expect(screen.getByText("-270.00%")).toBeTruthy();
    expect(screen.getByText("-140.00%")).toBeTruthy();
  });

  it("renders the section when only the reversed companion run succeeded", () => {
    renderPanel(resultWith({ baselines: { reversed: BASELINES.reversed } }));
    expect(screen.getByText("Baselines", { selector: "h4" })).toBeTruthy();
    expect(screen.getByText("Reversed signals")).toBeTruthy();
    expect(screen.queryByText(/Null signal/)).toBeNull();
  });

  it("hides the Baselines section when absent", () => {
    renderPanel(resultWith({ baselines: null }));
    expect(screen.queryByText("Baselines", { selector: "h4" })).toBeNull();
  });

  it("hides the Baselines section when both companion runs failed", () => {
    // The real wire shape when neither baseline could be synthesized.
    renderPanel(resultWith({ baselines: {
      null_long: null, null_short: null, hold_long: null, hold_short: null, reversed: null,
    } }));
    expect(screen.queryByText("Baselines", { selector: "h4" })).toBeNull();
  });

  it("marks the row labels as row headers, like the leg breakdown table", () => {
    renderPanel(resultWith({ baselines: BASELINES }));
    // The label sits beside its ⓘ trigger inside the header cell.
    const th = screen.getByText("Null signal (long)").closest("th");
    expect(th).toBeTruthy();
    expect(th!.getAttribute("scope")).toBe("row");
    // The corner cell carries no label and must not be announced.
    const corner = document.querySelector(".bt-baselines thead th.bt-baselines-rowhead");
    expect(corner?.getAttribute("aria-hidden")).toBe("true");
  });

  // Each row carries its own InfoTip ⓘ (aria-label "About <row name>"); the
  // bubble opens on a 100ms delay, so await it — a sync query passes vacuously.
  it("shows a per-row tooltip on the baseline's info icon", async () => {
    renderPanel(resultWith({ baselines: BASELINES }));
    fireEvent.mouseEnter(screen.getByLabelText("About Reversed signals"));
    expect(await screen.findByText(/long instead of short and vice versa/i)).toBeTruthy();
  });

  it("deltas each baseline against the strategy's summary net P&L", () => {
    renderPanel(resultWith({ baselines: BASELINES }));
    // 12500 − 11966.73 and 12500 − 9000, in the panel's +/− numeric idiom.
    expect(screen.getByText("+533.27")).toBeTruthy();
    expect(screen.getByText("+3500.00")).toBeTruthy();
    // And the return delta, off result.metrics.return_pct (416.67): minus
    // 398.89 for the long null signal, minus 300 for the long buy & hold.
    expect(screen.getByText("+17.78%")).toBeTruthy();
    expect(screen.getByText("+116.67%")).toBeTruthy();
  });

  it("renders the hindsight-corrected entries row", () => {
    renderPanel(resultWith({ baselines: {
      ...BASELINES,
      oracle_entries: { net_pnl: 20000, return_pct: 666.67, sharpe: 3.2, max_drawdown_pct: 5.0 },
    } }));
    expect(screen.getByText("Losses flipped to wins")).toBeTruthy();
    expect(screen.getByText("666.67%")).toBeTruthy();
  });

  it("shows a placeholder delta when a baseline carries no net P&L", () => {
    renderPanel(resultWith({ baselines: { null_long: { return_pct: 10, net_pnl: null } } }));
    expect(screen.getByText("Null signal (long)")).toBeTruthy();
    expect(screen.queryByText(/Enter & hold/)).toBeNull();
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  // The InfoTip trigger is InfoTip's own button (aria-label "About Baselines")
  // and the bubble opens on a 100ms hover delay, so every assertion below has to
  // await the bubble — a synchronous query would pass vacuously.
  it("adds the Built-in caveat line to the Baselines tip for coded runs", async () => {
    renderPanel(resultWith({ baselines: BASELINES }), { codedRun: true });
    fireEvent.mouseEnter(screen.getByLabelText(/about baselines/i));
    expect(await screen.findByText(/logic inside the strategy file is not mirrored/i)).toBeTruthy();
  });

  it("omits the Built-in caveat for expression runs", async () => {
    renderPanel(resultWith({ baselines: BASELINES }));
    fireEvent.mouseEnter(screen.getByLabelText(/about baselines/i));
    // Await a line the tip always carries, so the absence assertion below is
    // made against an OPEN bubble rather than one that has not opened yet.
    expect(await screen.findByText(/Reference runs over the same window/i)).toBeTruthy();
    expect(screen.queryByText(/logic inside the strategy file/i)).toBeNull();
  });
});

describe("Display menu: strategy regions toggle", () => {
  it("flips the regions signal and persists the preference", async () => {
    const { backtestRegionsShownSignal } = await import("./lib/signals");
    const { loadBacktestRegionsShown } = await import("./lib/persist");
    backtestRegionsShownSignal.set(true);
    renderPanel(resultWith({}));

    fireEvent.click(screen.getByRole("button", { name: /Display/ }));
    const item = screen.getByRole("menuitemcheckbox", { name: /Strategy regions/ });
    expect(item.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(item);
    expect(backtestRegionsShownSignal.value).toBe(false);
    expect(loadBacktestRegionsShown()).toBe(false);

    fireEvent.click(item);
    expect(backtestRegionsShownSignal.value).toBe(true);
    expect(loadBacktestRegionsShown()).toBe(true);
  });
});
