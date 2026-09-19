// The dialog itself lives in the agent-ui-bridge package; Chartkar supplies its
// own modal class names (see .modal / .modal-backdrop in App.css) so it looks
// exactly like every other modal in the app.
import { AgentConfirmHost } from "agent-ui-bridge/react";

export default function ChartkarAgentConfirmHost() {
  return <AgentConfirmHost className="modal" backdropClassName="modal-backdrop" />;
}
