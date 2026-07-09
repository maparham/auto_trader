// Selectable "Save as default template" modal. Lists the current chart's
// symbol-agnostic indicators (AVWAP already excluded upstream), all checked by
// default; confirming saves only the checked ones as the global default. Reuses
// the shared modal chrome (modal-backdrop / modal), CloseButton, useCloseOnEscape
// — same primitives as ConfirmDialog, but with a checkbox list.
import { useState } from "react";
import CloseButton from "./CloseButton";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import type { SaveDefaultTemplateRequest } from "./lib/signals";

interface Props {
  req: SaveDefaultTemplateRequest;
  onClose: () => void;
}

export default function SaveDefaultTemplateModal({ req, onClose }: Props) {
  useCloseOnEscape(onClose);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(req.candidates.map((c) => c.id)),
  );
  const empty = req.candidates.length === 0;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head confirm-head">
          <span>Save default template</span>
          <CloseButton onClick={onClose} label="Cancel" />
        </div>
        <div className="confirm-body">
          {empty ? (
            "This chart has no indicators to save."
          ) : (
            <>
              New charts of any symbol inherit the checked indicators. Drawings and
              AVWAP anchors are never included.
              <ul className="sdt-list">
                {req.candidates.map((c) => (
                  <li key={c.id} className="sdt-row" onClick={() => toggle(c.id)}>
                    <input type="checkbox" checked={checked.has(c.id)} readOnly />
                    <span className="ind-name">{c.label}</span>
                    <span className="sdt-params">{c.params}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {!empty && (
            <button
              className="confirm-primary"
              disabled={checked.size === 0}
              autoFocus
              onClick={() => {
                req.onConfirm([...checked]);
                onClose();
              }}
            >
              Save as default
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
