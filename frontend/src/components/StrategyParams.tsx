// Panel controls for a coded strategy's declared meta["params"] knobs.
// One row per spec: NumberField (int/float, clamped + stepped), the app's
// switch idiom (bool, matches OrderTicket's ExitRow), or a select (choice),
// with the default shown subtly and changed values tinted.

import { Fragment } from "react";

import type { ParamSpec, ParamValues } from "../api";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import InfoTip from "./InfoTip";
import NumberField from "./NumberField";
import { SweepAxisRow } from "./SweepAxisRow";
import Tooltip from "./Tooltip";

interface Props {
  specs: ParamSpec[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  // Undefined = no sweep toggles shown (Live panel).
  sweep?: {
    axes: SweepAxis[];
    onToggle: (target: string, spec: ParamSpec) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}

export function StrategyParams({ specs, values, onChange, sweep }: Props) {
  if (!specs.length) return null;

  const set = (name: string, v: number | boolean | string) =>
    onChange({ ...values, [name]: v });
  const defaults = Object.fromEntries(specs.map((s) => [s.name, s.default])) as ParamValues;
  const anyChanged = specs.some((s) => values[s.name] !== s.default);

  return (
    <div className="strategy-params">
      <div className="sp-head">
        <span className="sp-title">Parameters</span>
        {anyChanged && (
          <button type="button" className="sp-reset" onClick={() => onChange(defaults)}>
            Reset all
          </button>
        )}
      </div>
      {specs.map((s) => {
        const v = values[s.name] ?? s.default;
        const changed = v !== s.default;
        const axis = sweep?.axes.find(
          (a): a is RangeAxis => a.kind === "range" && a.target === `param:${s.name}`);
        const swept = !!axis;

        return (
          <Fragment key={s.name}>
            <div className={`sp-row${changed ? " sp-changed" : ""}`}>
            <span className="sp-label">
              {s.label}
              {s.help && <InfoTip text={s.help} />}
            </span>
            {s.type === "bool" ? (
              <button
                type="button"
                className={`sp-switch${v ? " on" : ""}`}
                role="switch"
                aria-checked={v as boolean}
                onClick={() => set(s.name, !(v as boolean))}
              >
                <span className="sp-switch-knob" />
              </button>
            ) : s.type === "choice" ? (
              <select value={v as string} onChange={(e) => set(s.name, e.target.value)}>
                {(s.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              // Stays visible while swept (disabled: the sweep axis owns the
              // value), matching the rule-operand and risk fields.
              <NumberField
                value={v as number}
                step={s.step ?? undefined}
                onChange={(n) => set(s.name, clamp(s, n))}
                className="sp-num"
                disabled={swept}
              />
            )}
            {(s.type === "int" || s.type === "float") && sweep && (
              <Tooltip content="Sweep this parameter">
                <button
                  type="button"
                  className={`sp-sweep${swept ? " on" : ""}`}
                  onClick={() => sweep.onToggle(`param:${s.name}`, s)}
                >
                  ⇄
                </button>
              </Tooltip>
            )}
            <span className="sp-default">default {String(s.default)}</span>
            </div>
            {axis && sweep && (
              <SweepAxisRow axis={axis} onChange={(p) => sweep.onAxisChange(axis.target, p)} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function clamp(s: ParamSpec, n: number): number {
  let v = s.type === "int" ? Math.round(n) : n;
  if (s.min !== null) v = Math.max(s.min, v);
  if (s.max !== null) v = Math.min(s.max, v);
  return v;
}
