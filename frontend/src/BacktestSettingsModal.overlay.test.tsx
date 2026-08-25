// @vitest-environment jsdom
//
// Overlay / auto-hide layout mode for the backtest panel: pin toggle, hidden
// state, chart-click hide, peek-tab reveal, and the promise that an unpinned
// panel never moves the chart.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const mockStrategies = vi.fn().mockResolvedValue([]);
const mockComputeStatus = vi.fn().mockResolvedValue({ remoteConfigured: false });
const mockComputeHostState = vi.fn().mockResolvedValue({ state: "unconfigured", detail: null });
const brokerProfile = {
  epic: "TEST",
  spread: 0.8,
  slippage: { kind: "fixed" as const, value: 0.2, atrMult: 0 },
  finLongDailyPct: -0.01,
  finShortDailyPct: 0.01,
  source: "broker" as const,
  updatedAt: 123,
};
const mockGetCostProfile = vi.fn().mockResolvedValue(brokerProfile);
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchStrategies: (...args: unknown[]) => mockStrategies(...args),
    computeStatus: (...args: unknown[]) => mockComputeStatus(...args),
    computeHostState: (...args: unknown[]) => mockComputeHostState(...args),
    getCostProfile: (...args: unknown[]) => mockGetCostProfile(...args),
  };
});

import BacktestSettingsModal, { resetCostProfileCache } from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import {
  saveBacktestPanelPinned,
  loadBacktestPanelPinned,
  saveBacktestResultsSideBySide,
} from "./lib/persist";
import { backtestPanelHiddenSignal, backtestRunningSignal, sweepStateSignal } from "./lib/signals";
import { ChartController } from "./lib/chartController";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  resetCostProfileCache();
});

// A stand-in for the chart area the panel overlays: App's `main.chart` with
// its `.chart-cells` grid inside. Neither is rendered by the panel component
// itself, but it depends on both — the hide listener keys on .chart-cells, and
// the unpinned overlay portals into main.chart — so the tests provide them.
// Returns the cells (the hide-listener target); `chartMain()` reaches the host.
function withChartCells(): HTMLElement {
  const main = document.createElement("main");
  main.className = "chart";
  const cells = document.createElement("div");
  cells.className = "chart-cells";
  main.appendChild(cells);
  document.body.appendChild(main);
  return cells;
}
const chartMain = () => document.querySelector("main.chart")!;
const removeChartArea = () =>
  document.querySelectorAll("main.chart, .chart-cells").forEach((n) => n.remove());

function renderPanel(controller: import("./lib/chartController").ChartController | null = null) {
  return render(
    <BacktestSettingsModal
      initial={defaultBacktestConfig()}
      epic="TEST"
      brokerId="capital"
      resolution="MINUTE"
      controller={controller}
      chartTimezone="UTC"
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("backtest panel layout mode", () => {
  it("defaults to the overlay (unpinned) wrapper, with the config panel inside it", () => {
    renderPanel();
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-dock")).toBeNull();
    // Tasks 3-5 build on this containment contract, not just the wrapper's
    // presence — the asides must actually be nested inside the wrapper div.
    expect(document.querySelector(".bt-overlay .bt-cfg-panel")).toBeTruthy();
    expect(screen.getByRole("button", { name: /pin panel/i })).toBeTruthy();
  });

  it("nests the side-by-side results column inside the overlay wrapper too", () => {
    saveBacktestResultsSideBySide(true);
    renderPanel();
    expect(document.querySelector(".bt-overlay .bt-results-col")).toBeTruthy();
    expect(document.querySelector(".bt-overlay .bt-cfg-panel")).toBeTruthy();
  });

  it("respects a persisted pinned choice and toggles + persists via the pin button", () => {
    saveBacktestPanelPinned(true);
    renderPanel();
    expect(document.querySelector(".bt-dock")).toBeTruthy();
    expect(document.querySelector(".bt-overlay")).toBeNull();
    expect(document.querySelector(".bt-dock .bt-cfg-panel")).toBeTruthy();
    // Unpin → overlay mode, persisted.
    fireEvent.click(screen.getByRole("button", { name: /unpin panel/i }));
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-overlay .bt-cfg-panel")).toBeTruthy();
    expect(loadBacktestPanelPinned()).toBe(false);
  });

  // Anchoring: the overlay is absolutely positioned, so WHERE it lives decides
  // what it covers. Inside main.chart it covers the chart and nothing else;
  // parented to .workspace (the old home) it also covered the alerts/trade
  // sidebars and the live-trading panel.
  describe("anchoring", () => {
    afterEach(removeChartArea);

    it("unpinned: portals into main.chart, as a sibling of .chart-cells", () => {
      withChartCells();
      const { container } = renderPanel();
      const overlay = document.querySelector(".bt-overlay")!;
      expect(chartMain().contains(overlay)).toBe(true);
      // Must NOT land inside .chart-cells: the hide-on-mousedown listener
      // keys on closest(".chart-cells"), so a click in the panel would
      // dismiss the panel.
      expect(document.querySelector(".chart-cells")!.contains(overlay)).toBe(false);
      expect(container.contains(overlay)).toBe(false);
    });

    it("unpinned: the peek tab is portaled with it", () => {
      const cells = withChartCells();
      renderPanel();
      fireEvent.mouseDown(cells);
      const peek = document.querySelector(".bt-peek")!;
      expect(chartMain().contains(peek)).toBe(true);
      expect(document.querySelector(".chart-cells")!.contains(peek)).toBe(false);
      backtestPanelHiddenSignal.set(false);
    });

    it("pinned: stays at its own render site, unportaled, with display:contents", () => {
      saveBacktestPanelPinned(true);
      withChartCells();
      const { container } = renderPanel();
      const dock = container.querySelector(".bt-dock");
      // Docked order in .workspace (chart, alerts, trade, backtest, live) is
      // App's to own — the panel must not relocate itself out from under it.
      expect(dock).toBeTruthy();
      expect(chartMain().contains(dock!)).toBe(false);
    });

    it("falls back to rendering in place when there is no chart area", () => {
      const { container } = renderPanel();
      expect(container.querySelector(".bt-overlay")).toBeTruthy();
    });
  });

  it("toggles from unpinned to pinned via the pin button and persists it", () => {
    renderPanel();
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /pin panel/i }));
    expect(document.querySelector(".bt-dock")).toBeTruthy();
    expect(document.querySelector(".bt-overlay")).toBeNull();
    expect(loadBacktestPanelPinned()).toBe(true);
  });
});

