// Indicator alert dialog: the target section (what is compared, when) on top
// of the shared alert fields. Create comes from an indicator; edit from the
// alerts panel. The pane's outputs, labels and refusal all come from the
// server's describe call (POST /api/alerts/describe) - this file renders
// what it returns, it decides none of it itself.
import { useEffect, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import { CONDITIONS } from "./lib/alertUi";
import {
  addIndicatorAlert, conditionPhrase, deleteIndicatorAlert, describeIndicatorAlert, fmtIndicatorValue,
  loadAllIndicatorAlerts, patchIndicatorAlert,
  type AlertCondition, type AlertDescription, type AlertTarget, type EvalOn, type IndicatorAlert,
} from "./lib/alertsApi";
import type { AlertInstance } from "./lib/indicatorAlertInstance";
import { requestConfirm, type IndicatorAlertRequest } from "./lib/signals";
import { tfLabel } from "./lib/timeframe";
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
        timeframe: existing!.params.timeframe, link: existing!.params.link,
        quoteOnly: !supportsStreaming(existing!.broker), alertId: existing!.id, instance: undefined,
      }
    : { ...request.draft, timeframe: request.draft.chartTimeframe, alertId: undefined };
  return <Body {...{ base, existing, isEdit, defaults, now, onClose }} />;
}

function findAlert(id: string): IndicatorAlert | undefined {
  return loadAllIndicatorAlerts().find((a) => a.id === id);
}

