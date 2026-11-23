// Line alert dialog: price vs one frozen trendline. Create comes from the
// trendline right-click menu; edit from the alerts panel or the chart bell.
// The geometry is fixed once set, so only the condition, evaluation and the
// shared fields are editable.
import { useEffect, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import MoveActionPicker, { type MovePick } from "./components/MoveActionPicker";
import { CONDITIONS } from "./lib/alertUi";
import {
  addLineAlert, addMoveRule, conditionPhrase, deleteIndicatorAlert, deleteMoveRule, findServerAlert, lineAlertLabel,
  loadMoveRules, moveRuleAsAlert, newAlertId, patchLineAlert, patchMoveRule,
  type AlertCondition, type EvalOn, type LineAlert, type MoveRule,
} from "./lib/alertsApi";
import { requestConfirm, type LineAlertRequest } from "./lib/signals";
import { toast } from "./lib/notify";
import type { AlertDefaults } from "./theme";

interface Props {
  request: LineAlertRequest;
  defaults: AlertDefaults;
  now: number;
  onClose: () => void;
}

export default function LineAlertModal({ request, defaults, now, onClose }: Props) {
  const moveRule = request.mode === "edit" ? loadMoveRules().find((r) => r.id === request.id) : undefined;
  const found = request.mode === "edit"
    ? (moveRule ? moveRuleAsAlert(moveRule) : findServerAlert(request.id))
    : undefined;
  const existing = found?.kind === "line" ? found : undefined;
  useEffect(() => {
    if (request.mode === "edit" && !existing) onClose(); // deleted elsewhere
  }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  return <Body {...{ request, existing, moveRule, defaults, now, onClose }} />;
}

function Body({ request, existing, moveRule, defaults, now, onClose }: Props & { existing?: LineAlert; moveRule?: MoveRule }) {
  const isEdit = request.mode === "edit";
  const epic = existing?.epic ?? (request.mode === "create" ? request.draft.epic : "");
  const timeframe = existing?.params.timeframe ?? (request.mode === "create" ? request.draft.timeframe : "");
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "intrabar");
  const [move, setMove] = useState<MovePick | null>(() =>
    moveRule
      ? { field: moveRule.action.field, dealId: moveRule.action.dealId, account: moveRule.action.account, target: moveRule.action.target }
      : request.mode === "create" && request.move
      ? { field: request.move.field, dealId: "", account: "", target: { type: "breakeven", offset: 0 } }
      : null);
  const moving = move != null;
  const label = lineAlertLabel(timeframe);
  const autoMsg = `${epic} ${conditionPhrase(label, condition, "price", "")}`;

  async function save() {
    const typed = common.message.trim();
    const fields = {
      condition, trigger: common.trigger, message: typed === autoMsg ? "" : typed,
      expiresAt: common.expiresAt, notify: common.notify,
    };
    let ok: boolean;
    if (moving) {
      const wire = { evalOn, condition };
      const err = moveRule
        ? await patchMoveRule(moveRule.id, { params: wire, target: move.target, notify: common.notify })
        : await addMoveRule(moveCreate());
      if (err) toast(err);
      ok = err == null;
    } else if (isEdit) {
      ok = await patchLineAlert(existing!.id, { ...fields, params: { evalOn } });
    } else {
      const d = (request as Extract<LineAlertRequest, { mode: "create" }>).draft;
      const { slope, tRef, pRef, t1, p1, t2, p2, log } = d.line;
      ok = await addLineAlert({
        kind: "line", id: newAlertId(), epic: d.epic, broker: d.broker, precision: d.precision,
        createdAt: Date.now(), ...fields,
        params: {
          timeframe: d.timeframe, evalOn, tRef, pRef, slope, ...(log ? { log } : {}),
          anchors: { t1, p1, t2, p2 }, link: d.link,
        },
      });
    }
    if (ok) onClose();
  }

  function moveCreate() {
    const d = (request as Extract<LineAlertRequest, { mode: "create" }>).draft;
    const { slope, tRef, pRef, t1, p1, t2, p2, log } = d.line;
    return {
      triggerKind: "line" as const, epic: d.epic, broker: d.broker, precision: d.precision,
      params: {
        timeframe: d.timeframe, evalOn, condition, tRef, pRef, slope, ...(log ? { log } : {}),
        anchors: { t1, p1, t2, p2 }, link: d.link,
      },
      action: move!, notify: common.notify,
    };
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit alert on " : "Create alert on "}<strong>{epic}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this alert on ${epic}?`,
              onConfirm: () => {
                if (moveRule) void deleteMoveRule(moveRule.id); else deleteIndicatorAlert(existing!.id);
                onClose();
              },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void save()} disabled={moving && !move.dealId}>
            {isEdit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="alert-body">
        <div className="al-field">
          <span>Line</span>
          <strong>{label}</strong>
          <InfoTip title="Line" text={["Fixed where you set it", "Later redraws do not move it"]} />
        </div>
        <div className="al-field">
          <span>Condition</span>
          <div className="al-cond">
            <select className="al-operator" aria-label="Alert condition" value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="al-field" role="radiogroup" aria-label="Evaluate">
          <span>Evaluate</span>
          <label><input type="radio" aria-label="On bar close" checked={evalOn === "close"} onChange={() => setEvalOn("close")} /> On bar close</label>
          <label><input type="radio" aria-label="As it happens" checked={evalOn === "intrabar"} onChange={() => setEvalOn("intrabar")} /> As it happens</label>
          <InfoTip title="Evaluate" text={["On bar close: no repaint", "As it happens: fires on the live candle"]} />
        </div>
        {(!isEdit || moveRule) && (
          <MoveActionPicker epic={epic} value={move} onChange={setMove} precision={existing?.precision
            ?? (request.mode === "create" ? request.draft.precision : undefined)} locked={moveRule != null} />
        )}
        <AlertCommonFields state={common} now={now} autoMsg={autoMsg} moveMode={moving} />
      </div>
    </FloatingModal>
  );
}
