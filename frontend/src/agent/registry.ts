// Typed action registry for the Agent UI Bridge. Modules register named,
// schema-validated actions next to the real UI handlers; the bridge (bridge.ts)
// invokes them for connected MCP agents. Kind semantics:
//   read    - no side effects, safe to call anytime
//   write   - mutates UI/app state
//   confirm - dealing-grade: executes only after an in-browser Approve click
//             (the gate itself lives in confirm.ts and wraps the handler there)

export type ActionKind = "read" | "write" | "confirm";

export interface ParamProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: Array<string | number>;
}

export interface ParamSchema {
  type: "object";
  properties: Record<string, ParamProperty>;
  required?: string[];
}

export interface ActionContext {
  /** Push a progress payload for long-running actions (relayed to ui_wait). */
  progress(payload: unknown): void;
  /** Aborted when the agent cancels or the tab disconnects mid-invocation. */
  signal: AbortSignal;
}

export interface AgentAction {
  name: string;
  description: string;
  kind: ActionKind;
  params: ParamSchema;
  /** True: bridge replies with a handle immediately and streams progress/done. */
  longRunning?: boolean;
  /** Confirm-kind only: extra facts resolved at gate time and merged into the
   *  args the Approve dialog DISPLAYS (never into the handler's args, which stay
   *  exactly what the agent sent and schema-validated). For state the agent
   *  doesn't pass but the user must see before approving — e.g. which trading
   *  account an order will hit. */
  confirmContext?: () => Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ActionContext): Promise<unknown>;
}

// Both stripped fields are functions: they'd serialize to nothing over the wire.
export type ActionManifestEntry = Omit<AgentAction, "handler" | "confirmContext">;

export class ActionError extends Error {
  code: string;
  expectedSchema?: ParamSchema;
  constructor(code: string, message: string, expectedSchema?: ParamSchema) {
    super(message);
    this.code = code;
    this.expectedSchema = expectedSchema;
  }
}

const registry = new Map<string, AgentAction>();

export function registerAction(action: AgentAction): void {
  if (registry.has(action.name)) {
    throw new Error(`agent action already registered: ${action.name}`);
  }
  registry.set(action.name, action);
}

export function getAction(name: string): AgentAction | undefined {
  return registry.get(name);
}

export function listActions(): ActionManifestEntry[] {
  return [...registry.values()].map(({ handler: _h, confirmContext: _c, ...rest }) => rest);
}

/** Returns an error string, or null when args satisfy the schema. */
export function validateArgs(schema: ParamSchema, args: Record<string, unknown>): string | null {
  for (const key of schema.required ?? []) {
    if (!(key in args)) return `missing required argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) return `unknown argument: ${key}`;
    const t = Array.isArray(value) ? "array" : typeof value;
    if (t !== prop.type) return `argument ${key}: expected ${prop.type}, got ${t}`;
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      return `argument ${key}: must be one of ${prop.enum.join(", ")}`;
    }
  }
  return null;
}

export async function invokeAction(
  name: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<unknown> {
  const action = registry.get(name);
  if (!action) throw new ActionError("UNKNOWN_ACTION", `unknown action: ${name}`);
  const problem = validateArgs(action.params, args);
  if (problem) throw new ActionError("INVALID_ARGS", problem, action.params);
  return action.handler(args, ctx);
}

export function clearRegistryForTest(): void {
  registry.clear();
}