function Body({ base, existing, isEdit, defaults, now, onClose }: {
  base: {
    epic: string; broker: string; precision: number; timeframe: string;
    link: IndicatorAlert["params"]["link"]; quoteOnly: boolean;
    instance: AlertInstance | undefined; alertId: string | undefined;
  };
  existing?: IndicatorAlert; isEdit: boolean; defaults: AlertDefaults; now: number; onClose: () => void;
}) {
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [desc, setDesc] = useState<AlertDescription | null>(null);
  const [output, setOutput] = useState<string | null>(existing?.params.output ?? null);
  const [target, setTarget] = useState<AlertTarget | null>(existing?.params.target ?? null);
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [value, setValue] = useState(existing?.params.value != null ? String(existing.params.value) : "");
  const [typed, setTyped] = useState(existing != null);
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "close");

  useEffect(() => {
    let live = true;
    void describeIndicatorAlert({
      broker: base.broker, epic: base.epic, timeframe: base.timeframe,
      ...(base.alertId ? { alertId: base.alertId } : { instance: base.instance }),
    }).then((d) => { if (live) setDesc(d); });
    return () => { live = false; };
  }, [base.broker, base.epic, base.timeframe, base.alertId, base.instance]);

  const out = desc?.outputs.find((o) => o.name === output) ?? desc?.outputs[0] ?? null;
  const event = out?.kind === "event";
  const tgt: AlertTarget = event ? "value" : out?.priceOnly ? "price" : target ?? (out?.priceScale ? "price" : "value");
  useEffect(() => {
    // Prefill from the server's value for this output until the user types.
    if (!out || typed || tgt !== "value" || event) return;
    const v = desc?.lastValues[out.name];
    setValue(v != null ? fmtIndicatorValue(v) : "");
  }, [desc, out, typed, tgt, event]);

  const intrabarBlocked = event || (desc?.needsVolume === true && base.quoteOnly);
  useEffect(() => {
    // A stored intrabar choice the described pane can't honor falls back.
    if (intrabarBlocked && evalOn === "intrabar") setEvalOn("close");
  }, [intrabarBlocked, evalOn]);
  const label = out ? `${out.label} (${tfLabel(desc!.timeframe)})` : "";
  const num = Number(value);
  const valid = desc != null && desc.refusal == null && out != null
    && (event || tgt === "price" || (value.trim() !== "" && Number.isFinite(num)));
  const levelText = tgt === "value" && !event && valid ? fmtIndicatorValue(num) : "";
  const autoMsg = `${base.epic} ${event ? `${label} happens` : conditionPhrase(label, condition, tgt, levelText)}`;

  async function save() {
    if (!valid || !out || !desc) return;
    const params = {
      output: out.name, timeframe: desc.timeframe, target: tgt,
      value: event ? 0.5 : tgt === "value" ? num : null,
      evalOn: event ? ("close" as const) : evalOn, link: base.link,
    };
    // Only a message the user actually wrote is stored. The default text
    // names the indicator's CURRENT settings and value, which a later
    // settings sync or a chart drag changes: left empty, every surface
    // recomputes it fresh instead of showing the text baked in at save time.
    const msg = common.message.trim();
    const fields = {
      condition: event ? ("crossing_up" as const) : condition, trigger: common.trigger,
      message: msg === autoMsg ? "" : msg, expiresAt: common.expiresAt, notify: common.notify,
    };
    const ok = isEdit
      ? await patchIndicatorAlert(existing!.id, { ...fields, params })
      : await addIndicatorAlert({
          kind: "indicator", id: newId(), epic: base.epic, broker: base.broker, precision: base.precision,
          createdAt: Date.now(), label,
          params: { ...params, type: desc.type, config: {}, instance: base.instance }, ...fields,
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
          <strong>{label || "..."}</strong>
        </div>
        {desc?.refusal && (
          <div className="al-field">
            <span />
            <span className="al-note">{desc.refusal}</span>
          </div>
        )}
        {desc && desc.outputs.length > 1 && (
          <div className="al-field">
            <span>Line</span>
            <select className="al-operator" aria-label="Line" value={out?.name}
              onChange={(e) => {
                setOutput(e.target.value); setTarget(null); setTyped(false);
                if (desc.outputs.find((o) => o.name === e.target.value)?.kind === "event") setEvalOn("close");
              }}>
              {desc.outputs.map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}
            </select>
          </div>
        )}
        {out?.priceOnly && (
          <div className="al-field">
            <span>History</span>
            <span>Uses the last 2000 bars</span>
          </div>
        )}
        {out && (
          <div className="al-field">
            <span>Condition</span>
            <div className="al-cond al-sentence">
              {event ? (
                <>
                  <span className="al-subject">{out.label}</span>
                  <span className="al-subject">happens</span>
                </>
              ) : (
                <>
                  {out.priceScale && !out.priceOnly ? (
                    <select className="al-operator" aria-label="Compare" value={tgt}
                      onChange={(e) => setTarget(e.target.value as AlertTarget)}>
                      <option value="price">Price</option>
                      <option value="value">Indicator</option>
                    </select>
                  ) : (
                    <span className="al-subject">{out.priceOnly ? "Price" : "Indicator"}</span>
                  )}
                  <select className="al-operator" aria-label="Alert condition" value={condition}
                    onChange={(e) => setCondition(e.target.value as AlertCondition)}>
                    {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {tgt === "value" ? (
                    <input className="al-value" type="number" step="any" aria-label="Alert value"
                      value={value} onChange={(e) => { setValue(e.target.value); setTyped(true); }} autoFocus />
                  ) : (
                    <span className="al-subject">the curve</span>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <div className="al-field" role="radiogroup" aria-label="Evaluate">
          <span>Evaluate</span>
          <label><input type="radio" aria-label="On bar close" checked={evalOn === "close"} onChange={() => setEvalOn("close")} /> On bar close</label>
          <label><input type="radio" aria-label="As it happens" disabled={intrabarBlocked}
            checked={evalOn === "intrabar"} onChange={() => setEvalOn("intrabar")} /> As it happens</label>
          <InfoTip title="Evaluate" text={
            event
              ? ["Events fire on a closed bar"]
              : intrabarBlocked
              ? ["This broker sends quotes only", "Volume-weighted lines need a closed bar"]
              : ["On bar close: no repaint", "As it happens: fires on the live candle"]
          } />
        </div>
        <AlertCommonFields state={common} now={now} autoMsg={autoMsg} />
      </div>
    </FloatingModal>
  );
}
