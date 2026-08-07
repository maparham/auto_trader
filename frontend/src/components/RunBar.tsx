// The backtest modal footer: a flexible sweep-info slot on the left and a
// right-pinned run cluster (Run). Extracted from BacktestSettingsModal
// so the footer layout lives in one place. The Backtest | Sweep | Walk-fwd mode switch
// (`ModeSeg`) renders at the right end of the panel's tab bar instead, but is
// exported from here so mode UI stays alongside the rest of the run controls. The four
// sweep-info pieces are passed in as `sweepInfo` because they read modal-local
// state. The per-bar Inspect toggle lives in the results panel's Inspect tab
// (it only applies to a single backtest), not here. `runClusterLead` is an
// optional slot at the head of the right-pinned run cluster — the sweep view
// puts its Cancel/Clear-results button there so it reads as a footer action.
// `onRun` is optional so the modal can split the footer when the docked
// results column is open: the panel keeps the sweep info, the column's own
// footer takes Cancel/Clear + Run. "Go live →" is not here — it lives in the
// Presets section of the config panel, next to save/load.
// There is no Close button here — the header × is the only close control.

import type { JSX, ReactNode } from "react";
import Tooltip from "./Tooltip";

import type { BacktestRunMode as RunMode } from "../lib/persist/defaults";

export function ModeSeg(props: {
  mode: RunMode;
  onSelectMode: (m: RunMode) => void;
  modeBadge: ReactNode;
  // Optional badge slot inside the Walk-fwd button (mirrors modeBadge in
  // Sweep); optional so existing two-mode callers compile unchanged.
  wfoBadge?: ReactNode;
}): JSX.Element {
  const { mode, onSelectMode, modeBadge, wfoBadge } = props;
  return (
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
      <Tooltip content="Walk-forward optimization: pick parameters on train windows, verify out-of-sample">
        <button
          type="button"
          className={mode === "walkforward" ? "seg-on" : ""}
          aria-pressed={mode === "walkforward"}
          onClick={() => onSelectMode("walkforward")}
        >
          Walk-fwd
          {wfoBadge}
        </button>
      </Tooltip>
    </span>
  );
}

export function RunBar(props: {
  lead?: ReactNode;
  sweepInfo: ReactNode;
  runClusterLead?: ReactNode;
  runLabel?: string;
  runDisabled?: boolean;
  onRun?: () => void;
}): JSX.Element {
  const {
    lead,
    sweepInfo,
    runClusterLead,
    runLabel,
    runDisabled,
    onRun,
  } = props;

  return (
    <>
      {/* Leftmost slot: the results layout toggle lives here so it reads as a
          panel-level control rather than part of the results view. */}
      {lead}
      {/* Variable sweep info lives in this always-present flex slot, so the
          pinned controls on either side never move when the mode flips or
          axes come and go. */}
      <span className="bt-sweep-foot-info">{sweepInfo}</span>
      <div className="bt-run-cluster">
        {runClusterLead}
        {onRun && (
          <button className="bt-run-btn" onClick={onRun} disabled={runDisabled}>
            {runLabel}
          </button>
        )}
      </div>
    </>
  );
}

export default RunBar;
