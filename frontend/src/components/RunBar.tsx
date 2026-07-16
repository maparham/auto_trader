// The backtest modal footer: the mode switch (Backtest | Sweep) on the left, a
// flexible sweep-info slot in the middle, and a right-pinned run cluster
// (Go live, Run). Extracted from BacktestSettingsModal so the footer layout
// lives in one place. Mode logic stays in the modal (`onSelectMode`); the four
// sweep-info pieces are passed in as `sweepInfo` because they read modal-local
// state. The per-bar Inspect toggle lives in the results panel's Inspect tab
// (it only applies to a single backtest), not here. `runClusterLead` is an
// optional slot at the head of the right-pinned run cluster — the sweep view
// puts its Cancel/Clear-results button there so it reads as a footer action.
// There is no Close button here — the header × is the only close control.

import type { JSX, ReactNode } from "react";
import Tooltip from "./Tooltip";

type RunMode = "backtest" | "sweep";

export function RunBar(props: {
  mode: RunMode;
  onSelectMode: (m: RunMode) => void;
  modeBadge: ReactNode;
  sweepInfo: ReactNode;
  runClusterLead?: ReactNode;
  onGoLive: () => void;
  runLabel: string;
  runDisabled: boolean;
  onRun: () => void;
}): JSX.Element {
  const {
    mode,
    onSelectMode,
    modeBadge,
    sweepInfo,
    runClusterLead,
    onGoLive,
    runLabel,
    runDisabled,
    onRun,
  } = props;

  return (
    <>
      <span className="seg bt-mode-seg" role="group" aria-label="Run mode">
        <Tooltip content="Run a single backtest. Sweep setup stays configured but inert.">
          <button
            type="button"
            className={mode === "backtest" ? "seg-on" : ""}
            aria-pressed={mode === "backtest"}
            onClick={() => onSelectMode("backtest")}
          >
            Backtest
          </button>
        </Tooltip>
        <Tooltip content="Sweep the toggled fields across their ranges, one run per combination.">
          <button
            type="button"
            className={mode === "sweep" ? "seg-on" : ""}
            aria-pressed={mode === "sweep"}
            onClick={() => onSelectMode("sweep")}
          >
            Sweep
            {/* A sweep stays visible from Backtest mode: progress while one
                runs in the background, else the configured combo count
                (redundant with the counter when Sweep mode is on). */}
            {modeBadge}
          </button>
        </Tooltip>
      </span>
      {/* Variable sweep info lives in this always-present flex slot, so the
          pinned controls on either side never move when the mode flips or
          axes come and go. */}
      <span className="bt-sweep-foot-info">{sweepInfo}</span>
      <div className="bt-run-cluster">
        {runClusterLead}
        <Tooltip content="Copy this strategy into the Live panel to trade a demo/live account">
          <button className="ghost bt-golive" onClick={onGoLive}>
            Go live →
          </button>
        </Tooltip>
        <button className="bt-run-btn" onClick={onRun} disabled={runDisabled}>
          {runLabel}
        </button>
      </div>
    </>
  );
}

export default RunBar;
