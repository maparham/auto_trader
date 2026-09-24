// The backtest panel's placement: dock width, pinned vs overlay, the overlay's
// hide/reveal rules, the unpinned portal host, and the docked results column.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { backtestPanelHiddenSignal, backtestRunningSignal, sweepStateSignal, wfoStateSignal } from "../lib/signals";
import {
  BACKTEST_PANEL_DEFAULT_WIDTH,
  BACKTEST_RESULTS_COL_DEFAULT_WIDTH,
  loadBacktestPanelPinned,
  loadBacktestPanelWidth,
  loadBacktestResultsColWidth,
  loadBacktestResultsSideBySide,
  saveBacktestPanelPinned,
  saveBacktestPanelWidth,
  saveBacktestResultsColWidth,
  saveBacktestResultsSideBySide,
} from "../lib/persist";
import type { BacktestTab } from "./shared";

export function usePanelLayout(pickingRange: boolean, setTab: Dispatch<SetStateAction<BacktestTab>>) {
  // Panel width (px), dragged via the left-edge handle. Device-local view
  // preference like the split above. Clamped so the panel never eats the whole
  // viewport (keeps at least the chart's ~380px) nor shrinks below its min.
  const clampWidth = (w: number) =>
    Math.max(560, Math.min(w, Math.max(560, window.innerWidth - 380)));
  // Re-clamp on load: a width saved on a wider monitor must not swallow the
  // chart when reopened on a smaller window.
  const [panelWidth, setPanelWidth] = useState<number>(() => clampWidth(loadBacktestPanelWidth()));
  // Layout mode: pinned docks the panel beside the chart (the chart shrinks —
  // the pre-overlay behaviour); unpinned overlays the chart and auto-hides on
  // chart click. Device-local, like the width.
  const [pinned, setPinnedState] = useState<boolean>(loadBacktestPanelPinned);
  const setPinned = (on: boolean) => {
    setPinnedState(on);
    saveBacktestPanelPinned(on);
  };
  // Overlay hidden state (module signal so the toolbar can reveal, see
  // signals.ts). Reset on unmount: a re-opened panel always starts revealed.
  const hidden = useSyncExternalStore(
    (cb) => backtestPanelHiddenSignal.subscribe(cb),
    () => backtestPanelHiddenSignal.value,
  );
  useEffect(() => () => backtestPanelHiddenSignal.set(false), []);
  // The unpinned overlay is portaled into App's `main.chart` rather than
  // rendered here. Its containing block decides what it covers: parented to
  // .workspace (this component's render site) the absolute wrapper spanned the
  // WHOLE workspace, so it sat on top of the alerts sidebar / trade sidebar /
  // live-trading panel whenever those were open. Anchored to the chart area,
  // `right: 0` means the chart's right edge — the panel covers the chart and
  // nothing else. Pinned mode is NOT portaled: docking is a flex-order
  // question that belongs to App (chart, alerts, trade, backtest, live), and
  // moving the render site would reshuffle that order.
  // Looked up from the DOM, not passed as a ref, because App renders this
  // panel as a SIBLING of main.chart — there is no ref to thread down without
  // rewiring the render site. The lazy initial read covers a panel opened into
  // an already-painted app (the common case, portaling on the very first
  // render with no remount); the mount-once layout effect covers the panel
  // being open at first paint, where main.chart is only in the DOM by the time
  // effects run. Once, not per-render: main.chart is rendered unconditionally
  // by App for the app's whole lifetime, so the host can't go stale.
  const [chartHost, setChartHost] = useState<HTMLElement | null>(() =>
    document.querySelector<HTMLElement>("main.chart"),
  );
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>("main.chart");
    setChartHost((prev) => (prev === el ? prev : el));
  }, []);
  // Hiding while focus is inside the panel would leave the caret in a field
  // that is sliding off-screen: for the 180ms of the transition (and after it,
  // since .bt-hidden only flips `visibility` once the slide ends) typing would
  // still land in an input nobody can see, and Tab would walk a hidden form.
  // Blur back to the body so the next keystroke reaches the chart instead.
  // Scoped to the panel subtree so it can never steal focus from elsewhere.
  useEffect(() => {
    if (pinned || !hidden) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".bt-overlay")) active.blur();
  }, [hidden, pinned]);
  // Chart mousedown → hide (unpinned only). Capture-phase document listener
  // keyed on .chart-cells: only real chart-area presses hide — panel clicks,
  // toolbar clicks, and portaled popovers never match, so nothing hover- or
  // focus-based can accidentally dismiss the panel.
  useEffect(() => {
    if (pinned || hidden) return;
    const onDown = (e: MouseEvent) => {
      // While a run streams you're watching results land — chart clicks
      // shouldn't dismiss them. Hide-on-click resumes when the run completes.
      const running =
        backtestRunningSignal.value ||
        !!sweepStateSignal.value?.running ||
        !!wfoStateSignal.value?.running;
      if (running) return;
      const t = e.target as Element | null;
      if (t?.closest(".chart-cells")) backtestPanelHiddenSignal.set(true);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [pinned, hidden]);
  // Pick Range is a chart drag by definition: arming it ducks the overlay out
  // of the way; disarming (picked or cancelled) brings it back. Pinned mode
  // needs no duck — the chart isn't covered.
  // The reveal on disarm is deliberately UNCONDITIONAL — it overrides an
  // earlier deliberate hide. Arming Pick Range means the user is mid-edit in
  // the range fields this pick fills in, so dropping them back at those fields
  // is what they asked for; leaving the panel hidden would strand the result.
  const prevPicking = useRef(false);
  useEffect(() => {
    if (!pinned) {
      if (pickingRange) backtestPanelHiddenSignal.set(true);
      else if (prevPicking.current) backtestPanelHiddenSignal.set(false);
    }
    prevPicking.current = pickingRange;
  }, [pickingRange, pinned]);
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the panel.
      w = clampWidth(startW + (startX - ev.clientX));
      setPanelWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      saveBacktestPanelWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    // A cancelled drag (e.g. the browser steals the pointer) must tear the
    // move listener down too, or hovering the edge would keep resizing with no
    // button held.
    el.addEventListener("pointercancel", onUp);
  };

  // Results layout: stacked (default) vs a docked column beside the panel. Stacked,
  // the results are the last section of the panel's own scroll pane; in column
  // mode they move out and their tab goes with them.
  const [sideBySide, setSideBySide] = useState<boolean>(loadBacktestResultsSideBySide);
  const setResultsSideBySide = (on: boolean) => {
    setSideBySide(on);
    saveBacktestResultsSideBySide(on);
    // The Results tab leaves with the results, so a selection still pointing at
    // it would highlight nothing. Costs is where the pane lands: it becomes the
    // last scrolling section, and the scroll clamps into it once the results
    // unmount.
    if (on) setTab((t) => (t === "results" ? "costs" : t));
  };
  // Keep the chart at least ~200px even with the config panel + this column both docked.
  const clampColWidth = (w: number) =>
    Math.max(360, Math.min(w, Math.max(360, window.innerWidth - panelWidth - 200)));
  const [resultsColWidth, setResultsColWidth] = useState<number>(() =>
    clampColWidth(loadBacktestResultsColWidth()),
  );
  // The unpinned overlay is chrome floating over the chart: it must never move
  // the chart. An earlier version compensated for the covered right edge by
  // scrolling the focused cell left by the overlay's width (and paying it back
  // on hide/close/pin), which meant opening the panel shifted the candles under
  // it. Deliberately gone — a panel only affects the chart when it is PINNED,
  // where the chart genuinely shrinks beside it. Nothing here may touch the
  // chart's scroll/offset; use the peek tab or pin instead of a shift.
  const onResultsColResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = resultsColWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the column.
      w = clampColWidth(startW + (startX - ev.clientX));
      setResultsColWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      saveBacktestResultsColWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
  // Double-click on either resize handle snaps back to the default width.
  const resetPanelWidth = () => {
    setPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH);
    saveBacktestPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH);
  };
  const resetResultsColWidth = () => {
    setResultsColWidth(clampColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH));
    saveBacktestResultsColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
  };
  return {
    panelWidth,
    resetPanelWidth,
    onResizeStart,
    pinned,
    setPinned,
    hidden,
    chartHost,
    sideBySide,
    setResultsSideBySide,
    resultsColWidth,
    resetResultsColWidth,
    onResultsColResizeStart,
  };
}
