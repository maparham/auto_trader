// Drives the rule-proximity heatmap overlay on one chart: owns the on/off and
// view state, creates/removes the figure-less "ProximityHeatmap" indicator, and
// fetches closeness for the loaded window (repainting via overrideIndicator's
// extendData). The base timeframe is snapshotted from the chart resolution when
// the heatmap is turned on; it stays locked while the user changes timeframes,
// so higher timeframes aggregate the base and lower ones hide.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import { fetchClosenessHeatmap } from "../api";
import { heatmapVisible } from "../lib/proximityHeatmap";
import {
  alignValuesToBars,
  buildClosenessRequest,
  type HeatmapView,
} from "../lib/heatmapController";
import { collectExprInstances } from "../lib/exprInstances";
import { liveExprInstances } from "../lib/indicators";
import { backtestConfigLive } from "../lib/signals";
import { defaultBacktestConfig, type BacktestConfig } from "../lib/backtestConfig";
import { loadBacktestLastUsed } from "../lib/persist";

const HEATMAP_NAME = "ProximityHeatmap";
const PANE = "candle_pane";

const DEFAULT_VIEW: Omit<HeatmapView, "baseResolution"> = {
  side: "long",
  basis: "volatility",
  width: 2,
  window: 50,
  atrLength: 14,
  agg: "max",
};

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  epic: string;
  broker: string;
  priceSide: string;
  displayResolution: string;
}

// The heatmap reads the live panel config when the docked backtest panel is open,
// otherwise the persisted last-used config (both are BacktestConfig-shaped, as
// App seeds the panel from loadBacktestLastUsed()).
function currentConfig(): BacktestConfig {
  return backtestConfigLive.value ?? loadBacktestLastUsed() ?? defaultBacktestConfig();
}

export function useProximityHeatmap({ chartRef, epic, broker, priceSide, displayResolution }: Args) {
  const [on, setOnState] = useState(false);
  const [view, setViewState] = useState<HeatmapView>({ ...DEFAULT_VIEW, baseResolution: displayResolution });
  const [cfgVersion, setCfgVersion] = useState(0);

  // Latest values for imperative callbacks (pan/zoom actions) without stale closures.
  const latest = useRef({ on, view, epic, broker, priceSide, displayResolution });
  latest.current = { on, view, epic, broker, priceSide, displayResolution };

  // Monotonic request id: a resolved fetch applies only if still newest in flight.
  const reqSeq = useRef(0);

  const belowBase = on && !heatmapVisible(displayResolution, view.baseResolution);

  const setOn = useCallback((next: boolean) => {
    const c = chartRef.current;
    if (next) {
      // Lock the base timeframe to the resolution shown right now.
      setViewState((v) => ({ ...v, baseResolution: latest.current.displayResolution }));
      if (c) {
        c.removeIndicator({ paneId: PANE, name: HEATMAP_NAME }); // idempotent
        c.createIndicator({ name: HEATMAP_NAME, paneId: PANE }, true);
      }
    } else if (c) {
      c.removeIndicator({ paneId: PANE, name: HEATMAP_NAME });
    }
    setOnState(next);
  }, [chartRef]);

  const setView = useCallback(
    (patch: Partial<HeatmapView>) => setViewState((v) => ({ ...v, ...patch })),
    [],
  );

  // Track config edits published by the docked backtest panel.
  useEffect(() => backtestConfigLive.subscribe(() => setCfgVersion((n) => n + 1)), []);

  // Fetch closeness over the loaded window and repaint. Below the base timeframe
  // there is no finer signal, so paint nothing.
  const refetch = useCallback(() => {
    const c = chartRef.current;
    const cur = latest.current;
    if (!c || !cur.on) return;
    if (!heatmapVisible(cur.displayResolution, cur.view.baseResolution)) {
      c.overrideIndicator({ paneId: PANE, name: HEATMAP_NAME, extendData: { values: [] } });
      return;
    }
    const bars = c.getDataList();
    if (!bars.length) return;
    const req = buildClosenessRequest(currentConfig(), cur.view, {
      broker: cur.broker,
      epic: cur.epic,
      priceSide: cur.priceSide,
      displayResolution: cur.displayResolution,
      fromTime: Math.floor(bars[0].timestamp / 1000),
      toTime: Math.floor(bars[bars.length - 1].timestamp / 1000),
    });
    if (!req) {
      // No enabled rows on the active side: nothing to show.
      c.overrideIndicator({ paneId: PANE, name: HEATMAP_NAME, extendData: { values: [] } });
      return;
    }
    const seq = ++reqSeq.current;
    // The rows are the same expressions the backtest runs, so a row referencing a
    // chart pane ("SLOPE.9") needs that pane's live settings here too — the
    // backend cannot evaluate the row without them. Copied rather than mutated:
    // `req` is what the staleness check below compares against.
    fetchClosenessHeatmap({
      ...req,
      indicators: collectExprInstances(liveExprInstances(c), req.rows),
    })
      .then((resp) => {
        const cc = chartRef.current;
        const now = latest.current;
        // Drop if superseded or the symbol/side/resolution drifted mid-flight.
        if (!cc || seq !== reqSeq.current) return;
        if (req.epic !== now.epic || req.broker !== now.broker
          || req.priceSide !== now.priceSide || req.displayResolution !== now.displayResolution) return;
        const times = cc.getDataList().map((b) => Math.floor(b.timestamp / 1000));
        cc.overrideIndicator({
          paneId: PANE,
          name: HEATMAP_NAME,
          extendData: { values: alignValuesToBars(times, resp) },
        });
      })
      .catch(() => { /* transient fetch error: keep the last paint */ });
  }, [chartRef]);

  // Symbol or timeframe switch: clear the previous paint at once so the old
  // symbol's columns don't linger over new bars during the debounce + fetch below.
  useEffect(() => {
    const c = chartRef.current;
    if (!c || !on) return;
    c.overrideIndicator({ paneId: PANE, name: HEATMAP_NAME, extendData: { values: [] } });
  }, [chartRef, on, epic, displayResolution]);

  // Refetch on any input change, debounced so a burst of rule edits fires once.
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(refetch, 150);
    return () => window.clearTimeout(t);
  }, [on, view, cfgVersion, epic, broker, priceSide, displayResolution, refetch]);

  // Pan/zoom brings new bars into view; refetch to cover them, coalesced to one
  // call per settle.
  useEffect(() => {
    const c = chartRef.current;
    if (!c || !on) return;
    let t: number | null = null;
    const settle = () => {
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(refetch, 200);
    };
    c.subscribeAction("onScroll", settle);
    c.subscribeAction("onZoom", settle);
    return () => {
      if (t != null) window.clearTimeout(t);
      c.unsubscribeAction("onScroll", settle);
      c.unsubscribeAction("onZoom", settle);
    };
  }, [chartRef, on, refetch]);

  return { on, setOn, view, setView, belowBase };
}
