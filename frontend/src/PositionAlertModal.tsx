// SL / TP proximity warnings for one open position, as a dialog (Alerts
// sidebar, mobile). The form is shared with the edit ticket's Alerts tab.
import FloatingModal from "./components/FloatingModal";
import { usePositionAlertsForm } from "./usePositionAlertsForm";
import type { PositionAlertRequest } from "./lib/signals";

export default function PositionAlertModal({ request, onClose }: { request: PositionAlertRequest; onClose: () => void }) {
  const form = usePositionAlertsForm(request);
  return (
    <FloatingModal
      className="alert-modal"
      title={<span>Warn near SL/TP · <strong>{request.epic}</strong></span>}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void form.save().then((ok) => ok && onClose())} disabled={form.busy}>Save</button>
        </>
      }
    >
      <div className="alert-body">{form.body}</div>
    </FloatingModal>
  );
}
