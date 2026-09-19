// The action registry lives in the agent-ui-bridge package now. This module
// stays so every existing import path (App.tsx, every actions/ module) keeps
// resolving, and so there is exactly one registry instance in the app.
export type {
  ActionKind, ParamProperty, ParamSchema, ActionContext, AgentAction, ActionManifestEntry,
} from "agent-ui-bridge";
export {
  ActionError, registerAction, getAction, listActions, validateArgs, invokeAction,
  clearRegistryForTest,
} from "agent-ui-bridge";
