// The Backtest control, lifted out of the toolbar into the top tab bar. Runs the
// user's rule-built strategy (⚙ opens the settings modal) on the focused cell's
// chart and overlays markers + equity; the summary chip (pnl / trades / win%)
// sits to its right. Self-contained: it owns its own run state and only needs
// the focused controller + the active period/broker.

import { useEffect, useState } from "react";
import { runAndRender, clearBacktest } from "./lib/backtest";
import type { ChartController } from "./lib/chartController";
import { fetchRange, RESOLUTION_SECONDS, type Period } from "./lib/feed";
import type { PriceSide } from "./theme";
import { buildSeries } from "./lib/backtestSeries";
import { defaultBacktestConfig, activeGroup } from "./lib/backtestConfig";
import { resolveMask } from "./lib/backtestSchedule";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
} from "./lib/backtestWindow";
import { loadBacktestLastUsed, saveBacktestLastUsed, loadBacktestPeriodsShown } from "./lib/persist";
import {
  openBacktestSettings,
  backtestRunRequest,
  backtestClearRequest,
  backtestResultSignal,
  backtestMessagesSignal,
  backtestPeriodsShownSignal,
} from "./lib/signals";

interface Props {
  controller: ChartController | null;
  period?: Period;
  // Symbol epic — only used to reset the readout when the instrument changes.
  epic?: string;
  brokerId: string;
  // The chart's active price side. The backtest MUST fetch the same side the
  // chart shows: the cache is populated per side, and a mismatch (e.g. fetching
  // "mid" while the chart shows "bid") silently backtests a different, often
  // far shorter, candle series than the one on screen.
  priceSide: PriceSide;
}

