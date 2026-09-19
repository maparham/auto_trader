// The dealing confirm gate lives in the agent-ui-bridge package now; this
// module keeps the import path the app already uses.
export type { AgentConfirmState } from "agent-ui-bridge";
export { agentConfirmSignal, requestAgentConfirm, resolveAgentConfirm } from "agent-ui-bridge";
