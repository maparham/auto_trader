// Renders the pending agent confirm request (if any) as a blocking modal.
// Styling reuses the app's existing modal classes (see ConfirmDialog usage in
// App.tsx: .modal-backdrop / .modal). Approve runs the parked action handler;
// Reject (or timeout, handled in confirm.ts) refuses it.
import { useSyncExternalStore } from "react";
import { agentConfirmSignal, resolveAgentConfirm } from "./confirm";

export default function AgentConfirmHost() {
  const state = useSyncExternalStore(
    (cb) => agentConfirmSignal.subscribe(cb),
    () => agentConfirmSignal.value,
  );
  if (!state) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => resolveAgentConfirm(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Agent requests: {state.action}</span>
        </div>
        <div className="confirm-body">
          <p style={{ margin: 0 }}>{state.description}</p>
          <pre style={{ maxHeight: 200, overflow: "auto", fontSize: 12, margin: "8px 0 0 0" }}>
            {JSON.stringify(state.args, null, 2)}
          </pre>
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={() => resolveAgentConfirm(false)}>Reject</button>
          <button className="confirm-primary" onClick={() => resolveAgentConfirm(true)}>Approve</button>
        </div>
      </div>
    </div>
  );
}