export default function BacktestButton({ controller, period, epic, brokerId, priceSide }: Props) {
  const chart = controller?.chart ?? null;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // The transient run messages (error / short-warm-up warning) belong to a
  // specific run; drop them when the symbol or timeframe changes. Reset during
  // render on the key change (React's "adjust state on prop change" pattern)
  // rather than in an effect. The result itself is now persisted and rehydrated
  // by ChartCore, so it is NOT cleared here anymore.
  const runKey = `${epic ?? ""}|${period?.resolution ?? ""}`;
  const [msgKey, setMsgKey] = useState(runKey);
  if (msgKey !== runKey) {
    setMsgKey(runKey);
    setError(null);
    setWarning(null);
  }

  // Publish the transient messages so the results pane renders them (they no
  // longer live next to this toolbar button).
  useEffect(() => {
    backtestMessagesSignal.set({ error, warning });
  }, [error, warning]);

  // The results pane's clear (✕) asks for a clear through this signal; the
  // teardown lives here because only this component has the chart/controller.
  useEffect(() => backtestClearRequest.subscribe(() => clear()));

  // The panel's "Run backtest" saves the config as last-used then bumps this
  // signal, which runs the backtest here (run() always reads the latest
  // last-used config, so no config needs to be threaded through). The toolbar
  // button only opens the panel — running lives with the config.
  useEffect(() => backtestRunRequest.subscribe(() => void run()));

  // Seed the period-shading toggle from device-local storage once at startup
  // (the component is mounted for the whole app session).
  useEffect(() => {
    backtestPeriodsShownSignal.set(loadBacktestPeriodsShown());
  }, []);

  async function run() {
    if (!chart || !epic || !period || running) return;
    setRunning(true);
    setError(null);
    setWarning(null);
    try {
      const cfg = loadBacktestLastUsed() ?? defaultBacktestConfig();
      // The config timeframe overrides the active chart timeframe when set;
      // absent means follow the chart (the historical behavior).
      const runResolution = cfg.range.resolution ?? period.resolution;
      const resSeconds = RESOLUTION_SECONDS[runResolution] ?? 60;
      const now = Date.now();
      const { fromMs: windowFromMs, toMs: windowToMs } = resolveWindow(cfg, resSeconds, now);
      const toSec = Math.floor(windowToMs / 1000);
      const fetchBars = (fromMs: number) =>
        fetchRange(epic, runResolution, Math.floor(Math.max(0, fromMs) / 1000), toSec, priceSide, brokerId);

      const required = requiredWarmupBars(cfg, resSeconds);
      const depth = cfg.range.history ?? "full";
      let bars = await fetchBars(resolveHistoryStart(cfg, windowFromMs, resSeconds));

      // The requested depth can exceed what the broker/account actually serves
      // (e.g. "Full" asking further back than a live account's history limit) —
      // that can come back either completely empty OR a non-empty but too-short
      // history (a broker rejecting only the oldest chunk, or the cache serving
      // whatever it already had). Either way, retry once at the minimal depth
      // (the smallest, most likely-to-succeed ask) rather than only checking for
      // the empty case.
      if (depth !== "minimal" && (bars.length === 0 || warmupBarCount(bars, windowFromMs) < required)) {
        const retried = await fetchBars(minimalHistoryStart(cfg, windowFromMs, resSeconds));
        if (warmupBarCount(retried, windowFromMs) > warmupBarCount(bars, windowFromMs)) {
          bars = retried;
        }
      }

      const tradeFromTime = Math.round(windowFromMs / 1000);
      if (!bars.some((k) => Math.round(k.timestamp / 1000) >= tradeFromTime)) {
        setError("no candles in the selected range");
        return;
      }

      const warmup = warmupBarCount(bars, windowFromMs);
      if (warmup < required) {
        setWarning(`only ${warmup} of ${required} warm-up bars available — indicators may be cold at the start of the window`);
      }

      // A rule operand may reference a higher timeframe than the base run; fetch
      // each such timeframe over the same span as the base history so its
      // indicator is warm, then buildSeries forward-fills it onto the base bars.
      const htfFromSec = Math.floor(Math.max(0, bars[0].timestamp) / 1000);
      const fetchTimeframe = (resolution: string) =>
        fetchRange(epic, resolution, htfFromSec, toSec, priceSide, brokerId);
      const series = await buildSeries(bars, cfg, runResolution, fetchTimeframe);
      const candles = bars.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume ?? 0,
      }));

      const res = await runAndRender(
        chart,
        {
          epic,
          resolution: runResolution,
          candles,
          series,
          // Disabled rules are kept in the config but dropped from the run.
          longEntry: activeGroup(cfg.longEntry),
          longExit: activeGroup(cfg.longExit),
          shortEntry: activeGroup(cfg.shortEntry),
          shortExit: activeGroup(cfg.shortExit),
          // `!== false` so a preset predating these flags (undefined) still trades.
          longEnabled: cfg.longEnabled !== false,
          shortEnabled: cfg.shortEnabled !== false,
          longRisk: cfg.longRisk,
          shortRisk: cfg.shortRisk,
          longScaling: cfg.longScaling,
          shortScaling: cfg.shortScaling,
          costs: cfg.costs,
          tradeFromTime,
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        },
        controller!.scope,
        // Displayed TF, so runAndRender picks native/aggregate/none correctly when
        // the run's base TF (runResolution) differs from what the chart shows.
        period.resolution,
        {
          fromMs: windowFromMs,
          toMs: windowToMs,
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        },
      );
      // The summary chip is driven by the signal subscription above, so just
      // publish the result (rehydrate uses the same publish path).
      backtestResultSignal.set(res);
      // The run's range can predate the chart's currently-loaded (recent) bars —
      // runAndRender then culls those fills as out-of-window. Page history back to
      // cover the run, which reanchors the markers onto their real candles (same
      // walk the timeframe-switch rehydrate uses). No-op when already covered.
      controller?.coverDrawingAnchors?.();
      saveBacktestLastUsed(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    // Delete the persisted result too, so it doesn't come back on the next
    // timeframe switch or reload. (summary follows backtestResultSignal.)
    if (chart && controller && epic) clearBacktest(chart, controller.scope, epic);
    backtestResultSignal.set(null);
    setError(null);
    setWarning(null);
  }

  return (
    <div className="backtest">
      <button
        className={`anchor-btn backtest-toggle${running ? " on" : ""}`}
        onClick={openBacktestSettings}
        title={running ? "Backtest running…" : "Open the backtest panel"}
      >
        {/* Bar chart + play: run a strategy over historical bars. */}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M4 20v-8M9 20V8" />
          <path d="M13.5 9.5 20 13l-6.5 3.5z" />
        </svg>
      </button>
    </div>
  );
}