describe("overlay auto-hide", () => {
  beforeEach(() => backtestPanelHiddenSignal.set(false));
  afterEach(() => {
    removeChartArea();
  });

  it("hides on chart mousedown, reveals via the peek tab, state preserved", () => {
    const cells = withChartCells();
    renderPanel();
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    // Still mounted — the config body is in the DOM, just slid off.
    expect(document.querySelector(".bt-cfg-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show backtest panel/i }));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("does not hide on mousedown outside the chart (e.g. inside the panel)", () => {
    withChartCells();
    renderPanel();
    fireEvent.mouseDown(document.querySelector(".bt-cfg-panel")!);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("pinned mode ignores chart clicks and renders no peek tab", () => {
    saveBacktestPanelPinned(true);
    const cells = withChartCells();
    renderPanel();
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-hidden")).toBeNull();
    expect(document.querySelector(".bt-peek")).toBeNull();
  });

  it("blurs focus out of the panel when it hides", () => {
    // Otherwise the caret stays in a field that is sliding off-screen and
    // keystrokes keep landing in an invisible input.
    const cells = withChartCells();
    renderPanel();
    const field = document.querySelector<HTMLElement>(".bt-overlay input")!;
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("resets the hidden signal on unmount so a reopen starts revealed", () => {
    withChartCells();
    const { unmount } = renderPanel();
    backtestPanelHiddenSignal.set(true);
    unmount();
    expect(backtestPanelHiddenSignal.value).toBe(false);
  });
});

describe("overlay carve-outs", () => {
  beforeEach(() => {
    backtestPanelHiddenSignal.set(false);
    backtestRunningSignal.set(false);
    sweepStateSignal.set(null);
  });
  afterEach(() => {
    removeChartArea();
    sweepStateSignal.set(null);
  });

  it("arming Pick Range ducks the panel; disarming brings it back", () => {
    const controller = new ChartController("cell-1", "scope-1");
    renderPanel(controller);
    act(() => controller.rangePickArmed.set(true));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    act(() => controller.rangePickArmed.set(false));
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
  });

  it("a run in flight suppresses hide-on-chart-click; completion restores it", () => {
    const cells = withChartCells();
    renderPanel();
    act(() => backtestRunningSignal.set(true));
    fireEvent.mouseDown(cells);
    // Positive presence check alongside the "not hidden" assertion so this
    // can't pass vacuously (e.g. if the overlay failed to render at all).
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
    act(() => backtestRunningSignal.set(false));
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
  });

  it("a sweep in flight also suppresses hide-on-chart-click; completion restores it", () => {
    const cells = withChartCells();
    renderPanel();
    act(() => sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true }));
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeNull();
    act(() => sweepStateSignal.set(null));
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
  });

  it("un-pinning after a chart-click hide does not spuriously re-reveal the panel", () => {
    // Regression guard for the `prevPicking` ref: without it, the duck effect
    // re-running on the `pinned` dep (with pickingRange staying false the
    // whole time) would call backtestPanelHiddenSignal.set(false) on every
    // pinned->unpinned transition, undoing a hide the user asked for via a
    // chart click that had nothing to do with Pick Range.
    const cells = withChartCells();
    renderPanel();
    fireEvent.mouseDown(cells);
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /pin panel/i }));
    expect(document.querySelector(".bt-dock")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /unpin panel/i }));
    expect(document.querySelector(".bt-overlay")).toBeTruthy();
    expect(document.querySelector(".bt-overlay.bt-hidden")).toBeTruthy();
  });
});

