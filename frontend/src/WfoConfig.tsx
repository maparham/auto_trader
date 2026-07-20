// Walk-forward schedule config: the train/test/objective controls the modal
// renders in walk-forward mode. Pure/controlled — it owns no state, only maps
// clicks onto the WfoConfigState the modal persists. Combo math + dropped-axis
// notes are computed upstream (buildWalkForwardPayload) and passed in.

import type { JSX } from "react";
import InfoTip from "./components/InfoTip";
import { TRAIN_SPAN_PICKS, type WfoConfigState } from "./lib/wfo";

const TEST_SPAN_PICKS = ["1w", "2w", "1m"] as const;
const STEP_PICKS: Array<{ value: string | null; label: string }> = [
  { value: null, label: "= test" },
  { value: "1w", label: "1w" },
  { value: "2w", label: "2w" },
];
const METRIC_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "sharpe", label: "Sharpe" },
  { value: "sqn", label: "SQN" },
  { value: "net_pnl", label: "Net P&L" },
  { value: "return_pct", label: "Return %" },
  { value: "profit_factor", label: "Profit factor" },
];

export function WfoConfig(props: {
  cfg: WfoConfigState;
  onChange: (next: WfoConfigState) => void;
  comboTotal: number; // from buildWalkForwardPayload (0 when invalid)
  droppedAxes: string[]; // labels of period/timeWindow axes excluded in WFO mode
}): JSX.Element {
  const { cfg, onChange, comboTotal, droppedAxes } = props;

  // Train chips are multi-select: the first stays primary, extras become matrix
  // schemes. Removing the only remaining span is blocked (a run needs one).
  const toggleTrain = (span: string) => {
    const on = cfg.trainSpans.includes(span);
    if (on) {
      if (cfg.trainSpans.length === 1) return; // never empty the set
      onChange({ ...cfg, trainSpans: cfg.trainSpans.filter((s) => s !== span) });
    } else {
      // Keep TRAIN_SPAN_PICKS order so "primary" reads left-to-right.
      const next = TRAIN_SPAN_PICKS.filter((s) => s === span || cfg.trainSpans.includes(s));
      onChange({ ...cfg, trainSpans: [...next] });
    }
  };

  const schemes = cfg.trainSpans.length;

  return (
    <div className="wfo-config">
      <div className="wfo-row">
        <span className="wfo-label">
          Train
          <InfoTip
            title="Training window"
            text={[
              "How much history each fold optimizes on.",
              "Select several lengths to compare them in one run (matrix).",
            ]}
          />
        </span>
        <span className="seg wfo-seg">
          {TRAIN_SPAN_PICKS.map((span) => (
            <button
              key={span}
              type="button"
              className={cfg.trainSpans.includes(span) ? "seg-on" : ""}
              aria-pressed={cfg.trainSpans.includes(span)}
              onClick={() => toggleTrain(span)}
            >
              {span}
            </button>
          ))}
        </span>
      </div>

      <div className="wfo-row">
        <span className="wfo-label">Test</span>
        <span className="seg wfo-seg">
          {TEST_SPAN_PICKS.map((span) => (
            <button
              key={span}
              type="button"
              className={cfg.testSpan === span ? "seg-on" : ""}
              aria-pressed={cfg.testSpan === span}
              onClick={() => onChange({ ...cfg, testSpan: span })}
            >
              {span}
            </button>
          ))}
        </span>
        <span className="seg wfo-seg">
          <button
            type="button"
            className={cfg.mode === "rolling" ? "seg-on" : ""}
            aria-pressed={cfg.mode === "rolling"}
            onClick={() => onChange({ ...cfg, mode: "rolling" })}
          >
            Rolling
          </button>
          <button
            type="button"
            className={cfg.mode === "anchored" ? "seg-on" : ""}
            aria-pressed={cfg.mode === "anchored"}
            onClick={() => onChange({ ...cfg, mode: "anchored" })}
          >
            Anchored
          </button>
        </span>
        <InfoTip text="Rolling slides a fixed train window; anchored grows it from the range start." />
      </div>

      <div className="wfo-row">
        <span className="wfo-label">Objective</span>
        <select
          className="wfo-select"
          aria-label="Objective metric"
          value={cfg.metric}
          onChange={(e) => onChange({ ...cfg, metric: e.currentTarget.value })}
        >
          {METRIC_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="seg wfo-seg">
          <button
            type="button"
            className={cfg.selection === "best" ? "seg-on" : ""}
            aria-pressed={cfg.selection === "best"}
            onClick={() => onChange({ ...cfg, selection: "best" })}
          >
            Best
          </button>
          <button
            type="button"
            className={cfg.selection === "plateau" ? "seg-on" : ""}
            aria-pressed={cfg.selection === "plateau"}
            onClick={() => onChange({ ...cfg, selection: "plateau" })}
          >
            Plateau
          </button>
        </span>
        <InfoTip text="Plateau picks the cell whose neighborhood is good, not the luckiest single cell." />
      </div>

      <details className="wfo-advanced">
        <summary>Advanced</summary>
        <div className="wfo-row">
          <span className="wfo-label">Step</span>
          <span className="seg wfo-seg">
            {STEP_PICKS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={cfg.step === s.value ? "seg-on" : ""}
                aria-pressed={cfg.step === s.value}
                onClick={() => onChange({ ...cfg, step: s.value })}
              >
                {s.label}
              </button>
            ))}
          </span>
        </div>
      </details>

      <div className="wfo-foot">
        {comboTotal} {comboTotal === 1 ? "combo" : "combos"} x {schemes}{" "}
        {schemes === 1 ? "scheme" : "schemes"}
      </div>
      {droppedAxes.length > 0 && (
        <div className="wfo-note">
          Period and session axes are ignored in walk-forward: {droppedAxes.join(", ")}
        </div>
      )}
    </div>
  );
}
