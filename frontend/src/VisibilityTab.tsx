// Shared TradingView-style Visibility tab body for both drawings (DrawingSettings) and
// indicators (IndicatorSettings). Renders one row per supported time unit — an enable
// checkbox, a min number input, a dual range slider, and a max number input — plus an
// optional auto-hide row (finite-extent objects only). Pure/controlled: it never mutates
// the model in place; every edit produces a fresh model via onChange.

import { useMemo } from "react";
import {
  type VisibilityModel,
  type VisUnit,
  type VisPreset,
  VISIBILITY_UNITS,
  applyPreset,
  detectPreset,
} from "./lib/visibility";
import { PERIOD_GROUPS } from "./lib/feed";

interface Props {
  model: VisibilityModel;
  onChange: (next: VisibilityModel) => void;
  showAutoHide: boolean;
  currentResolution: string;
}

const RESOLUTION_LABEL: Record<string, string> = Object.fromEntries(
  PERIOD_GROUPS.flatMap((g) => g.periods.map((p) => [p.resolution, p.label])),
);

function presetLabels(currentResolution: string): { value: VisPreset; label: string }[] {
  const tf = RESOLUTION_LABEL[currentResolution] ?? currentResolution;
  return [
    { value: "all", label: "All intervals" },
    { value: "finer", label: `${tf} & lower` },
    { value: "coarser", label: `${tf} & higher` },
    { value: "only", label: `Only ${tf}` },
    { value: "custom", label: "Custom" },
  ];
}

// Shallow-clone the model so callers always get a new object (React state churn).
function clone(m: VisibilityModel): VisibilityModel {
  const units = {} as VisibilityModel["units"];
  for (const u of VISIBILITY_UNITS) units[u.unit] = { ...m.units[u.unit] };
  return { units, autoHide: { ...m.autoHide } };
}

export default function VisibilityTab({ model, onChange, showAutoHide, currentResolution }: Props) {
  const rows = useMemo(() => VISIBILITY_UNITS, []);
  const preset = detectPreset(model, currentResolution);
  const presetOptions = useMemo(() => presetLabels(currentResolution), [currentResolution]);

  function choosePreset(p: VisPreset) {
    if (p === "custom") return; // "Custom" is a display-only state, not a setter
    onChange(applyPreset(model, currentResolution, p));
  }

  function patchUnit(unit: VisUnit, patch: Partial<VisibilityModel["units"][VisUnit]>) {
    const next = clone(model);
    const cur = next.units[unit];
    const { on } = { ...cur, ...patch };
    let { min, max } = { ...cur, ...patch };
    const bound = rows.find((r) => r.unit === unit)!.max;
    // An in-progress numeric edit (e.g. the input momentarily reads "-") parses to
    // NaN; Math.max/min propagate NaN silently, so guard back to the pre-edit value
    // rather than committing NaN into the model (which would permanently hide this
    // unit at every resolution until manually re-entered).
    if (!Number.isFinite(min)) min = cur.min;
    if (!Number.isFinite(max)) max = cur.max;
    min = Math.max(1, Math.min(min, bound));
    max = Math.max(1, Math.min(max, bound));
    if (min > max) {
      // Keep the just-edited side authoritative.
      if (patch.min != null) max = min;
      else min = max;
    }
    next.units[unit] = { on, min, max };
    onChange(next);
  }

  function patchAutoHide(patch: Partial<VisibilityModel["autoHide"]>) {
    const next = clone(model);
    next.autoHide = { ...next.autoHide, ...patch };
    if (next.autoHide.minBars < 1) next.autoHide.minBars = 1;
    onChange(next);
  }

  return (
    <div className="vis-tab">
      <div className="ind-row vis-preset-row">
        <label htmlFor="vis-preset">Visible on</label>
        <select
          id="vis-preset"
          aria-label="Visible on"
          value={preset}
          onChange={(e) => choosePreset(e.target.value as VisPreset)}
        >
          {presetOptions.filter((o) => o.value !== "custom" || preset === "custom").map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="vis-col-heads" aria-hidden="true">
        <span />
        <span>Min</span>
        <span />
        <span>Max</span>
      </div>
      <div className="vis-grid">
        {rows.map((r) => {
          const u = model.units[r.unit];
          return (
            <div className={`vis-row${u.on ? "" : " is-off"}`} key={r.unit}>
              <label className="ind-check vis-unit">
                <input
                  type="checkbox"
                  checked={u.on}
                  aria-label={r.label}
                  onChange={(e) => patchUnit(r.unit, { on: e.target.checked })}
                />
                <span>{r.label}</span>
              </label>
              <input
                className="vis-num"
                type="number"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} min`}
                value={u.min}
                onChange={(e) => patchUnit(r.unit, { min: Number(e.target.value) })}
              />
              <input
                className="vis-slider"
                type="range"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} max slider`}
                value={u.max}
                onChange={(e) => patchUnit(r.unit, { max: Number(e.target.value) })}
              />
              <input
                className="vis-num"
                type="number"
                min={1}
                max={r.max}
                disabled={!u.on}
                aria-label={`${r.label} max`}
                value={u.max}
                onChange={(e) => patchUnit(r.unit, { max: Number(e.target.value) })}
              />
            </div>
          );
        })}
      </div>

      {showAutoHide && (
        <label className="ind-check vis-autohide">
          <input
            type="checkbox"
            checked={model.autoHide.on}
            aria-label="Auto-hide when too small"
            onChange={(e) => patchAutoHide({ on: e.target.checked })}
          />
          <span>Auto-hide when fewer than</span>
          <input
            className="vis-num"
            type="number"
            min={1}
            disabled={!model.autoHide.on}
            aria-label="Minimum visible bars"
            value={model.autoHide.minBars}
            onChange={(e) => patchAutoHide({ minBars: Number(e.target.value) })}
          />
          <span>visible bars</span>
        </label>
      )}
    </div>
  );
}
