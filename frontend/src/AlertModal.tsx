// TradingView-style "Create alert" modal. The single creation/edit path for price
// alerts — opened from the toolbar bell (prefilled with last price) and the chart
// "+" axis menu (prefilled with the cursor price), both via the alertModalRequest
// signal, and from the sidebar/line for editing via alertEditRequest.

import { useState } from "react";
import FloatingModal from "./components/FloatingModal";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import type { AlertCondition, AlertNotifyChannels, AlertTrigger } from "./lib/persist";
import type { AlertDefaults } from "./theme";
import { CONDITIONS } from "./lib/alertUi";

interface AlertDraft {
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
  // Draw the line from the alert's creation time rather than across the whole
  // pane. On by default — an alert says nothing about the bars that predate it.
  startAtCreation: boolean;
}

interface Props {
  epic: string;
  price: number;
  // "edit" prefills from an existing alert and relabels the modal ("Edit"/"Save").
  mode?: "create" | "edit";
  initial?: {
    condition: AlertCondition;
    trigger: AlertTrigger;
    message: string;
    expiresAt?: number | null;
    notify?: AlertNotifyChannels;
    startAtCreation?: boolean;
  };
  // Defaults a NEW alert inherits (Settings → Alerts). Ignored in edit mode.
  defaults: AlertDefaults;
  // "now" (ms) used to resolve a default DURATION expiry to a concrete timestamp.
  now: number;
  onCreate: (level: number, cfg: AlertDraft) => void;
  // Edit-mode trash button (matches TV). Absent in create mode.
  onDelete?: () => void;
  onClose: () => void;
}

export default function AlertModal({
  epic,
  price,
  mode = "create",
  initial,
  defaults,
  now,
  onCreate,
  onDelete,
  onClose,
}: Props) {
  const isEdit = mode === "edit";
  const [condition, setCondition] = useState<AlertCondition>(
    initial?.condition ?? defaults.condition,
  );
  const [value, setValue] = useState(price ? String(price) : "");
  const common = useAlertCommonState(initial, defaults, now, isEdit);
  const [startAtCreation, setStartAtCreation] = useState(
    initial?.startAtCreation ?? (isEdit ? true : defaults.startAtCreation),
  );
  const num = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(num);
  const condLabel = CONDITIONS.find((c) => c.value === condition)?.label ?? "";
  const autoMsg = `${epic} ${condLabel}${valid ? ` ${num}` : ""}`;

  function create() {
    if (!valid) return;
    onCreate(num, {
      condition,
      trigger: common.trigger,
      message: common.message.trim() || autoMsg,
      expiresAt: common.expiresAt,
      notify: common.notify,
      startAtCreation,
    });
  }

  const foot = (
    <>
      {isEdit && onDelete && (
        <Tooltip content="Delete alert">
        <button className="al-trash" onClick={onDelete} aria-label="Delete alert">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
        </Tooltip>
      )}
      <button className="ghost" onClick={onClose}>
        Cancel
      </button>
      <button className="confirm-primary" onClick={create} disabled={!valid}>
        {isEdit ? "Save" : "Create"}
      </button>
    </>
  );

  return (
    <FloatingModal
      className="alert-modal"
      title={
        <span>
          {isEdit ? "Edit alert on " : "Create alert on "}
          <strong>{epic}</strong>
        </span>
      }
      onClose={onClose}
      footer={foot}
    >
        <div className="alert-body">
          {/* Label on its own line, then source/operator/value share one row below
              it — the label needs room to breathe, not to compete with three
              controls. None of the three is a <label>; each carries its own
              aria-label instead. */}
          <div className="al-field">
            <span>Condition</span>
            <div className="al-cond">
              <select
                className="al-operator"
                aria-label="Alert condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as AlertCondition)}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="al-value"
                type="number"
                step="any"
                aria-label="Alert value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <AlertCommonFields state={common} now={now} autoMsg={autoMsg} />

          {/* Where the line starts. A plain checkbox + sentence (the .notify-toggle
              row Settings uses for the same shape), not a chip — the chip's fill
              read as decoration rather than an on/off state. */}
          <label className="notify-toggle">
            <input
              type="checkbox"
              checked={startAtCreation}
              onChange={(e) => setStartAtCreation(e.target.checked)}
            />
            Start line at creation time
            <InfoTip
              title="Start line at creation time"
              text={[
                "Draw the alert line from the bar it was created on instead of across the whole chart.",
                "Off: the line spans every bar, including the ones the alert never watched.",
              ]}
            />
          </label>
        </div>
    </FloatingModal>
  );
}
