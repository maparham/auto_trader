// Indicator alert dialog: the target section (what is compared, when) on top
// of the shared alert fields. Create comes from an indicator; edit from the
// alerts panel.
import { useEffect, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import { CONDITIONS } from "./lib/alertUi";
import { indicatorAlertLabel, volumeWeighted } from "./lib/alertableIndicators";
import {
  addIndicatorAlert, conditionPhrase, deleteIndicatorAlert, fmtIndicatorValue,
  loadAllIndicatorAlerts, patchIndicatorAlert,
  type AlertCondition, type AlertTarget, type EvalOn, type IndicatorAlert,
} from "./lib/alertsApi";
import { requestConfirm, type IndicatorAlertRequest } from "./lib/signals";
import { supportsStreaming } from "./lib/trading";
import type { AlertDefaults } from "./theme";

interface Props {
  request: IndicatorAlertRequest;
  defaults: AlertDefaults;
  now: number;
  onClose: () => void;
}

const newId = () => `al-${crypto.randomUUID()}`;

export default function IndicatorAlertModal({ request, defaults, now, onClose }: Props) {
  const existing = request.mode === "edit" ? findAlert(request.id) : undefined;
  useEffect(() => {
    if (request.mode === "edit" && !existing) onClose(); // deleted elsewhere
  }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  const isEdit = request.mode === "edit";
  const base = isEdit
    ? {
        epic: existing!.epic, broker: existing!.broker, precision: existing!.precision,
        identity: existing!.params.identity, timeframe: existing!.params.timeframe,
        link: existing!.params.link, lastValue: existing!.params.value,
        quoteOnly: !supportsStreaming(existing!.broker),
      }
    : request.draft;
  return <Body {...{ base, existing, isEdit, defaults, now, onClose }} />;
}

function findAlert(id: string): IndicatorAlert | undefined {
  return loadAllIndicatorAlerts().find((a) => a.id === id);
}

function Body({ base, existing, isEdit, defaults, now, onClose }: {
  base: {
    epic: string; broker: string; precision: number; identity: IndicatorAlert["params"]["identity"];
    timeframe: string; link: IndicatorAlert["params"]["link"]; lastValue: number | null; quoteOnly: boolean;
  };
  existing?: IndicatorAlert; isEdit: boolean; defaults: AlertDefaults; now: number; onClose: () => void;
}) {
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [target, setTarget] = useState<AlertTarget>(
    existing?.params.target ?? (base.identity.priceTarget ? "price" : "value"),
  );
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [value, setValue] = useState(
    existing?.params.value != null ? String(existing.params.value)
      : base.lastValue != null ? fmtIndicatorValue(base.lastValue) : "",
  );
  const intrabarBlocked = volumeWeighted(base.identity) && base.quoteOnly;
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "close");
  const label = indicatorAlertLabel(base.identity, base.timeframe);
  const num = Number(value);
  const valid = target === "price" || (value.trim() !== "" && Number.isFinite(num));
  // Reuse the same phrasing alertsApi.alertLabel uses for the saved alert's
  // panel row, so the default message matches what the user will see there.
  const levelText = target === "value" && valid ? fmtIndicatorValue(num) : "";
  const autoMsg = `${base.epic} ${conditionPhrase(label, condition, target, levelText)}`;

  async function save() {
    if (!valid) return;
    const params = {
      identity: base.identity, line: "value" as const, timeframe: base.timeframe, target,
      value: target === "value" ? num : null, evalOn, link: base.link,
    };
    // Only a message the user actually wrote is stored. The default text
    // names the indicator's CURRENT settings and value, which a later
    // settings sync or a chart drag changes: left empty, every surface
    // recomputes it fresh instead of showing the text baked in at save time.
    const typed = common.message.trim();
    const fields = {
      condition, trigger: common.trigger, message: typed === autoMsg ? "" : typed,
      expiresAt: common.expiresAt, notify: common.notify,
    };
    const ok = isEdit
      ? await patchIndicatorAlert(existing!.id, { ...fields, params })
      : await addIndicatorAlert({
          kind: "indicator", id: newId(), epic: base.epic, broker: base.broker,
          precision: base.precision, createdAt: Date.now(), params, ...fields,
        });
    if (ok) onClose();
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit alert on " : "Create alert on "}<strong>{base.epic}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this alert on ${base.epic}?`,
              onConfirm: () => { deleteIndicatorAlert(existing!.id); onClose(); },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void save()} disabled={!valid}>
            {isEdit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="alert-body">
        <div className="al-field">
          <span>Indicator</span>
          <strong>{label}</strong>
        </div>
        {base.identity.priceTarget && (
          <div className="al-field" role="radiogroup" aria-label="Compare">
            <label><input type="radio" aria-label="Price vs line" checked={target === "price"} onChange={() => setTarget("price")} /> Price vs line</label>
            <label><input type="radio" aria-label="Value vs number" checked={target === "value"} onChange={() => setTarget("value")} /> Value vs number</label>
          </div>
        )}
        <div className="al-field">
          <span>Condition</span>
          <div className="al-cond">
            <select className="al-operator" aria-label="Alert condition" value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {target === "value" && (
              <input className="al-value" type="number" step="any" aria-label="Alert value"
                value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            )}
          </div>
        </div>
        <div className="al-field" role="radiogroup" aria-label="Evaluate">
          <span>Evaluate</span>
          <label><input type="radio" aria-label="On bar close" checked={evalOn === "close"} onChange={() => setEvalOn("close")} /> On bar close</label>
          <label><input type="radio" aria-label="As it happens" disabled={intrabarBlocked}
            checked={evalOn === "intrabar"} onChange={() => setEvalOn("intrabar")} /> As it happens</label>
          <InfoTip title="Evaluate" text={
            intrabarBlocked
              ? ["This broker sends quotes only", "Volume-weighted lines need a closed bar"]
              : ["On bar close: no repaint", "As it happens: fires on the live candle"]
          } />
        </div>
        <AlertCommonFields state={common} now={now} autoMsg={autoMsg} />
      </div>
    </FloatingModal>
  );
}
