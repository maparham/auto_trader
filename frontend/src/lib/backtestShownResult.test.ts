// @vitest-environment jsdom
//
// The two seams the chart-replay reveal added to lib/backtest:
//
//  - `updateShownResult`, the per-step path. The reveal advances its slice on
//    every bar, and a full teardown + render there rebuilds every marker overlay
//    ten times a second at 10x AND nulls the user's trade selection. This swaps
//    the shown result in place instead, so the only thing that moves is the
//    equity series and the panel's running numbers.
//  - `backtestPanelActionForReplay`, the rule two callers outside this file obey
//    before publishing a saved backtest onto the SHARED panel. Both of them
//    could otherwise put the whole run in front of a user who is deliberately
//    trading blind.
//
// The chart harness is `backtestEquityPane.test.ts`': a real klinecharts
// instance over jsdom canvas stubs, because `artifactsByChart` is module-private
// and only a real render populates it.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { init, dispose, type Chart } from "klinecharts";
import {
  EQUITY_INDICATOR,
  backtestActionBlockedByReplay,
  backtestPanelActionForReplay,
  isChartReplaying,
  ownsBacktestPanel,
  registerBacktestIndicators,
  registerReplayingChart,
  renderArtifacts,
  renderWfoArtifacts,
  teardownArtifacts,
  updateShownResult,
} from "./backtest";
import { backtestEquityShownSignal, backtestResultSignal, selectedTradeSignal } from "./signals";
import type { StoredBacktestResult } from "./persist/artifacts";

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

const T = 1_700_000_000;

/** A slice with `n` equity points — what the reveal publishes as the cursor
 * advances over bars that contain no fill. */
const slice = (n: number): StoredBacktestResult =>
  ({
    epic: "TEST",
    resolution: "MINUTE",
    markers: [],
    trades: [],
    equity: Array.from({ length: n }, (_, i) => ({ time: T + i * 60, value: 1000 + i })),
    summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: {
      return_pct: 0, profit_factor: null, expectancy: 0, avg_win: 0, avg_loss: 0,
      avg_win_loss_ratio: null, largest_win: 0, largest_loss: 0, max_drawdown_pct: 0,
      avg_duration_bars: 0, max_consec_wins: 0, max_consec_losses: 0,
    },
  }) as StoredBacktestResult;

describe("updateShownResult", () => {
  let chart: Chart;
  let el: HTMLDivElement;

  beforeEach(() => {
    backtestEquityShownSignal.set(true);
    backtestResultSignal.set(null);
    selectedTradeSignal.set(null);
    el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 800 });
    Object.defineProperty(el, "clientHeight", { value: 600 });
    document.body.appendChild(el);
    chart = init(el)!;
  });
  afterEach(() => {
    teardownArtifacts(chart);
    dispose(el);
    el.remove();
  });

  it("swaps the published result without touching the equity PANE", () => {
    const first = slice(2);
    renderArtifacts(chart, first, { markerMode: "none", canEquity: true });
    backtestResultSignal.set(first);
    expect(chart.getIndicators({ name: EQUITY_INDICATOR })).toHaveLength(1);

    const grown = slice(5);
    expect(updateShownResult(chart, grown)).toBe(true);
    expect(backtestResultSignal.value).toBe(grown);
    // Still exactly one pane: the curve was overridden, not re-created. A
    // re-created one stacks (the bug backtestEquityPane.test.ts guards).
    expect(chart.getIndicators({ name: EQUITY_INDICATOR })).toHaveLength(1);
  });

  it("keeps this chart the panel's owner after the swap", () => {
    const first = slice(2);
    renderArtifacts(chart, first, { markerMode: "none", canEquity: true });
    backtestResultSignal.set(first);
    expect(ownsBacktestPanel(chart)).toBe(true);

    updateShownResult(chart, slice(3));
    // The identity invariant the whole module's hover/selection gating rests on:
    // `backtestResultSignal.value === artifacts.result`. Swapping only the signal
    // would leave every subscription inert.
    expect(ownsBacktestPanel(chart)).toBe(true);
  });

  it("leaves the user's trade selection alone", () => {
    const first = slice(2);
    renderArtifacts(chart, first, { markerMode: "none", canEquity: true });
    backtestResultSignal.set(first);
    selectedTradeSignal.set(0);

    updateShownResult(chart, slice(3));
    // This is the whole point of the seam: teardownArtifacts nulls this signal,
    // so doing a full redraw per step would drop a studied trade within 100ms.
    expect(selectedTradeSignal.value).toBe(0);
  });

  it("refuses to publish from a chart that does not back the panel", () => {
    const first = slice(2);
    renderArtifacts(chart, first, { markerMode: "none", canEquity: true });
    // Another cell owns the panel.
    const other = slice(9);
    backtestResultSignal.set(other);

    expect(updateShownResult(chart, slice(3))).toBe(false);
    expect(backtestResultSignal.value).toBe(other);
  });

  it("does nothing on a chart that has never rendered", () => {
    expect(updateShownResult(chart, slice(3))).toBe(false);
    expect(backtestResultSignal.value).toBeNull();
  });
});

