// "Warn near TP/SL" row of the order ticket: a muted switch plus the ATR
// multiple the warning fires at. The number keeps a local string draft so it
// can be cleared and retyped; it commits when valid and reverts on blur.
import { useEffect, useState } from "react";
import Tooltip from "./Tooltip";

export const PROXIMITY_MIN = 0.05;
export const PROXIMITY_MAX = 5;

const valid = (n: number) => Number.isFinite(n) && n >= PROXIMITY_MIN && n <= PROXIMITY_MAX;

interface Props {
  label: "Warn near TP" | "Warn near SL";
  on: boolean;
  mult: number;
  disabled: boolean;
  disabledReason?: string;
  onToggle: (on: boolean) => void;
  onMult: (n: number) => void;
}

export default function ProximityWarn({ label, on, mult, disabled, disabledReason, onToggle, onMult }: Props) {
  const [text, setText] = useState(String(mult));
  useEffect(() => setText(String(mult)), [mult]);
  const active = on && !disabled;

  const sw = (
    <span className="ot-prox-sw">
      <button
        type="button"
        className={`ot-switch ot-switch-muted${active ? " on" : ""}`}
        role="switch"
        aria-label={label}
        aria-checked={active}
        disabled={disabled}
        onClick={() => onToggle(!on)}
      >
        <span className="ot-switch-knob" />
      </button>
    </span>
  );

  return (
    <div className={`ot-prox${disabled ? " disabled" : ""}`}>
      <span className="ot-prox-label">{label}</span>
      <div className="ot-prox-controls">
        {active && (
          <>
            <input
              className="ot-atr-len num ot-prox-mult"
              aria-label={`${label} ATR multiple`}
              inputMode="decimal"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && valid(n)) onMult(n);
              }}
              onBlur={() => {
                const n = Number(text);
                if (text.trim() !== "" && valid(n)) onMult(n);
                else setText(String(mult));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLElement).blur();
              }}
            />
            <span className="ot-prox-x">× ATR</span>
          </>
        )}
        {disabled && disabledReason ? <Tooltip content={disabledReason}>{sw}</Tooltip> : sw}
      </div>
    </div>
  );
}
