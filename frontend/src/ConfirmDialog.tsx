// Generic "are you sure?" modal, driven by the confirmRequest signal. Kept minimal
// and reusable: a title, a message, and Cancel / confirm buttons. The confirm button
// is styled destructive (it's currently only used for deletes). Esc and a backdrop
// click cancel; the confirm button autofocuses so Enter confirms.

import CloseButton from "./CloseButton";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";

interface Props {
  title?: string;
  message: string;
  confirmLabel?: string;
  details?: Array<{ label: string; value: string; tone?: "pos" | "neg" }>;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmDialog({
  title = "Confirm",
  message,
  confirmLabel = "Delete",
  details,
  onConfirm,
  onClose,
}: Props) {
  useCloseOnEscape(onClose);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head confirm-head">
          <span>{title}</span>
          <CloseButton onClick={onClose} label="Cancel" />
        </div>
        <div className="confirm-body">
          {message}
          {details && details.length > 0 && (
            <dl className="confirm-details">
              {details.map((d) => (
                <div key={d.label} className="confirm-detail-row">
                  <dt>{d.label}</dt>
                  <dd className={d.tone ? `cd-${d.tone}` : undefined}>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="confirm-danger"
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
