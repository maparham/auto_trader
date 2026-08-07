// @vitest-environment jsdom
//
// Overlay / auto-hide layout mode for the backtest panel: pin toggle, hidden
// state, chart-click hide, peek-tab reveal, and chart right-offset compensation.
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
  // sidebars and the live-trading panel, and the width compensation overshot
  // by their widths.
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

describe("chart offset compensation", () => {
  // Models klinecharts 10's REAL scroll semantics, because the bugs this guards
  // against only exist against them:
  //   - the store's scroll position is _lastBarRightSideDiffBarCount, in BARS.
  //     scroll(distance) does diffBarCount -= distance/barSpace, converting px
  //     to bars at CALL time (index.esm.js StoreImp.prototype.scroll) — so a
  //     px delta applied at one zoom and reversed at another does not cancel.
  //     `gapBars` is therefore the source of truth here, not a pixel count.
  //   - a NEGATIVE distance widens the right-hand gap.
  //   - getOffsetRightDistance() is Math.max(0, diffBarCount * barSpace) — the
  //     LIVE position, clamped to 0 once the user pans back into history. So a
  //     capture-base/restore-base implementation reads a lie and teleports.
  //   - getBarSpace() returns the klinecharts BarSpace record, not a number.
  // `pan` and `zoom` stand in for the user dragging / wheeling the chart
  // between apply and cleanup.
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

  // The compensation is gated on the chart host having a real laid-out width
  // (see the zero-width test below), and jsdom reports clientWidth 0 for every
  // element — so the normal-path tests have to fake it.
  function withSizedChartCells(clientWidth = 1400): HTMLElement {
    const cells = withChartCells();
    Object.defineProperty(chartMain(), "clientWidth", { value: clientWidth, configurable: true });
    return cells;
  }
  function mount(chart: ReturnType<typeof stubChart>, prepare?: (c: ChartController) => void) {
    const controller = new ChartController("cell-1", "scope-1");
    controller.chart = chart as unknown as import("klinecharts").Chart;
    // `prepare` runs BEFORE the first render, so a test watching
    // programmaticMove sees the mount-time apply too, not just the reversal.
    prepare?.(controller);
    renderPanel(controller);
    return controller;
  }

  beforeEach(() => {
    backtestPanelHiddenSignal.set(false);
    // jsdom defaults to 1024px; clampWidth (BacktestSettingsModal.tsx) would
    // shrink the 720 default panel width down to innerWidth-380=644 at that
    // size. Widen past 720+380 so the default width survives the clamp and
    // the 726 expectation below (base 6 + panel 720) actually holds.
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true, writable: true });
  });
  afterEach(() => {
    removeChartArea();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  });

  it("widens the right gap by the overlay width, and gives exactly that back on hide", () => {
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    // Negative distance widens the right gap: 6 + 720 (default panel width).
    // Exact single-argument match — an animationDuration would make the
    // compensation a visible slide and fail here.
    expect(chart.scrollByDistance).toHaveBeenLastCalledWith(-720);
    expect(chart.gapPx()).toBeCloseTo(726);
    act(() => backtestPanelHiddenSignal.set(true));
    expect(chart.scrollByDistance).toHaveBeenLastCalledWith(720);
    expect(chart.gapPx()).toBeCloseTo(6);
    // Relative moves only — an absolute set is the teleport bug.
    expect(chart.setOffsetRightDistance).not.toHaveBeenCalled();
  });

  it("reverses in BARS, so a zoom between reveal and hide leaves no residual", () => {
    // The store counts the gap in bars and converts px at call time, so
    // applying -720px at barSpace 10 (=72 bars) and handing back +720px at
    // barSpace 20 would return only 36 bars — a permanent 36-bar strip of
    // whitespace the user can never scroll away.
    withSizedChartCells();
    const chart = stubChart(10);
    mount(chart);
    expect(chart.gapBars()).toBeCloseTo(0.6 + 72);
    act(() => chart.zoom(20)); // user wheels in: bars are now twice as wide
    act(() => backtestPanelHiddenSignal.set(true));
    expect(chart.gapBars()).toBeCloseTo(0.6);
    // Stated in the units that matter: 72 bars out, 72 bars back.
    expect(chart.scrollByDistance).toHaveBeenLastCalledWith(72 * 20);
  });

  it("preserves a pan made while the overlay was up (no teleport to the newest bar)", () => {
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    expect(chart.gapPx()).toBeCloseTo(726);
    // The user drags the chart far back into history: the right gap goes
    // negative and getOffsetRightDistance() now reports a clamped 0, which is
    // precisely what a capture-base implementation would "restore" to.
    act(() => chart.pan(9000));
    expect(chart.gapPx()).toBeCloseTo(-8274);
    expect(chart.getOffsetRightDistance()).toBe(0);
    act(() => backtestPanelHiddenSignal.set(true));
    // Only the overlay's own width comes back — the pan survives untouched.
    expect(chart.scrollByDistance).toHaveBeenLastCalledWith(720);
    expect(chart.gapPx()).toBeCloseTo(-8994);
    expect(chart.setOffsetRightDistance).not.toHaveBeenCalled();
  });

  it("never shifts by more than the chart is wide", () => {
    // The alerts (300px) and trade (268px) sidebars make the chart much
    // narrower than the window, and the user-facing width clamps only know
    // about the window — so the overlay can legitimately be wider than the
    // chart it covers. Shifting by the full overlay width would then blow past
    // klinecharts' own right-scroll limit, which clamps the apply but not the
    // reversal, drifting the view left by the remainder.
    withSizedChartCells(600);
    const chart = stubChart();
    mount(chart);
    expect(chart.scrollByDistance).toHaveBeenLastCalledWith(-(600 - 120));
    act(() => backtestPanelHiddenSignal.set(true));
    expect(chart.gapPx()).toBeCloseTo(6);
  });

  it("does not scroll a chart host that has not been laid out", () => {
    // The toolbar's Backtest button works while the trading dock is maximized,
    // which hides .workspace outright (display:none → clientWidth 0). There is
    // no meaningful width to compensate for, and scrolling a zero-size chart
    // is how you get a nonsense offset that survives the un-maximize.
    withChartCells(); // no clientWidth override: jsdom reports 0
    const chart = stubChart();
    mount(chart);
    expect(chart.scrollByDistance).not.toHaveBeenCalled();
    act(() => backtestPanelHiddenSignal.set(true));
    expect(chart.scrollByDistance).not.toHaveBeenCalled();
  });

  it("routes the scroll through the cell's programmaticMove, flagged as layout", () => {
    // Otherwise ChartCore's scroll listener reads the compensation as a user
    // gesture: it drops the quick-range pill and, under syncTime, broadcasts
    // the shift to every sibling cell in the grid.
    withSizedChartCells();
    const chart = stubChart();
    const moves: Array<{ layout?: boolean } | undefined> = [];
    // Installed before the first render, so BOTH ends are covered — the apply
    // on reveal as well as the reversal on hide.
    mount(chart, (c) => {
      c.programmaticMove = <T,>(fn: () => T, opts?: { layout?: boolean }) => {
        moves.push(opts);
        return fn();
      };
    });
    expect(moves).toEqual([{ layout: true }]);
    act(() => backtestPanelHiddenSignal.set(true));
    expect(moves).toEqual([{ layout: true }, { layout: true }]);
    expect(chart.gapPx()).toBeCloseTo(6);
  });

  it("coalesces a width drag into one net shift per frame", () => {
    // The drag handle fires pointermove per frame; re-running the compensation
    // per move meant a full give-back + re-take (two klinecharts layout cycles
    // and two onScroll dispatches) per pixel dragged. The frame's moves must
    // collapse into a single scroll for the NET width change.
    withSizedChartCells();
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => { frames.push(cb); return frames.length; });
    try {
      const chart = stubChart();
      mount(chart);
      // Mount is synchronous (not deferred to a frame) so the panel never
      // appears over uncompensated candles.
      expect(chart.scrollByDistance).toHaveBeenCalledTimes(1);
      const handle = screen.getByRole("separator", { name: /resize backtest panel/i });
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 680 });
      // Three moves in one frame: 720 -> 730 -> 740 -> 750.
      act(() => {
        for (const clientX of [670, 660, 650])
          handle.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: false }));
      });
      // Nothing yet — the width changes are waiting on the frame.
      expect(chart.scrollByDistance).toHaveBeenCalledTimes(1);
      act(() => frames.splice(0).forEach((cb) => cb(0)));
      // Exactly one more call, for the net +30px, not three round trips.
      expect(chart.scrollByDistance).toHaveBeenCalledTimes(2);
      expect(chart.scrollByDistance).toHaveBeenLastCalledWith(-30);
      expect(chart.gapPx()).toBeCloseTo(756);
      // And the whole 750 still comes back on hide.
      act(() => backtestPanelHiddenSignal.set(true));
      expect(chart.gapPx()).toBeCloseTo(6);
    } finally {
      raf.mockRestore();
    }
  });

  it("pinned mode never touches the offset", () => {
    saveBacktestPanelPinned(true);
    withSizedChartCells();
    const chart = stubChart();
    mount(chart);
    expect(chart.scrollByDistance).not.toHaveBeenCalled();
    expect(chart.setOffsetRightDistance).not.toHaveBeenCalled();
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