describe("backtestPanelActionForReplay", () => {
  // The rule both publishing callers obey: chart/useLiveMarketData's series load,
  // and App's cross-tab/cross-device push handler.
  it("republishes the saved backtest when the cell is NOT replaying", () => {
    expect(backtestPanelActionForReplay({ replaying: false, stalePanelOwner: false })).toBe("rehydrate");
    // Ownership is irrelevant off-session: rehydrateBacktest handles it itself.
    expect(backtestPanelActionForReplay({ replaying: false, stalePanelOwner: true })).toBe("rehydrate");
  });

  it("never republishes while the cell is replaying", () => {
    // The leak this exists for: the whole run onto the shared panel mid-session
    // (every future trade with its P&L, the final net P&L, and `period` as a real
    // calendar range through a masked session).
    expect(backtestPanelActionForReplay({ replaying: true, stalePanelOwner: false })).not.toBe("rehydrate");
    expect(backtestPanelActionForReplay({ replaying: true, stalePanelOwner: true })).not.toBe("rehydrate");
  });

  it("clears a panel this chart owned with a result it is no longer drawing", () => {
    // The series-load path: it tore its artifacts down before the bars landed, so
    // what the signal still holds is the PRE-session run. Leaving it would keep
    // the full result visible behind the session.
    expect(backtestPanelActionForReplay({ replaying: true, stalePanelOwner: true })).toBe("clear");
  });

  it("leaves the panel alone for a caller that tore nothing down", () => {
    // The push path: anything this chart owns there is the reveal's own live
    // slice, and clearing it would blank a session mid-flight.
    expect(backtestPanelActionForReplay({ replaying: true, stalePanelOwner: false })).toBe("leave");
  });
});

// The walk-forward scheme picker in the results panel re-renders a chosen
// scheme's fold bands + stitched OOS equity on the chart, through
// renderWfoArtifacts. That call sits six lines above the run request the replay
// guard covers and had no gate of its own, so picking a scheme mid-session tore
// down the progressive reveal and painted real-calendar fold bands beside a
// panel printing their dates. Gated inside renderWfoArtifacts rather than at the
// subscription, because the post-run render is a second caller of the same
// function.
describe("renderWfoArtifacts on a replaying chart", () => {
  let chart: Chart;
  let el: HTMLDivElement;
  // Real enough for the non-replaying control to render for real (the gate must
  // bail before its own teardownArtifacts, so the replaying case never reads it).
  const scheme = {
    train_span: "1Y",
    folds: [],
    stitched: {
      equity: [[T, 10_000], [T + 60, 10_100]],
      equity_scaled: [[T, 10_000], [T + 60, 10_200]],
      trades: [],
      metrics: {},
    },
  } as unknown as Parameters<typeof renderWfoArtifacts>[1];

  beforeEach(() => {
    backtestEquityShownSignal.set(true);
    backtestResultSignal.set(null);
    el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 800 });
    Object.defineProperty(el, "clientHeight", { value: 600 });
    document.body.appendChild(el);
    chart = init(el)!;
  });
  afterEach(() => {
    registerReplayingChart(chart, null);
    teardownArtifacts(chart);
    dispose(el);
    el.remove();
  });

  it("renders nothing and leaves the reveal's artifacts standing", () => {
    const revealed = slice(3);
    renderArtifacts(chart, revealed, { markerMode: "none", canEquity: true });
    backtestResultSignal.set(revealed);
    registerReplayingChart(chart, () => true);

    expect(renderWfoArtifacts(chart, scheme)).toBe(false);
    // teardownArtifacts would have nulled both of these.
    expect(backtestResultSignal.value).toBe(revealed);
    expect(chart.getIndicators({ name: EQUITY_INDICATOR })).toHaveLength(1);
  });

  it("renders normally when the chart is not replaying", () => {
    registerReplayingChart(chart, () => false);
    expect(renderWfoArtifacts(chart, scheme)).toBe(true);
  });
});

describe("backtestActionBlockedByReplay", () => {
  // The gate both of the panel's START controls obey: BacktestButton's run()
  // (backtest, sweep and walk-forward all enter through it, as does the agent
  // bridge) and BacktestSettingsModal's two Pick Range buttons.
  it("blocks nothing while the cell is live", () => {
    expect(backtestActionBlockedByReplay({ replaying: false, action: "run" })).toBeNull();
    expect(backtestActionBlockedByReplay({ replaying: false, action: "pick-range" })).toBeNull();
  });

  it("blocks a run while the cell is replaying, and says why", () => {
    const reason = backtestActionBlockedByReplay({ replaying: true, action: "run" });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/replay/i);
  });

  it("blocks a range pick while the cell is replaying, and says why", () => {
    const reason = backtestActionBlockedByReplay({ replaying: true, action: "pick-range" });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/replay/i);
  });

  it("gives the two actions their own reasons (each control explains ITSELF)", () => {
    expect(backtestActionBlockedByReplay({ replaying: true, action: "run" })).not.toBe(
      backtestActionBlockedByReplay({ replaying: true, action: "pick-range" }),
    );
  });

  it("keeps no em dash in copy that reaches the user", () => {
    for (const action of ["run", "pick-range"] as const)
      expect(backtestActionBlockedByReplay({ replaying: true, action })).not.toContain("—");
  });
});

describe("the chart-keyed replaying registry", () => {
  // App's push handler holds only `{ chart, controller }` for a cell it does not
  // own, so it cannot ask the ChartHandle's replayRef.
  let chart: Chart;
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 800 });
    Object.defineProperty(el, "clientHeight", { value: 600 });
    document.body.appendChild(el);
    chart = init(el)!;
  });
  afterEach(() => {
    registerReplayingChart(chart, null);
    dispose(el);
    el.remove();
  });

  it("reads false for a chart that never registered", () => {
    expect(isChartReplaying(chart)).toBe(false);
  });

  it("follows the registered reader, which is live rather than a snapshot", () => {
    let active = false;
    registerReplayingChart(chart, () => active);
    expect(isChartReplaying(chart)).toBe(false);
    active = true;
    expect(isChartReplaying(chart)).toBe(true);
  });

  it("reads false again once unregistered", () => {
    registerReplayingChart(chart, () => true);
    expect(isChartReplaying(chart)).toBe(true);
    registerReplayingChart(chart, null);
    expect(isChartReplaying(chart)).toBe(false);
  });
});
