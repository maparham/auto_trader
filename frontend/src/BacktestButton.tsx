// The Backtest control, lifted out of the toolbar into the top tab bar. It runs
// the SMA-cross strategy on the focused cell's chart and overlays markers +
// equity; the summary chip (pnl / trades / win%) sits to its right. Self-
// contained: it owns its own run state and only needs the focused controller +
// the active period (to gate sub-minute timeframes that have no history).

import { useEffect, useState } from "react";
import { runAndRender, clearBacktest } from "./lib/backtest";
import type { BacktestResult } from "./api";
import type { ChartController } from "./lib/chartController";
import type { Period } from "./lib/feed";

interface Props {
  controller: ChartController | null;
  period?: Period;
  // Symbol epic — only used to reset the readout when the instrument changes.
  epic?: string;
}

export default function BacktestButton({ controller, period, epic }: Props) {
  const chart = controller?.chart ?? null;
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<BacktestResult["summary"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Backtest results belong to a specific symbol/timeframe; drop them on change
  // (ChartCore clears the on-chart artifacts; this clears the readout).
  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [epic, period?.resolution]);

  async function run() {
    if (!chart || !epic || !period || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await runAndRender(chart, {
        epic,
        resolution: period.resolution,
        bars: 500,
        fast: 9,
        slow: 21,
      });
      setSummary(res.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    if (chart) clearBacktest(chart);
    setSummary(null);
    setError(null);
  }

  return (
    <div className="backtest">
      <button
        className="tabbar-action"
        onClick={run}
        disabled={running || !chart || !!period?.liveOnly}
        title={
          period?.liveOnly
            ? "Backtest needs history (not available sub-minute)"
            : "Run the SMA-cross backtest"
        }
      >
        {running ? "Running…" : "▶ Backtest"}
      </button>
      {summary && (
        <span className="bt-summary">
          <span className={summary.net_pnl >= 0 ? "pos" : "neg"}>
            {summary.net_pnl >= 0 ? "+" : ""}
            {summary.net_pnl.toFixed(2)}
          </span>
          <span>{summary.n_trades} trades</span>
          <span>{(summary.win_rate * 100).toFixed(0)}% win</span>
          <button className="bt-clear" title="Clear backtest" onClick={clear}>
            ✕
          </button>
        </span>
      )}
      {error && <span className="bt-error">{error}</span>}
    </div>
  );
}
