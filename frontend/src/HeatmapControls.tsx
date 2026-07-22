// Chart furniture for the rule-proximity heatmap: an on/off toggle plus, when
// on, a compact control panel (side, scale basis, sensitivity, higher-timeframe
// aggregation). Presentational only — all state lives in useProximityHeatmap;
// this renders the current view and reports changes up.
import InfoTip from "./components/InfoTip";
import type { HeatmapView } from "./lib/heatmapController";

interface Props {
  on: boolean;
  onToggle: (on: boolean) => void;
  view: HeatmapView;
  onChange: (patch: Partial<HeatmapView>) => void;
  // True when the chart resolution sits below the locked base timeframe, so the
  // heatmap paints nothing. The panel says so rather than looking broken.
  belowBase: boolean;
}

export default function HeatmapControls({ on, onToggle, view, onChange, belowBase }: Props) {
  return (
    <div className="heatmap-ctl">
      <button
        className={`heatmap-toggle${on ? " seg-on" : ""}`}
        onClick={() => onToggle(!on)}
        title="Rule proximity heatmap"
      >
        Heatmap
      </button>

      {on && (
        <div className="heatmap-panel">
          <div className="wfo-row">
            <span className="wfo-label">Side</span>
            <div className="seg heatmap-seg">
              <button
                className={view.side === "long" ? "seg-on" : ""}
                onClick={() => onChange({ side: "long" })}
              >
                Long
              </button>
              <button
                className={view.side === "short" ? "seg-on" : ""}
                onClick={() => onChange({ side: "short" })}
              >
                Short
              </button>
            </div>
          </div>

          <div className="wfo-row">
            <span className="wfo-label">
              Scale
              <InfoTip
                title="Scale"
                text={[
                  "Volatility: each condition is measured against its usual distance from its trigger.",
                  "ATR: each condition is measured in ATR units.",
                ]}
              />
            </span>
            <div className="seg heatmap-seg">
              <button
                className={view.basis === "volatility" ? "seg-on" : ""}
                onClick={() => onChange({ basis: "volatility" })}
              >
                Volatility
              </button>
              <button
                className={view.basis === "atr" ? "seg-on" : ""}
                onClick={() => onChange({ basis: "atr" })}
              >
                ATR
              </button>
            </div>
          </div>

          <div className="wfo-row">
            <span className="wfo-label">
              Sensitivity
              <InfoTip
                title="Sensitivity"
                text="Higher values light up the chart from further away."
              />
            </span>
            <input
              className="heatmap-width"
              type="number"
              min={0.5}
              step={0.5}
              value={view.width}
              onChange={(e) => {
                const w = Number(e.target.value);
                if (Number.isFinite(w) && w > 0) onChange({ width: w });
              }}
            />
          </div>

          <div className="wfo-row">
            <span className="wfo-label">
              On higher timeframes
              <InfoTip
                title="On higher timeframes"
                text="Combines the base bars inside each higher-timeframe bar."
              />
            </span>
            <div className="seg heatmap-seg">
              <button
                className={view.agg === "max" ? "seg-on" : ""}
                onClick={() => onChange({ agg: "max" })}
              >
                Max
              </button>
              <button
                className={view.agg === "avg" ? "seg-on" : ""}
                onClick={() => onChange({ agg: "avg" })}
              >
                Average
              </button>
              <button
                className={view.agg === "last" ? "seg-on" : ""}
                onClick={() => onChange({ agg: "last" })}
              >
                Last close
              </button>
            </div>
          </div>

          <div className="heatmap-base">
            {belowBase
              ? `Hidden below the base timeframe (${view.baseResolution}).`
              : `Base ${view.baseResolution}`}
          </div>
        </div>
      )}
    </div>
  );
}
