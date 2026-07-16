// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { init, dispose, type Chart } from "klinecharts";
import {
  EQUITY_INDICATOR,
  registerBacktestIndicators,
  renderArtifacts,
  teardownArtifacts,
} from "./backtest";
import { backtestEquityShownSignal, backtestResultSignal } from "./signals";
import type { StoredBacktestResult } from "./persist/artifacts";

// Minimal 2d-context + ResizeObserver stubs so klinecharts can init in jsdom.
beforeAll(() => {
  const ctx = new Proxy(
    { measureText: () => ({ width: 0 }), canvas: { width: 0, height: 0 } },
    {
      get: (target, prop) =>
        prop in target
          ? (target as Record<string, unknown>)[prop as string]
          : typeof prop === "string"
            ? () => {}
            : undefined,
    },
  );
  // @ts-expect-error jsdom canvas stub
  HTMLCanvasElement.prototype.getContext = () => ctx;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  registerBacktestIndicators();
});

const makeResult = (): StoredBacktestResult => ({
  epic: "TEST",
  resolution: "5m",
  markers: [],
  trades: [],
  equity: [
    { time: 1_700_000_000, value: 1000 },
    { time: 1_700_000_300, value: 1010 },
  ],
  summary: { net_pnl: 10, n_trades: 0, win_rate: 0, max_drawdown: 0 },
  metrics: {
    return_pct: 1,
    profit_factor: null,
    expectancy: 0,
    avg_win: 0,
    avg_loss: 0,
    avg_win_loss_ratio: null,
    largest_win: 0,
    largest_loss: 0,
    max_drawdown_pct: 0,
    avg_duration_bars: 0,
    max_consec_wins: 0,
    max_consec_losses: 0,
  },
});

const equityPaneCount = (chart: Chart) =>
  chart.getIndicators({ name: EQUITY_INDICATOR }).length;

describe("backtest equity pane lifecycle", () => {
  let chart: Chart;
  let el: HTMLDivElement;

  beforeEach(() => {
    backtestEquityShownSignal.set(true);
    backtestResultSignal.set(null);
    el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 800 });
    Object.defineProperty(el, "clientHeight", { value: 600 });
    document.body.appendChild(el);
    chart = init(el)!;
  });

  it("does not stack equity panes across repeated runs (each run tears down the prior)", () => {
    // Simulate three back-to-back runs the way runAndRender does: teardown the
    // prior artifacts, then render the fresh result.
    for (let run = 0; run < 3; run++) {
      teardownArtifacts(chart);
      const result = makeResult();
      renderArtifacts(chart, result, { markerMode: "none", canEquity: true });
      backtestResultSignal.set(result);
      expect(equityPaneCount(chart)).toBe(1); // exactly one, never stacking
    }
    // A final teardown removes it entirely.
    teardownArtifacts(chart);
    expect(equityPaneCount(chart)).toBe(0);
    dispose(el);
  });

  it("toggling the equity switch off removes the pane, on re-adds a single one", () => {
    const result = makeResult();
    renderArtifacts(chart, result, { markerMode: "none", canEquity: true });
    backtestResultSignal.set(result);
    expect(equityPaneCount(chart)).toBe(1);

    backtestEquityShownSignal.set(false);
    expect(equityPaneCount(chart)).toBe(0);

    backtestEquityShownSignal.set(true);
    expect(equityPaneCount(chart)).toBe(1);

    teardownArtifacts(chart);
    dispose(el);
  });
});
