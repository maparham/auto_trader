// "Move SL" / "Move TP" rows of the order ticket: a muted switch, then (when on)
// what to move to, the condition and the trigger price. Controlled: the ticket
// keeps the draft in moveDraftSignal. A saved rule (edit mode) adds Save / Remove.
import InfoTip from "./InfoTip";
import NumberField from "./NumberField";
import Tooltip from "./Tooltip";
import { CONDITION_LABELS, type AlertCondition, type MoveRule } from "../lib/alertsApi";
import type { MoveRuleDraft } from "../lib/moveRuleDraft";

const TIP = [
  "Moves the level once, when price meets the condition.",
  "Only tightens. Never loosens your SL or TP.",
];

const OTHER_KIND_TIP = ["Set by an indicator or line alert.", "Use Edit or Remove rule."];

interface Props {
  field: "sl" | "tp";
  draft: MoveRuleDraft | null;
  precision: number;
  onChange: (d: MoveRuleDraft | null) => void;
  /** The switch. Turning on needs the ticket to seed the draft, so it owns this. */
  onToggle: (on: boolean) => void;
  saved?: MoveRule;
  onSave?: () => void;
  onRemove?: () => void;
  /** Open the indicator / line modal for a saved rule that is not a price rule. */
  onEdit?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
}

export default function MoveRuleControl({
  field, draft, precision, onChange, onToggle, saved, onSave, onRemove, onEdit, disabled = false, disabledReason, busy = false,
}: Props) {
  const label = field === "sl" ? "Move SL" : "Move TP";
  const otherKind = saved != null && saved.triggerKind !== "price_level";
  const active = (draft?.on ?? false) && !disabled;
  const step = 10 ** -precision;

  const sw = (
    <span className="ot-prox-sw">
      <button
        type="button"
        className={`ot-switch ot-switch-muted${active || otherKind ? " on" : ""}`}
        role="switch"
        aria-label={label}
        aria-checked={active || otherKind}
        disabled={disabled || otherKind}
        onClick={() => onToggle(!(active || otherKind))}
      >
        <span className="ot-switch-knob" />
      </button>
    </span>
  );
  return (
    <div className={`ot-move${disabled ? " disabled" : ""}`}>
      <div className="ot-prox">
        <span className="ot-prox-label">
          {label} <InfoTip title={label} text={TIP} />
        </span>
        <div className="ot-prox-controls">
          {disabled && disabledReason ? <Tooltip content={disabledReason}>{sw}</Tooltip>
            : otherKind ? <Tooltip content={OTHER_KIND_TIP}>{sw}</Tooltip> : sw}
        </div>
      </div>
      {otherKind && saved && (
        <div className="ot-move-row">
          <span className="ot-move-saved">{saved.label ?? (saved.triggerKind === "line" ? "Line rule" : "Indicator rule")}</span>
          <button type="button" className="ot-move-btn" disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" className="ot-move-btn" disabled={busy} onClick={onRemove}>Remove rule</button>
        </div>
      )}
      {active && draft && !otherKind && (
        <div className="ot-move-body">
          <div className="ot-move-row">
            <select
              className="ot-input ot-move-sel"
              aria-label={`${label} target`}
              value={draft.target.type}
              onChange={(e) =>
                onChange({
                  ...draft,
                  target: e.target.value === "price"
                    ? { type: "price", value: Number(draft.level.toFixed(precision)) }
                    : { type: "breakeven", offset: 0 },
                })}
            >
              <option value="breakeven">Breakeven</option>
              <option value="price">Price</option>
            </select>
            {draft.target.type === "breakeven" ? (
              <span className="ot-move-field">
                <span className="ot-flabel">Offset</span>
                <NumberField
                  className="ot-input num"
                  ariaLabel={`${label} offset`}
                  value={draft.target.offset}
                  step={step}
                  onChange={(n) => onChange({ ...draft, target: { type: "breakeven", offset: Math.max(0, n) } })}
                />
              </span>
            ) : (
              <NumberField
                className="ot-input num"
                ariaLabel={`${label} price`}
                value={draft.target.value}
                step={step}
                onChange={(n) => onChange({ ...draft, target: { type: "price", value: n } })}
              />
            )}
          </div>
          <div className="ot-move-row">
            <select
              className="ot-input ot-move-sel"
              aria-label={`${label} condition`}
              value={draft.condition}
              onChange={(e) => onChange({ ...draft, condition: e.target.value as AlertCondition })}
            >
              {(Object.keys(CONDITION_LABELS) as AlertCondition[]).map((c) => (
                <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
              ))}
            </select>
            <NumberField
              className="ot-input num"
              ariaLabel={`${label} trigger price`}
              value={draft.level}
              step={step}
              onChange={(n) => onChange({ ...draft, level: n })}
            />
          </div>
          {(onSave || saved) && (
            <div className="ot-move-row">
              {onSave && <button type="button" className="ot-move-btn" disabled={busy} onClick={onSave}>Save rule</button>}
              {saved && <button type="button" className="ot-move-btn" disabled={busy} onClick={onRemove}>Remove rule</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