// The unpinned panel floats OVER the chart and must leave it alone: opening,
// resizing, hiding, revealing and closing it may not scroll, offset or
// otherwise move the chart by a single bar. Only pinning may change the chart,
// and it does so by shrinking the layout, never by scrolling.
//
// This suite replaces an earlier "offset compensation" one, which slid the
// chart left by the panel's width so the newest candles cleared the overlay.
// That shift is exactly what these tests now forbid.
describe("the panel never moves the chart", () => {
  // Models klinecharts 10's scroll surface: getBarSpace returns the BarSpace
  // record (not a number), scrollByDistance takes a px delta (negative widens
  // the right gap), getOffsetRightDistance clamps at 0. The stub tracks the
  // gap in BARS, so any move at all — at any zoom — is visible here.
  function stubChart(barSpace = 10) {
    let bar = barSpace;
    let gapBars = 6 / barSpace; // 6px of whitespace right of the last bar
    const chart = {
      getBarSpace: vi.fn(() => ({ bar, halfBar: bar / 2, gapBar: bar - 1, halfGapBar: (bar - 1) / 2 })),
      scrollByDistance: vi.fn((distance: number) => { gapBars -= distance / bar; }),
      setOffsetRightDistance: vi.fn((d: number) => { gapBars = d / bar; }),
      getOffsetRightDistance: vi.fn(() => Math.max(0, gapBars * bar)),
      // The panel also reads the chart's indicator panes (to feed the rule
      // editors' instance list); this stub carries none.
      getIndicators: () => [],
      // test-only helpers, not part of the klinecharts surface
      gapBars: () => gapBars,
      gapPx: () => gapBars * bar,
      pan: (distance: number) => { gapBars -= distance / bar; },
      zoom: (to: number) => { bar = to; },
    };
    return chart;
  }

  // jsdom reports clientWidth 0 for every element. A laid-out chart host is
  // the case where a shift WOULD have been computed, so the tests fake a real
  // width — a zero-width host would pass vacuously.
  function withSizedChartCells(clientWidth = 1400): HTMLElement {
    const cells = withChartCells();
    Object.defineProperty(chartMain(), "clientWidth", { value: clientWidth, configurable: true });
    return cells;
  }
  function mount(chart: ReturnType<typeof stubChart>, prepare?: (c: ChartController) => void) {
    const controller = new ChartController("cell-1", "scope-1");
    controller.chart = chart as unknown as import("klinecharts").Chart;
    // `prepare` runs BEFORE the first render, so a test watching
    // programmaticMove sees any mount-time move too, not just later ones.
    prepare?.(controller);
    renderPanel(controller);
    return controller;
  }
  // Every way the panel can touch a chart goes through one of these.
  const assertUntouched = (chart: ReturnType<typeof stubChart>, gapPx = 6) => {
    expect(chart.scrollByDistance).not.toHaveBeenCalled();
    expect(chart.setOffsetRightDistance).not.toHaveBeenCalled();
    expect(chart.gapPx()).toBeCloseTo(gapPx);
  };

  beforeEach(() => {
    backtestPanelHiddenSignal.set(false);
    // jsdom defaults to 1024px, where clampWidth would shrink the 720 default
    // panel width to innerWidth-380. Widen past 720+380 so the panel really is
    // at its full width — the widest shift the old code would have applied.
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true, writable: true });
  });
  afterEach(() => {
    removeChartArea();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  });

  it("leaves the chart alone on reveal, hide, and re-reveal", () => {
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    assertUntouched(chart);
    act(() => backtestPanelHiddenSignal.set(true));
    assertUntouched(chart);
    act(() => backtestPanelHiddenSignal.set(false));
    assertUntouched(chart);
  });

  it("leaves the chart alone while the width handle is dragged", () => {
    withSizedChartCells();
    // The old width path deferred its shift to a frame, so a drag test that
    // never runs the frame would pass vacuously. Capture frames and run them.
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const chart = stubChart();
    mount(chart);
    const handle = screen.getByRole("separator", { name: /resize backtest panel/i });
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 680 });
    act(() => {
      for (const clientX of [670, 660, 650])
        handle.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: false }));
    });
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    assertUntouched(chart);
    act(() => backtestPanelHiddenSignal.set(true));
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    assertUntouched(chart);
    raf.mockRestore();
  });

  it("leaves the chart alone when the side-by-side results column is docked", () => {
    // The widest the panel gets (panel + results column): if any shift path
    // survived, this is where it would be largest.
    saveBacktestResultsSideBySide(true);
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    assertUntouched(chart);
  });

  it("leaves the chart alone across a pin / unpin round trip", () => {
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    fireEvent.click(screen.getByRole("button", { name: /pin panel/i }));
    assertUntouched(chart);
    fireEvent.click(screen.getByRole("button", { name: /unpin panel/i }));
    assertUntouched(chart);
  });

  it("leaves the chart alone on unmount (no give-back move either)", () => {
    // The shift used to be paid back in the effect cleanup. Nothing is owed
    // now, so teardown must be silent too.
    withSizedChartCells();
    const chart = stubChart();
    const { unmount } = (() => {
      const controller = new ChartController("cell-1", "scope-1");
      controller.chart = chart as unknown as import("klinecharts").Chart;
      return renderPanel(controller);
    })();
    assertUntouched(chart);
    act(() => unmount());
    assertUntouched(chart);
  });

  it("never routes a layout move through the cell's programmaticMove", () => {
    // The compensation's transport. No caller left means no chart motion the
    // sibling-cell time link has to be shielded from.
    withSizedChartCells();
    const chart = stubChart();
    const moves: Array<{ layout?: boolean } | undefined> = [];
    mount(chart, (c) => {
      c.programmaticMove = <T,>(fn: () => T, opts?: { layout?: boolean }) => {
        moves.push(opts);
        return fn();
      };
    });
    act(() => backtestPanelHiddenSignal.set(true));
    act(() => backtestPanelHiddenSignal.set(false));
    expect(moves).toEqual([]);
    assertUntouched(chart);
  });

  it("preserves a pan made while the overlay was up", () => {
    // End-to-end statement of the promise: whatever window the user scrolled
    // to stays put, panel or no panel.
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    act(() => chart.pan(9000));
    const after = chart.gapBars();
    act(() => backtestPanelHiddenSignal.set(true));
    act(() => backtestPanelHiddenSignal.set(false));
    expect(chart.gapBars()).toBeCloseTo(after);
    expect(chart.scrollByDistance).not.toHaveBeenCalled();
  });

  it("pinned mode never touches the offset either", () => {
    saveBacktestPanelPinned(true);
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    assertUntouched(chart);
  });
});

