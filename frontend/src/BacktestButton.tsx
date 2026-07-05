// The Backtest control, lifted out of the toolbar into the top tab bar. Runs the
// user's rule-built strategy (⚙ opens the settings modal) on the focused cell's
// chart and overlays markers + equity; the summary chip (pnl / trades / win%)
// sits to its right. Self-contained: it owns its own run state and only needs
// the focused controller + the active period/broker.

import { useEffect, useState, useSyncExternalStore } from "react";
import { runAndRender, clearBacktest } from "./lib/backtest";
import type { ChartController } from "./lib/chartController";
import { fetchRange, RESOLUTION_SECONDS, type Period } from "./lib/feed";
import type { PriceSide } from "./theme";
import { buildSeries } from "./lib/backtestSeries";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
} from "./lib/backtestWindow";
import { loadBacktestLastUsed, saveBacktestLastUsed } from "./lib/persist";
import { openBacktestSettings, backtestRunRequest, backtestResultSignal } from "./lib/signals";

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

  // The summary chip mirrors the active backtest result straight off the signal
  // (same store BacktestPanel reads). Driving it off the signal — not just a
  // fresh run — means a rehydrate after a timeframe switch or a reload, where
  // ChartCore's rehydrateBacktest republishes the stored result, brings the chip
  // back too.
  const activeResult = useSyncExternalStore(
    (cb) => backtestResultSignal.subscribe(cb),
    () => backtestResultSignal.value,
  );
  const summary = activeResult?.summary ?? null;

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

  // The settings modal's "Run backtest" saves the config as last-used then bumps
  // this signal, re-triggering the same ▶ Backtest action (run() always reads
  // the latest last-used config, so no config needs to be threaded through here).
  useEffect(() => backtestRunRequest.subscribe(() => void run()));

  async function run() {
    if (!chart || !epic || !period || running) return;
    setRunning(true);
    setError(null);
    setWarning(null);
    try {
      const cfg = loadBacktestLastUsed() ?? defaultBacktestConfig();
      const resSeconds = RESOLUTION_SECONDS[period.resolution] ?? 60;
      const now = Date.now();
      const { fromMs: windowFromMs, toMs: windowToMs } = resolveWindow(cfg, resSeconds, now);
      const toSec = Math.floor(windowToMs / 1000);
      const fetchBars = (fromMs: number) =>
        fetchRange(epic, period.resolution, Math.floor(Math.max(0, fromMs) / 1000), toSec, priceSide, brokerId);

      const required = requiredWarmupBars(cfg);
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

      const series = buildSeries(bars, cfg);
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
          resolution: period.resolution,
          candles,
          series,
          longEntry: cfg.longEntry,
          longExit: cfg.longExit,
          shortEntry: cfg.shortEntry,
          shortExit: cfg.shortExit,
          // `!== false` so a preset predating these flags (undefined) still trades.
          longEnabled: cfg.longEnabled !== false,
          shortEnabled: cfg.shortEnabled !== false,
          longRisk: cfg.longRisk,
          shortRisk: cfg.shortRisk,
          longScaling: cfg.longScaling,
          shortScaling: cfg.shortScaling,
          costs: cfg.costs,
          tradeFromTime,
        },
        controller!.scope,
      );
      // The summary chip is driven by the signal subscription above, so just
      // publish the result (rehydrate uses the same publish path).
      backtestResultSignal.set(res);
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
        className="tabbar-action"
        onClick={run}
        disabled={running || !chart || !!period?.liveOnly}
        title={period?.liveOnly ? "Backtest needs history (not available sub-minute)" : "Run the backtest"}
      >
        {running ? "Running…" : "▶ Backtest"}
      </button>
      <button
        className="tabbar-action bt-gear"
        onClick={openBacktestSettings}
        title="Backtest settings"
        aria-label="Backtest settings"
      >
        ⚙
      </button>
      {summary && (
        <span className="bt-summary">
          <span className={summary.net_pnl >= 0 ? "pos" : "neg"}>
            {summary.net_pnl >= 0 ? "+" : ""}
            {summary.net_pnl.toFixed(2)}
          </span>
          <span>{summary.n_trades} trades</span>
          <span title="Largest peak-to-trough equity drop">
            −{summary.max_drawdown.toFixed(2)} dd
          </span>
          <span>{(summary.win_rate * 100).toFixed(0)}% win</span>
          <button className="bt-clear" title="Clear backtest" onClick={clear}>
            ✕
          </button>
        </span>
      )}
      {warning && <span className="bt-warning" title={warning}>⚠ short warm-up</span>}
      {error && <span className="bt-error">{error}</span>}
    </div>
  );
}