// The rule editors lint `<instance>.<output>` against the LIVE chart's panes,
// which the panel polls for. The panel is not modal — it outlives chart
// lifecycles — so the poll has to survive a chart that is absent when the panel
// opens, or the editors spend the whole session underlining valid references.
describe("chart pane list feeding the rule editors", () => {
  // A chart carrying one Slope pane (two lines), in the flat v10 getIndicators()
  // shape. Nothing else in the panel touches this stub.
  const slopeChart = () =>
    ({
      getIndicators: () => [
        {
          name: "SLOPE",
          paneId: "pane_1",
          calcParams: [9, 21],
          extendData: { indType: "SLOPE" },
        },
      ],
    }) as unknown as import("klinecharts").Chart;

  function renderWithRule(controller: ChartController) {
    return render(
      <BacktestSettingsModal
        initial={{
          ...defaultBacktestConfig(),
          longEntry: { combine: "AND", rules: [{ expr: "SLOPE.9 > 0", enabled: true }] },
          longExit: { combine: "AND", rules: [] },
        }}
        epic="TEST"
        brokerId="capital"
        resolution="MINUTE"
        controller={controller}
        chartTimezone="UTC"
        onRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it("recovers when the chart is absent at mount and appears on a later tick", async () => {
    const controller = new ChartController("cell-1", "scope-1");
    controller.chart = null; // cell has not mounted its chart yet
    renderWithRule(controller);

    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe("SLOPE.9 > 0");
    // No panes yet, so the reference reads as unknown.
    await waitFor(() => {
      forceLinting(view);
      expect(diagnosticCount(view.state)).toBe(1);
    });

    // The chart arrives. Nothing re-renders the panel and the controller's
    // identity is unchanged, so only the poll can notice.
    controller.chart = slopeChart();
    await waitFor(
      () => {
        forceLinting(view);
        expect(diagnosticCount(view.state)).toBe(0);
      },
      { timeout: 4000 },
    );
  });
});
