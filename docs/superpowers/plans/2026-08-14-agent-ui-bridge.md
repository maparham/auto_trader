# Agent UI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MCP agents see and drive the live auto_trader browser session — run backtests/sweeps, read results, control UI chrome — without screen-scraping.

**Architecture:** A typed action registry + WebSocket bridge compiled into the frontend, a backend relay (`/ws/agent-ui` + in-memory hub with invocation futures and long-running handles), and an MCP server (python `mcp` v2, `MCPServer`) mounted on the existing FastAPI app at `/mcp` exposing `ui_sessions` / `ui_actions` / `ui_invoke` / `ui_wait` / `ui_read_state`.

**Tech Stack:** React 18 + TypeScript + Vite + vitest (frontend); FastAPI + pytest (backend); `mcp>=2.0` (new backend dep). No zod — the registry uses a small hand-rolled JSON-schema-subset validator.

**Spec:** `docs/superpowers/specs/2026-08-14-agent-ui-bridge-design.md`

## Global Constraints

- Bridge connects only when enabled: `VITE_AGENT_BRIDGE=1`, defaulting to ON in dev builds (`import.meta.env.DEV`) and OFF otherwise. Never enabled in the rahkar.pro demo build.
- `/mcp` and `/ws/agent-ui` sit behind the existing `guard.py` middleware (it wraps the whole app, mounts included) — no new auth code.
- Dealing actions (`order.place`, `order.cancel`, `position.close`) are `kind: "confirm"`: they execute only after an explicit Approve click in the browser; timeout 120 s resolves as rejected.
- Fast-invoke relay timeout default 30 s; long-running actions return a handle immediately.
- No em dashes in end-user copy (use parentheses/colons). Comments and commits are fine.
- Frontend tests: `cd frontend && npx vitest run <file>`. Backend tests: `cd backend && python -m pytest tests/<file> -q`. NOTE: the full frontend suite has 5-7 known failures on main — never "fix" unrelated failing tests; only the files you add/touch must pass.
- Commit after each task with the message given in the task.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/agent/registry.ts` | Action registry: types, `registerAction`, `listActions`, `invokeAction`, arg validation |
| `frontend/src/agent/confirm.ts` | Confirm-gate plumbing: signal + `requestAgentConfirm()` promise |
| `frontend/src/agent/AgentConfirmHost.tsx` | The Approve/Reject modal component (rendered by App) |
| `frontend/src/agent/bridge.ts` | WS client: frame protocol, reconnect, handle events |
| `frontend/src/agent/actions/backtest.ts` | Config get/set, run/cancel, result/progress actions |
| `frontend/src/agent/actions/sweep.ts` | Sweep start/cancel/rows (with derived analytics) |
| `frontend/src/agent/actions/dealing.ts` | Confirm-gated order/position actions |
| `frontend/src/agent/index.ts` | `initAgentBridge()`: registers action modules + starts the bridge |
| `backend/auto_trader/api/agent_bridge.py` | `BridgeHub`: tab sessions, invocation futures, handle store |
| `backend/auto_trader/api/routers/agent.py` | `WS /ws/agent-ui` + `GET /api/agent/sessions` |
| `backend/auto_trader/api/mcp_server.py` | `MCPServer` with the five `ui_*` tools |
| `backend/auto_trader/api/app.py` | Mount `/mcp`, include agent router, lifespan wiring |

App-level actions (`market.select`, `tab.list`, `panel.*`) register inside `App.tsx` because they close over App's handlers (`jumpToEpic`, tab state).

---

### Task 1: Frontend action registry

**Files:**
- Create: `frontend/src/agent/registry.ts`
- Test: `frontend/src/agent/registry.test.ts`

**Interfaces:**
- Produces: `registerAction(action: AgentAction): void`, `listActions(): ActionManifestEntry[]`, `invokeAction(name: string, args: Record<string, unknown>, ctx: ActionContext): Promise<unknown>`, `clearRegistryForTest(): void`, types `AgentAction`, `ActionKind`, `ParamSchema`, `ActionContext`, error class `ActionError { code, expectedSchema? }`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/agent/registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAction, listActions, invokeAction, clearRegistryForTest, ActionError,
} from "./registry";

const ECHO = {
  name: "test.echo",
  description: "Echo args back",
  kind: "read" as const,
  params: {
    type: "object" as const,
    properties: {
      msg: { type: "string" as const, description: "message" },
      n: { type: "number" as const },
      side: { type: "string" as const, enum: ["long", "short"] },
    },
    required: ["msg"],
  },
  handler: async (args: Record<string, unknown>) => ({ got: args }),
};

const CTX = { progress: () => {}, signal: new AbortController().signal };

describe("agent action registry", () => {
  beforeEach(() => clearRegistryForTest());

  it("lists registered actions without handlers", () => {
    registerAction(ECHO);
    const manifest = listActions();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("test.echo");
    expect(manifest[0].kind).toBe("read");
    expect(manifest[0]).not.toHaveProperty("handler");
  });

  it("rejects duplicate registration", () => {
    registerAction(ECHO);
    expect(() => registerAction(ECHO)).toThrow(/already registered/);
  });

  it("invokes with valid args", async () => {
    registerAction(ECHO);
    const res = await invokeAction("test.echo", { msg: "hi" }, CTX);
    expect(res).toEqual({ got: { msg: "hi" } });
  });

  it("rejects unknown action with UNKNOWN_ACTION", async () => {
    await expect(invokeAction("nope", {}, CTX)).rejects.toMatchObject({
      code: "UNKNOWN_ACTION",
    });
  });

  it("rejects missing required arg and carries the schema", async () => {
    registerAction(ECHO);
    const err = await invokeAction("test.echo", {}, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.code).toBe("INVALID_ARGS");
    expect(err.expectedSchema).toEqual(ECHO.params);
  });

  it("rejects wrong type and bad enum value", async () => {
    registerAction(ECHO);
    await expect(invokeAction("test.echo", { msg: 5 }, CTX)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(
      invokeAction("test.echo", { msg: "x", side: "sideways" }, CTX),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("rejects unknown extra keys", async () => {
    registerAction(ECHO);
    await expect(invokeAction("test.echo", { msg: "x", zzz: 1 }, CTX)).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/agent/registry.test.ts`
Expected: FAIL (module `./registry` not found)

- [ ] **Step 3: Write the implementation**

```typescript
// frontend/src/agent/registry.ts
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
  handler(args: Record<string, unknown>, ctx: ActionContext): Promise<unknown>;
}

export type ActionManifestEntry = Omit<AgentAction, "handler">;

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
  return [...registry.values()].map(({ handler: _h, ...rest }) => rest);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/agent/registry.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/registry.ts frontend/src/agent/registry.test.ts
git commit -m "feat(agent): typed action registry for the agent UI bridge"
```

---

### Task 2: Confirm gate (signal + modal)

**Files:**
- Create: `frontend/src/agent/confirm.ts`
- Create: `frontend/src/agent/AgentConfirmHost.tsx`
- Modify: `frontend/src/App.tsx` (render `<AgentConfirmHost />` next to the existing ConfirmDialog render site)
- Test: `frontend/src/agent/confirm.test.ts`

**Interfaces:**
- Produces: `requestAgentConfirm(req: { action: string; description: string; args: Record<string, unknown>; timeoutMs?: number }): Promise<boolean>`; signal `agentConfirmSignal: Signal<AgentConfirmState | null>`; `resolveAgentConfirm(approved: boolean): void`.
- Consumes: `Signal` from `frontend/src/lib/signals.ts` (Task 1's registry is independent; the gate is applied in bridge.ts, Task 3).

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/agent/confirm.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestAgentConfirm, resolveAgentConfirm, agentConfirmSignal,
} from "./confirm";

afterEach(() => {
  agentConfirmSignal.set(null);
  vi.useRealTimers();
});

describe("agent confirm gate", () => {
  it("publishes the request and resolves true on approve", async () => {
    const p = requestAgentConfirm({ action: "order.place", description: "Place order", args: { epic: "US100" } });
    expect(agentConfirmSignal.value?.action).toBe("order.place");
    resolveAgentConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(agentConfirmSignal.value).toBeNull();
  });

  it("resolves false on reject", async () => {
    const p = requestAgentConfirm({ action: "order.place", description: "Place order", args: {} });
    resolveAgentConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it("times out as rejected", async () => {
    vi.useFakeTimers();
    const p = requestAgentConfirm({ action: "order.place", description: "d", args: {}, timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBe(false);
    expect(agentConfirmSignal.value).toBeNull();
  });

  it("rejects a second concurrent request immediately", async () => {
    const p1 = requestAgentConfirm({ action: "a", description: "d", args: {} });
    const p2 = requestAgentConfirm({ action: "b", description: "d", args: {} });
    await expect(p2).resolves.toBe(false);
    resolveAgentConfirm(true);
    await expect(p1).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/agent/confirm.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement confirm.ts**

```typescript
// frontend/src/agent/confirm.ts
// The dealing confirm gate: a confirm-kind action's execution is parked here
// until the user clicks Approve or Reject in the browser (AgentConfirmHost),
// or the timeout elapses (counts as Reject). One pending request at a time:
// a second concurrent ask auto-rejects so an agent can't queue-stack prompts.
import { Signal } from "../lib/signals";

export interface AgentConfirmState {
  action: string;
  description: string;
  args: Record<string, unknown>;
}

export const agentConfirmSignal = new Signal<AgentConfirmState | null>(null);

const DEFAULT_TIMEOUT_MS = 120_000;

let pending: { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;

export function requestAgentConfirm(req: {
  action: string;
  description: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolveAgentConfirm(false), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending = { resolve, timer };
    agentConfirmSignal.set({ action: req.action, description: req.description, args: req.args });
  });
}

export function resolveAgentConfirm(approved: boolean): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { resolve } = pending;
  pending = null;
  agentConfirmSignal.set(null);
  resolve(approved);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/agent/confirm.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Implement the modal host component**

```tsx
// frontend/src/agent/AgentConfirmHost.tsx
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
    <div className="modal-backdrop" onClick={() => resolveAgentConfirm(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Agent requests: {state.action}</h3>
        <p>{state.description}</p>
        <pre style={{ maxHeight: 200, overflow: "auto", fontSize: 12 }}>
          {JSON.stringify(state.args, null, 2)}
        </pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => resolveAgentConfirm(false)}>Reject</button>
          <button className="primary" onClick={() => resolveAgentConfirm(true)}>Approve</button>
        </div>
      </div>
    </div>
  );
}
```

Before writing, check the exact modal class names App.tsx uses for its `ConfirmDialog` (grep `ConfirmDialog` and open that component); match its wrapper classes so the modal inherits the app look. Then add to `App.tsx`, next to where `ConfirmDialog` is rendered:

```tsx
import AgentConfirmHost from "./agent/AgentConfirmHost";
// ... inside the JSX, alongside the ConfirmDialog render:
<AgentConfirmHost />
```

- [ ] **Step 6: Verify the frontend still typechecks/builds**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | head -20` (or the project's typecheck script from package.json if one exists)
Expected: no new errors in `src/agent/*` or App.tsx

- [ ] **Step 7: Commit**

```bash
git add frontend/src/agent/confirm.ts frontend/src/agent/confirm.test.ts frontend/src/agent/AgentConfirmHost.tsx frontend/src/App.tsx
git commit -m "feat(agent): confirm gate signal and Approve/Reject modal"
```

---

### Task 3: Frontend bridge WebSocket client

**Files:**
- Create: `frontend/src/agent/bridge.ts`
- Test: `frontend/src/agent/bridge.test.ts`

**Interfaces:**
- Produces: `startAgentBridge(wsUrl?: string): () => void` (returns stop fn), exported for tests: `handleFrame(frame: InboundFrame, send: (f: object) => void): Promise<void>`.
- Consumes: `listActions`, `invokeAction`, `getAction`, `ActionError` from `./registry`; `requestAgentConfirm` from `./confirm`; `API_BASE` from `../lib/http`.

**Wire protocol** (JSON text frames):
- Inbound: `{id: string, op: "manifest"}` or `{id, op: "invoke", action: string, args: object}` or `{id, op: "abort", handle: string}`.
- Outbound replies: `{id, ok: true, result}` | `{id, ok: true, handle}` (long-running ack) | `{id, ok: false, error: {code, message, expectedSchema?}}`.
- Outbound handle events: `{handle, event: "progress" | "done" | "error", payload}`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/agent/bridge.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { handleFrame } from "./bridge";
import { registerAction, clearRegistryForTest } from "./registry";

function collector() {
  const sent: any[] = [];
  return { sent, send: (f: object) => sent.push(f) };
}

beforeEach(() => clearRegistryForTest());

describe("bridge frame handling", () => {
  it("answers manifest with the action list", async () => {
    registerAction({
      name: "x.y", description: "d", kind: "read",
      params: { type: "object", properties: {} },
      handler: async () => 1,
    });
    const c = collector();
    await handleFrame({ id: "1", op: "manifest" }, c.send);
    expect(c.sent[0].id).toBe("1");
    expect(c.sent[0].ok).toBe(true);
    expect(c.sent[0].result[0].name).toBe("x.y");
  });

  it("invokes a fast action and replies with the result", async () => {
    registerAction({
      name: "add", description: "d", kind: "read",
      params: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      handler: async (args) => (args.a as number) + (args.b as number),
    });
    const c = collector();
    await handleFrame({ id: "2", op: "invoke", action: "add", args: { a: 2, b: 3 } }, c.send);
    expect(c.sent[0]).toEqual({ id: "2", ok: true, result: 5 });
  });

  it("replies with error + expectedSchema on invalid args", async () => {
    registerAction({
      name: "add", description: "d", kind: "read",
      params: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      handler: async () => 0,
    });
    const c = collector();
    await handleFrame({ id: "3", op: "invoke", action: "add", args: {} }, c.send);
    expect(c.sent[0].ok).toBe(false);
    expect(c.sent[0].error.code).toBe("INVALID_ARGS");
    expect(c.sent[0].error.expectedSchema).toBeTruthy();
  });

  it("acks a long-running action with a handle, then streams progress and done", async () => {
    let finish!: () => void;
    registerAction({
      name: "slow", description: "d", kind: "write", longRunning: true,
      params: { type: "object", properties: {} },
      handler: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.progress({ pct: 50 });
          finish = () => resolve({ done: true });
        }),
    });
    const c = collector();
    await handleFrame({ id: "4", op: "invoke", action: "slow", args: {} }, c.send);
    // ack + progress are synchronous relative to the handler start
    expect(c.sent[0]).toEqual({ id: "4", ok: true, handle: "4" });
    expect(c.sent[1]).toEqual({ handle: "4", event: "progress", payload: { pct: 50 } });
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.sent[2]).toEqual({ handle: "4", event: "done", payload: { done: true } });
  });

  it("streams error event when a long-running handler throws", async () => {
    registerAction({
      name: "boom", description: "d", kind: "write", longRunning: true,
      params: { type: "object", properties: {} },
      handler: async () => { throw new Error("kaput"); },
    });
    const c = collector();
    await handleFrame({ id: "5", op: "invoke", action: "boom", args: {} }, c.send);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.sent[0].handle).toBe("5");
    expect(c.sent[1]).toEqual({ handle: "5", event: "error", payload: { message: "kaput" } });
  });

  it("abort resolves the running action's signal", async () => {
    let aborted = false;
    registerAction({
      name: "loop", description: "d", kind: "write", longRunning: true,
      params: { type: "object", properties: {} },
      handler: (_a, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => { aborted = true; resolve("stopped"); });
        }),
    });
    const c = collector();
    await handleFrame({ id: "6", op: "invoke", action: "loop", args: {} }, c.send);
    await handleFrame({ id: "7", op: "abort", handle: "6" }, c.send);
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
    expect(c.sent.some((f) => f.id === "7" && f.ok === true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/agent/bridge.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement bridge.ts**

```typescript
// frontend/src/agent/bridge.ts
// WebSocket client side of the Agent UI Bridge. Connects to the backend's
// /ws/agent-ui relay, executes registry actions on request, and streams
// progress for long-running invocations. Frame shapes are documented in the
// implementation plan and mirrored in backend/auto_trader/api/agent_bridge.py.
import { API_BASE } from "../lib/http";
import {
  ActionError, getAction, invokeAction, listActions,
} from "./registry";
import { requestAgentConfirm } from "./confirm";

export interface InboundFrame {
  id: string;
  op: "manifest" | "invoke" | "abort";
  action?: string;
  args?: Record<string, unknown>;
  handle?: string;
}

// Long-running invocations in flight, keyed by handle (= the invoke frame id).
const running = new Map<string, AbortController>();

export async function handleFrame(frame: InboundFrame, send: (f: object) => void): Promise<void> {
  if (frame.op === "manifest") {
    send({ id: frame.id, ok: true, result: listActions() });
    return;
  }
  if (frame.op === "abort") {
    const ctl = frame.handle ? running.get(frame.handle) : undefined;
    ctl?.abort();
    send({ id: frame.id, ok: true, result: { aborted: Boolean(ctl) } });
    return;
  }
  // op === "invoke"
  const name = frame.action ?? "";
  const args = frame.args ?? {};
  const action = getAction(name);
  const ctl = new AbortController();

  const runIt = async () => {
    if (action?.kind === "confirm") {
      const approved = await requestAgentConfirm({
        action: name, description: action.description, args,
      });
      if (!approved) throw new ActionError("REJECTED", "user rejected or confirm timed out");
    }
    return invokeAction(name, args, {
      progress: (payload) => send({ handle: frame.id, event: "progress", payload }),
      signal: ctl.signal,
    });
  };

  if (action?.longRunning) {
    running.set(frame.id, ctl);
    send({ id: frame.id, ok: true, handle: frame.id });
    // Fire-and-stream: completion goes out as a handle event, not a reply.
    runIt()
      .then((result) => send({ handle: frame.id, event: "done", payload: result }))
      .catch((e) => send({
        handle: frame.id, event: "error",
        payload: { message: e instanceof Error ? e.message : String(e), code: e instanceof ActionError ? e.code : undefined },
      }))
      .finally(() => running.delete(frame.id));
    return;
  }

  try {
    const result = await runIt();
    send({ id: frame.id, ok: true, result });
  } catch (e) {
    const err = e instanceof ActionError
      ? { code: e.code, message: e.message, expectedSchema: e.expectedSchema }
      : { code: "ACTION_FAILED", message: e instanceof Error ? e.message : String(e) };
    send({ id: frame.id, ok: false, error: err });
  }
}

/** Connect to the relay; auto-reconnects with backoff. Returns a stop fn. */
export function startAgentBridge(wsUrl?: string): () => void {
  const url = wsUrl ?? `${API_BASE.replace(/^http/, "ws")}/ws/agent-ui`;
  let ws: WebSocket | null = null;
  let stopped = false;
  let retryMs = 1000;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => { retryMs = 1000; };
    ws.onmessage = (ev) => {
      let frame: InboundFrame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      void handleFrame(frame, (f) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
      });
    };
    ws.onclose = () => {
      if (stopped) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
  };
  connect();
  return () => { stopped = true; ws?.close(); };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/agent/bridge.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/bridge.ts frontend/src/agent/bridge.test.ts
git commit -m "feat(agent): WS bridge client with frame protocol and long-running handles"
```

---

### Task 4: Backend relay hub

**Files:**
- Create: `backend/auto_trader/api/agent_bridge.py`
- Test: `backend/tests/test_agent_bridge_hub.py`

**Interfaces:**
- Produces: module-level `HUB = BridgeHub()` with:
  - `register(send: Callable[[dict], Awaitable[None]]) -> str` (returns session_id), `unregister(session_id: str) -> None`, `touch(session_id: str) -> None`
  - `sessions() -> list[dict]` (id, connected_at, last_active)
  - `async request(op: str, payload: dict, session_id: str | None = None, timeout: float = 30.0) -> dict` (raises `NoTabError`, `TabTimeoutError`, `ActionFailedError(code, message, expected_schema)`)
  - `on_frame(session_id: str, frame: dict) -> None` (called by the WS route for every tab message)
  - `async wait_handle(handle: str, timeout: float) -> dict` (returns `{status: "running"|"done"|"error", progress, result?, error?}`; raises `KeyError` for unknown handle)
- Consumes: nothing app-specific (pure asyncio; the WS route in Task 5 plugs in).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_agent_bridge_hub.py
"""BridgeHub: invocation futures, handle store, session routing."""
import asyncio

import pytest

from auto_trader.api.agent_bridge import (
    ActionFailedError, BridgeHub, NoTabError, TabTimeoutError,
)


def make_tab(hub: BridgeHub):
    """A fake tab: captures outbound frames; test feeds replies via hub.on_frame."""
    sent: list[dict] = []

    async def send(frame: dict) -> None:
        sent.append(frame)

    sid = hub.register(send)
    return sid, sent


async def _reply_ok(hub, sid, sent, result):
    while not sent:
        await asyncio.sleep(0)
    frame = sent[-1]
    hub.on_frame(sid, {"id": frame["id"], "ok": True, "result": result})


@pytest.mark.asyncio
async def test_request_roundtrip():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "a", "args": {}}))
    await _reply_ok(hub, sid, sent, {"x": 1})
    assert await task == {"x": 1}
    assert sent[0]["op"] == "invoke" and sent[0]["action"] == "a"


@pytest.mark.asyncio
async def test_no_tab_error():
    hub = BridgeHub()
    with pytest.raises(NoTabError):
        await hub.request("manifest", {})


@pytest.mark.asyncio
async def test_error_reply_raises_action_failed():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "a", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    hub.on_frame(sid, {"id": sent[-1]["id"], "ok": False,
                       "error": {"code": "INVALID_ARGS", "message": "bad", "expectedSchema": {"type": "object"}}})
    with pytest.raises(ActionFailedError) as ei:
        await task
    assert ei.value.code == "INVALID_ARGS"
    assert ei.value.expected_schema == {"type": "object"}


@pytest.mark.asyncio
async def test_timeout():
    hub = BridgeHub()
    make_tab(hub)
    with pytest.raises(TabTimeoutError):
        await hub.request("invoke", {"action": "a", "args": {}}, timeout=0.05)


@pytest.mark.asyncio
async def test_targets_most_recently_active_tab():
    hub = BridgeHub()
    sid1, sent1 = make_tab(hub)
    sid2, sent2 = make_tab(hub)
    hub.touch(sid1)  # tab 1 active most recently
    task = asyncio.ensure_future(hub.request("manifest", {}))
    await _reply_ok(hub, sid1, sent1, [])
    await task
    assert sent1 and not sent2


@pytest.mark.asyncio
async def test_handle_lifecycle():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "slow", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    assert await task == {"handle": rid}
    hub.on_frame(sid, {"handle": rid, "event": "progress", "payload": {"pct": 40}})
    st = await hub.wait_handle(rid, timeout=0.05)
    assert st["status"] == "running" and st["progress"] == {"pct": 40}
    hub.on_frame(sid, {"handle": rid, "event": "done", "payload": {"pnl": 5}})
    st = await hub.wait_handle(rid, timeout=1.0)
    assert st["status"] == "done" and st["result"] == {"pnl": 5}


@pytest.mark.asyncio
async def test_disconnect_fails_open_requests_and_handles():
    hub = BridgeHub()
    sid, sent = make_tab(hub)
    task = asyncio.ensure_future(hub.request("invoke", {"action": "slow", "args": {}}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    await task
    hub.unregister(sid)
    st = await hub.wait_handle(rid, timeout=0.05)
    assert st["status"] == "error"
    assert "disconnected" in st["error"]
```

Check whether `pytest-asyncio` (or anyio) is configured: `grep -rn "asyncio" backend/pyproject.toml backend/tests/conftest.py`. If `pytest.mark.asyncio` is not supported, add `anyio` style used elsewhere in the suite, or add `pytest-asyncio` to the dev extras in `backend/pyproject.toml` (`"pytest-asyncio>=0.24"`) plus `asyncio_mode = "auto"` under `[tool.pytest.ini_options]` — follow whichever async-test convention existing tests use (grep `async def test_` in backend/tests first).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_agent_bridge_hub.py -q`
Expected: FAIL (ImportError)

- [ ] **Step 3: Implement agent_bridge.py**

```python
# backend/auto_trader/api/agent_bridge.py
"""Relay hub for the Agent UI Bridge.

Browser tabs connect over /ws/agent-ui (routers/agent.py) and register a send
callable here. MCP tools (mcp_server.py) call `HUB.request(...)`, which sends a
frame to the target tab and awaits its reply as an asyncio future. Long-running
invocations get a HandleRecord that accumulates progress/done/error events for
`ui_wait` polling. All state is in-memory (same pattern as sweep_jobs.JOBS);
handles are TTL-pruned an hour after completion.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

_HANDLE_TTL_S = 3600.0
_DEFAULT_TIMEOUT_S = 30.0


class NoTabError(Exception):
    """No UI session connected: open the app in a browser."""


class TabTimeoutError(Exception):
    """The tab did not reply within the timeout."""


class ActionFailedError(Exception):
    def __init__(self, code: str, message: str, expected_schema: dict | None = None):
        super().__init__(message)
        self.code = code
        self.expected_schema = expected_schema


@dataclass
class _Tab:
    id: str
    send: Callable[[dict], Awaitable[None]]
    connected_at: float
    last_active: float


@dataclass
class _Handle:
    session_id: str
    status: str = "running"  # running | done | error
    progress: Any = None
    result: Any = None
    error: str | None = None
    finished_at: float | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class BridgeHub:
    def __init__(self) -> None:
        self._tabs: dict[str, _Tab] = {}
        self._pending: dict[str, asyncio.Future] = {}
        self._handles: dict[str, _Handle] = {}

    # -- tab lifecycle -----------------------------------------------------
    def register(self, send: Callable[[dict], Awaitable[None]]) -> str:
        sid = uuid.uuid4().hex[:12]
        now = time.time()
        self._tabs[sid] = _Tab(id=sid, send=send, connected_at=now, last_active=now)
        return sid

    def unregister(self, session_id: str) -> None:
        self._tabs.pop(session_id, None)
        # Fail everything still parked on this tab so callers don't hang.
        for rid, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_exception(NoTabError("UI session disconnected"))
            self._pending.pop(rid, None)
        for h in self._handles.values():
            if h.session_id == session_id and h.status == "running":
                h.status = "error"
                h.error = "UI session disconnected"
                h.finished_at = time.time()
                h.changed.set()

    def touch(self, session_id: str) -> None:
        tab = self._tabs.get(session_id)
        if tab:
            tab.last_active = time.time()

    def sessions(self) -> list[dict]:
        return [
            {"id": t.id, "connectedAt": t.connected_at, "lastActive": t.last_active}
            for t in sorted(self._tabs.values(), key=lambda t: -t.last_active)
        ]

    def _target(self, session_id: str | None) -> _Tab:
        if session_id is not None:
            tab = self._tabs.get(session_id)
            if not tab:
                raise NoTabError(f"no UI session {session_id!r}")
            return tab
        if not self._tabs:
            raise NoTabError("no UI session connected: open the app in a browser")
        return max(self._tabs.values(), key=lambda t: t.last_active)

    # -- request/reply -----------------------------------------------------
    async def request(
        self,
        op: str,
        payload: dict,
        session_id: str | None = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> Any:
        self._prune_handles()
        tab = self._target(session_id)
        rid = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await tab.send({"id": rid, "op": op, **payload})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise TabTimeoutError(f"tab did not reply within {timeout}s (op={op})") from e
        finally:
            self._pending.pop(rid, None)

    def on_frame(self, session_id: str, frame: dict) -> None:
        self.touch(session_id)
        rid = frame.get("id")
        if rid is not None:
            fut = self._pending.get(rid)
            if fut is None or fut.done():
                return
            if frame.get("ok"):
                if "handle" in frame:
                    self._handles[frame["handle"]] = _Handle(session_id=session_id)
                    fut.set_result({"handle": frame["handle"]})
                else:
                    fut.set_result(frame.get("result"))
            else:
                err = frame.get("error") or {}
                fut.set_exception(ActionFailedError(
                    err.get("code", "ACTION_FAILED"),
                    err.get("message", "action failed"),
                    err.get("expectedSchema"),
                ))
            return
        handle_id = frame.get("handle")
        if handle_id is None:
            return
        h = self._handles.get(handle_id)
        if h is None:
            return
        event = frame.get("event")
        if event == "progress":
            h.progress = frame.get("payload")
        elif event == "done":
            h.status = "done"
            h.result = frame.get("payload")
            h.finished_at = time.time()
        elif event == "error":
            payload = frame.get("payload") or {}
            h.status = "error"
            h.error = payload.get("message", "action failed")
            h.finished_at = time.time()
        h.changed.set()
        h.changed = asyncio.Event()

    # -- handles -----------------------------------------------------------
    async def wait_handle(self, handle: str, timeout: float) -> dict:
        h = self._handles[handle]  # KeyError -> caller reports unknown handle
        deadline = asyncio.get_running_loop().time() + timeout
        while h.status == "running":
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(h.changed.wait(), remaining)
            except asyncio.TimeoutError:
                break
        out: dict[str, Any] = {"status": h.status, "progress": h.progress}
        if h.status == "done":
            out["result"] = h.result
        if h.status == "error":
            out["error"] = h.error
        return out

    def _prune_handles(self) -> None:
        cutoff = time.time() - _HANDLE_TTL_S
        for hid, h in list(self._handles.items()):
            if h.finished_at is not None and h.finished_at < cutoff:
                self._handles.pop(hid, None)


HUB = BridgeHub()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_agent_bridge_hub.py -q`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/agent_bridge.py backend/tests/test_agent_bridge_hub.py
git commit -m "feat(agent): backend BridgeHub with invocation futures and handle store"
```

---

### Task 5: WS route + sessions endpoint, wired into the app

**Files:**
- Create: `backend/auto_trader/api/routers/agent.py`
- Modify: `backend/auto_trader/api/app.py` (import + include router)
- Test: `backend/tests/test_api_agent_ws.py`

**Interfaces:**
- Produces: `WS /ws/agent-ui` (tab side), `GET /api/agent/sessions` -> `{"sessions": [...]}`.
- Consumes: `HUB` from `..agent_bridge`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_agent_ws.py
"""WS /ws/agent-ui registers a tab in the HUB; GET /api/agent/sessions lists it."""
import threading

from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.agent_bridge import HUB

client = TestClient(app)


def test_sessions_empty():
    r = client.get("/api/agent/sessions")
    assert r.status_code == 200
    assert r.json() == {"sessions": []}


def test_ws_registers_and_relays():
    with client.websocket_connect("/ws/agent-ui") as ws:
        sessions = client.get("/api/agent/sessions").json()["sessions"]
        assert len(sessions) == 1
        sid = sessions[0]["id"]

        # Drive a request through the hub from a worker thread (TestClient's
        # websocket runs the app's event loop in the portal; hub.request must
        # be scheduled on that loop). The relay sends the frame to our fake tab.
        import anyio
        result_holder = {}

        def do_request():
            # run_sync bridges into the app loop via the ws portal is not
            # exposed; instead reply first, then assert the sent frame shape.
            pass

        # Simpler: emulate the MCP side by scheduling on_frame directly. Send a
        # frame from the tab side and confirm the hub processed it (touch).
        ws.send_json({"id": "nope", "ok": True, "result": 1})  # unknown id: ignored
        sessions2 = client.get("/api/agent/sessions").json()["sessions"]
        assert sessions2[0]["lastActive"] >= sessions[0]["lastActive"]

    # After close the tab is gone.
    assert client.get("/api/agent/sessions").json()["sessions"] == []
```

(The full request/reply round trip over a real socket is covered by the probe script in Task 9; here we verify registration, frame ingestion, and cleanup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_agent_ws.py -q`
Expected: FAIL (404 / route not found)

- [ ] **Step 3: Implement the router**

```python
# backend/auto_trader/api/routers/agent.py
"""Agent UI Bridge relay routes: the tab-side WebSocket and a sessions probe."""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..agent_bridge import HUB

router = APIRouter()


@router.get("/api/agent/sessions")
async def agent_sessions() -> dict:
    return {"sessions": HUB.sessions()}


@router.websocket("/ws/agent-ui")
async def ws_agent_ui(websocket: WebSocket) -> None:
    """A browser tab's bridge connection. Frames FROM the tab are replies and
    handle events; frames TO the tab are invoke/manifest/abort requests sent by
    HUB.request. (Same accept/registry/finally shape as /ws/state.)"""
    await websocket.accept()
    sid = HUB.register(websocket.send_json)
    try:
        while True:
            frame = await websocket.receive_json()
            HUB.on_frame(sid, frame)
    except WebSocketDisconnect:
        pass
    finally:
        HUB.unregister(sid)
```

Wire into `app.py`: add `agent` to the router import line and the include loop:

```python
from .routers import backtest, charts, compute, costs, expr, markets, mt5, state, strategy, strategies, stream, trading, agent
# ...
for _module in (markets, trading, state, charts, backtest, compute, strategy, stream, strategies, costs, expr, mt5, agent):
    app.include_router(_module.router)
```

- [ ] **Step 4: Run tests to verify pass + no regressions**

Run: `cd backend && python -m pytest tests/test_api_agent_ws.py tests/test_api_guard.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/agent.py backend/auto_trader/api/app.py backend/tests/test_api_agent_ws.py
git commit -m "feat(agent): /ws/agent-ui relay route and sessions endpoint"
```

---

### Task 6: MCP server mounted at /mcp

**Files:**
- Create: `backend/auto_trader/api/mcp_server.py`
- Modify: `backend/auto_trader/api/app.py` (mount + lifespan), `backend/pyproject.toml` (add `"mcp>=2.0"` to dependencies)
- Test: `backend/tests/test_mcp_tools.py`

**Interfaces:**
- Produces: `mcp` (`MCPServer` instance) with async tools `ui_sessions`, `ui_actions`, `ui_invoke`, `ui_wait`, `ui_read_state`; helper `mcp_http_app()` returning the ASGI app for mounting.
- Consumes: `HUB`, `NoTabError`, `TabTimeoutError`, `ActionFailedError` from `.agent_bridge`.

- [ ] **Step 1: Add the dependency and install**

In `backend/pyproject.toml` `dependencies`, add `"mcp>=2.0"`. Then run: `cd backend && pip install -e ".[dev]"` (or the project's usual install command; check for a `uv.lock`/`requirements` convention first with `ls backend`).
Expected: `python -c "from mcp.server import MCPServer"` (verify the exact import path: v2 docs name the class `MCPServer`; if that import fails, run `python -c "import mcp.server as s; print([n for n in dir(s) if 'MCP' in n or 'Fast' in n])"` and use the class the installed version exports — 1.x calls it `FastMCP` under `mcp.server.fastmcp`).

- [ ] **Step 2: Write the failing test**

The tools are plain async functions; test them against `HUB` with a fake tab (no HTTP transport needed).

```python
# backend/tests/test_mcp_tools.py
"""MCP tool functions drive BridgeHub correctly (no HTTP transport involved)."""
import asyncio

import pytest

from auto_trader.api import mcp_server
from auto_trader.api.agent_bridge import BridgeHub


@pytest.fixture()
def hub(monkeypatch):
    h = BridgeHub()
    monkeypatch.setattr(mcp_server, "HUB", h)
    return h


def fake_tab(hub):
    sent = []

    async def send(frame):
        sent.append(frame)

    sid = hub.register(send)
    return sid, sent


async def reply(hub, sid, sent, **kv):
    while not sent:
        await asyncio.sleep(0)
    hub.on_frame(sid, {"id": sent[-1]["id"], **kv})


@pytest.mark.asyncio
async def test_ui_sessions_empty(hub):
    assert await mcp_server.ui_sessions() == []


@pytest.mark.asyncio
async def test_ui_actions_relays_manifest(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_actions())
    await reply(hub, sid, sent, ok=True, result=[{"name": "backtest.run"}])
    assert await task == [{"name": "backtest.run"}]
    assert sent[0]["op"] == "manifest"


@pytest.mark.asyncio
async def test_ui_invoke_and_wait(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_invoke("backtest.run", {}))
    while not sent:
        await asyncio.sleep(0)
    rid = sent[-1]["id"]
    hub.on_frame(sid, {"id": rid, "ok": True, "handle": rid})
    assert await task == {"handle": rid}
    hub.on_frame(sid, {"handle": rid, "event": "done", "payload": {"pnl": 1}})
    st = await mcp_server.ui_wait(rid, timeout_s=1)
    assert st["status"] == "done" and st["result"] == {"pnl": 1}


@pytest.mark.asyncio
async def test_no_tab_is_a_clear_message(hub):
    with pytest.raises(Exception, match="no UI session connected"):
        await mcp_server.ui_invoke("x", {})


@pytest.mark.asyncio
async def test_invalid_args_error_carries_schema(hub):
    sid, sent = fake_tab(hub)
    task = asyncio.ensure_future(mcp_server.ui_invoke("x", {}))
    await reply(hub, sid, sent, ok=False,
                error={"code": "INVALID_ARGS", "message": "missing epic",
                       "expectedSchema": {"type": "object"}})
    with pytest.raises(Exception, match="INVALID_ARGS.*missing epic"):
        await task
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_mcp_tools.py -q`
Expected: FAIL (no module `mcp_server`)

- [ ] **Step 4: Implement mcp_server.py**

```python
# backend/auto_trader/api/mcp_server.py
"""MCP server for the Agent UI Bridge, mounted on the FastAPI app at /mcp.

Agents (Claude Code etc.) connect over streamable HTTP and get five tools that
relay to the connected browser tab via agent_bridge.HUB. Errors surface as tool
errors with actionable messages (the MCP SDK converts raised exceptions)."""
from __future__ import annotations

from mcp.server import MCPServer  # v2 API; see plan Task 6 Step 1 for the 1.x fallback

from .agent_bridge import HUB, ActionFailedError, NoTabError, TabTimeoutError

mcp = MCPServer("auto-trader-ui")


def _friendly(e: Exception) -> Exception:
    if isinstance(e, ActionFailedError):
        detail = f"{e.code}: {e}"
        if e.expected_schema:
            detail += f" (expected schema: {e.expected_schema})"
        return RuntimeError(detail)
    return RuntimeError(str(e))


@mcp.tool()
async def ui_sessions() -> list[dict]:
    """List connected UI tabs (most recently active first)."""
    return HUB.sessions()


@mcp.tool()
async def ui_actions(session: str | None = None) -> list[dict]:
    """The manifest: every UI action with its name, kind, and JSON schema."""
    try:
        return await HUB.request("manifest", {}, session_id=session)
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


@mcp.tool()
async def ui_invoke(action: str, args: dict | None = None, session: str | None = None) -> object:
    """Invoke a UI action. Fast actions return the result; long-running ones
    (backtest.run, sweep.start) return {"handle": ...} - poll with ui_wait."""
    try:
        return await HUB.request("invoke", {"action": action, "args": args or {}}, session_id=session)
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


@mcp.tool()
async def ui_wait(handle: str, timeout_s: float = 60.0) -> dict:
    """Wait for a long-running invocation. Returns {status, progress, result?, error?};
    status "running" after timeout means keep polling."""
    try:
        return await HUB.wait_handle(handle, timeout=timeout_s)
    except KeyError:
        raise RuntimeError(f"unknown handle: {handle} (expired or never issued)")


@mcp.tool()
async def ui_read_state(key: str, session: str | None = None) -> object:
    """Shorthand for invoking a read-kind action by name (e.g. backtest.result)."""
    try:
        return await HUB.request("invoke", {"action": key, "args": {}}, session_id=session)
    except (NoTabError, TabTimeoutError, ActionFailedError) as e:
        raise _friendly(e) from e


def mcp_http_app():
    """The streamable-HTTP ASGI app, for mounting at /mcp in app.py."""
    return mcp.streamable_http_app(streamable_http_path="/")
```

- [ ] **Step 5: Mount in app.py**

In `backend/auto_trader/api/app.py`:

```python
from .mcp_server import mcp, mcp_http_app
```

Inside `lifespan`, wrap the existing `yield` so the MCP session manager runs for the app's lifetime (a mounted sub-app's own lifespan never runs):

```python
    try:
        async with mcp.session_manager.run():
            yield
    finally:
        ...
```

After the router include loop, mount:

```python
# MCP endpoint for the Agent UI Bridge. Mounted LAST so it never shadows API
# routes; the guard middleware wraps mounts too, so REQUIRE_API_TOKEN covers it.
app.mount("/mcp", mcp_http_app())
```

If `streamable_http_app(streamable_http_path="/")` is not a valid signature on the installed version, check `help(mcp.streamable_http_app)` and use the constructor-level path setting instead (`MCPServer("auto-trader-ui", streamable_http_path="/")`) with `app.mount("/mcp", mcp.streamable_http_app())`.

- [ ] **Step 6: Run tests + smoke the app import**

Run: `cd backend && python -m pytest tests/test_mcp_tools.py tests/test_api_guard.py tests/test_api_agent_ws.py -q && python -c "from auto_trader.api.app import app; print('app ok')"`
Expected: PASS + `app ok`

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/mcp_server.py backend/auto_trader/api/app.py backend/pyproject.toml backend/tests/test_mcp_tools.py
git commit -m "feat(agent): MCP server with ui_* tools mounted at /mcp"
```

---

### Task 7: Backtest workflow actions (config, run, result, progress)

**Files:**
- Create: `frontend/src/agent/actions/backtest.ts`
- Create: `frontend/src/agent/index.ts`
- Modify: `frontend/src/App.tsx` (call `initAgentBridge()` once; register app-level actions)
- Test: `frontend/src/agent/actions/backtest.test.ts`

**Interfaces:**
- Produces: `registerBacktestActions(): void` registering:
  - `backtest.config.get` (read) -> the last-used `BacktestConfig` (or defaults)
  - `backtest.config.set` (write; args `{patch: object}`) -> shallow-merges the patch into the last-used config via `saveBacktestLastUsed`, returns the merged config
  - `backtest.run` (write, longRunning, args `{}`) -> triggers the existing run path via `requestBacktestRun()`, streams `backtestProgressSignal` as progress, resolves with `backtestResultSignal.value.summary`-level data or rejects with `backtestMessagesSignal.value.error`
  - `backtest.cancel` (write) -> `requestBacktestCancel()`
  - `backtest.result` (read) -> current `backtestResultSignal.value` (metrics/trades/analysis, no candles)
  - `backtest.progress` (read) -> `backtestProgressSignal.value`
- Produces: `initAgentBridge(): void` in `agent/index.ts` (registers modules + `startAgentBridge()` when enabled).
- Consumes: registry (Task 1), bridge (Task 3), `lib/persist` (`loadBacktestLastUsed`, `saveBacktestLastUsed`), `lib/backtestConfig` (`defaultBacktestConfig`), signals (`requestBacktestRun`, `requestBacktestCancel`, `backtestResultSignal`, `backtestRunningSignal`, `backtestProgressSignal`, `backtestMessagesSignal`).

Key design point: `backtest.run` does NOT rebuild the request; it drives the exact same signal path the panel's Run button uses (`requestBacktestRun()` -> `BacktestButton.run()`), so window resolution, candle fetch, warm-up widening, and baselines all reuse the production code untouched.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/agent/actions/backtest.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearRegistryForTest, invokeAction } from "../registry";
import { registerBacktestActions } from "./backtest";
import {
  backtestResultSignal, backtestRunningSignal, backtestRunRequest,
  backtestMessagesSignal, backtestProgressSignal,
} from "../../lib/signals";

const CTX = () => ({ progress: vi.fn(), signal: new AbortController().signal });

beforeEach(() => {
  clearRegistryForTest();
  localStorage.clear();
  backtestResultSignal.set(null);
  backtestRunningSignal.set(false);
  backtestMessagesSignal.set({ error: null });
  backtestProgressSignal.set(null);
  registerBacktestActions();
});

describe("backtest actions", () => {
  it("config.get returns defaults when nothing saved", async () => {
    const cfg = (await invokeAction("backtest.config.get", {}, CTX())) as any;
    expect(cfg).toHaveProperty("costs");
    expect(cfg).toHaveProperty("range");
  });

  it("config.set merges a patch and persists", async () => {
    const merged = (await invokeAction(
      "backtest.config.set",
      { patch: { codedStrategy: "sma_cross.py", mode: "coded" } },
      CTX(),
    )) as any;
    expect(merged.codedStrategy).toBe("sma_cross.py");
    const again = (await invokeAction("backtest.config.get", {}, CTX())) as any;
    expect(again.codedStrategy).toBe("sma_cross.py");
  });

  it("backtest.run bumps the run-request signal and resolves on completion", async () => {
    let bumped = 0;
    const unsub = backtestRunRequest.subscribe(() => {
      bumped++;
      // Simulate BacktestButton: start, then publish a result and finish.
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestResultSignal.set({ summary: { pnl: 42 } } as any);
        backtestRunningSignal.set(false);
      }, 0);
    });
    const res = (await invokeAction("backtest.run", {}, CTX())) as any;
    unsub();
    expect(bumped).toBe(1);
    expect(res.summary.pnl).toBe(42);
  });

  it("backtest.run rejects when the run publishes an error", async () => {
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestMessagesSignal.set({ error: "no candles in the selected range" });
        backtestRunningSignal.set(false);
      }, 0);
    });
    await expect(invokeAction("backtest.run", {}, CTX())).rejects.toThrow(/no candles/);
    unsub();
  });

  it("backtest.result reads the published result", async () => {
    backtestResultSignal.set({ summary: { pnl: 7 } } as any);
    const r = (await invokeAction("backtest.result", {}, CTX())) as any;
    expect(r.summary.pnl).toBe(7);
  });
});
```

Note: `lib/persist` uses localStorage; vitest config already provides a DOM env for other lib tests (check `frontend/vite.config.ts` / `vitest` config for `environment: "jsdom"` or `happy-dom` — the sibling `lib/*.test.ts` files use localStorage, so follow whatever they do; if they import a setup helper, import the same one).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/agent/actions/backtest.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement actions/backtest.ts**

```typescript
// frontend/src/agent/actions/backtest.ts
// Backtest workflow actions. backtest.run drives the SAME signal path as the
// panel's Run button (requestBacktestRun -> BacktestButton.run), so all the
// browser-side assembly (window resolution, candle fetch, warm-up widening,
// baselines) is reused untouched; this module only adapts start/finish/error
// signals into a promise + progress stream for the bridge.
import { registerAction } from "../registry";
import {
  backtestMessagesSignal, backtestProgressSignal, backtestResultSignal,
  backtestRunningSignal, requestBacktestCancel, requestBacktestRun,
} from "../../lib/signals";
import { loadBacktestLastUsed, saveBacktestLastUsed } from "../../lib/persist";
import { defaultBacktestConfig, type BacktestConfig } from "../../lib/backtestConfig";

function currentConfig(): BacktestConfig {
  return loadBacktestLastUsed() ?? defaultBacktestConfig();
}

export function registerBacktestActions(): void {
  registerAction({
    name: "backtest.config.get",
    description: "The current (last-used) backtest configuration",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => currentConfig(),
  });

  registerAction({
    name: "backtest.config.set",
    description:
      "Shallow-merge a patch into the backtest configuration (same shape as backtest.config.get: mode, codedStrategy, range, costs, longRisk, ...). Returns the merged config.",
    kind: "write",
    params: {
      type: "object",
      properties: { patch: { type: "object", description: "Partial BacktestConfig" } },
      required: ["patch"],
    },
    handler: async (args) => {
      const merged = { ...currentConfig(), ...(args.patch as Partial<BacktestConfig>) };
      saveBacktestLastUsed(merged as BacktestConfig);
      return merged;
    },
  });

  registerAction({
    name: "backtest.run",
    description:
      "Run a backtest with the current configuration on the focused chart. Long-running: returns a handle; ui_wait streams progress and resolves with the result.",
    kind: "write",
    longRunning: true,
    params: { type: "object", properties: {} },
    handler: (_args, ctx) =>
      new Promise((resolve, reject) => {
        let started = false;
        const unsubs: Array<() => void> = [];
        const cleanup = () => unsubs.forEach((u) => u());

        unsubs.push(backtestProgressSignal.subscribe((p) => { if (p) ctx.progress(p); }));
        unsubs.push(backtestRunningSignal.subscribe((running) => {
          if (running) { started = true; return; }
          if (!started) return; // ignore the initial false
          cleanup();
          const err = backtestMessagesSignal.value.error;
          if (err) reject(new Error(err));
          else if (backtestResultSignal.value) resolve(backtestResultSignal.value);
          else reject(new Error("run finished without a result (cancelled?)"));
        }));
        unsubs.push(() => ctx.signal.removeEventListener("abort", onAbort));
        const onAbort = () => { requestBacktestCancel(); };
        ctx.signal.addEventListener("abort", onAbort);

        if (backtestRunningSignal.value) {
          cleanup();
          reject(new Error("a backtest is already running"));
          return;
        }
        requestBacktestRun();
        // Guard: if nothing picks up the request (no chart focused), fail
        // instead of hanging forever.
        setTimeout(() => {
          if (!started) {
            cleanup();
            reject(new Error("run did not start (is a chart with a symbol open and focused?)"));
          }
        }, 5000);
      }),
  });

  registerAction({
    name: "backtest.cancel",
    description: "Cancel the in-flight single backtest run",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => { requestBacktestCancel(); return { requested: true }; },
  });

  registerAction({
    name: "backtest.result",
    description: "The currently displayed backtest result (metrics, trades, analysis; no candles). Null when none.",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => backtestResultSignal.value,
  });

  registerAction({
    name: "backtest.progress",
    description: "Live progress of the in-flight run (null when idle)",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => backtestProgressSignal.value,
  });
}
```

- [ ] **Step 4: Implement agent/index.ts and wire into App**

```typescript
// frontend/src/agent/index.ts
// Entry point: registers all action modules and starts the WS bridge when the
// build enables it (VITE_AGENT_BRIDGE=1; dev builds default on). Idempotent.
import { startAgentBridge } from "./bridge";
import { registerBacktestActions } from "./actions/backtest";

let initialized = false;

export function agentBridgeEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean> }).env ?? {};
  const flag = env.VITE_AGENT_BRIDGE;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return Boolean(env.DEV);
}

export function initAgentBridge(): void {
  if (initialized) return;
  initialized = true;
  registerBacktestActions();
  if (agentBridgeEnabled()) startAgentBridge();
}
```

In `App.tsx`, near the top of the component (module scope is fine too, but inside a `useEffect(() => initAgentBridge(), [])` keeps StrictMode double-invoke safe since `initAgentBridge` is idempotent):

```tsx
import { initAgentBridge } from "./agent";
// inside App():
useEffect(() => { initAgentBridge(); }, []);
```

- [ ] **Step 5: Run tests**

Run: `cd frontend && npx vitest run src/agent/`
Expected: all agent tests PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/agent/actions/backtest.ts frontend/src/agent/actions/backtest.test.ts frontend/src/agent/index.ts frontend/src/App.tsx
git commit -m "feat(agent): backtest workflow actions and bridge bootstrap"
```

---

### Task 8: Sweep actions + app-level actions (market/tab/panels) + dealing actions

**Files:**
- Create: `frontend/src/agent/actions/sweep.ts`
- Create: `frontend/src/agent/actions/dealing.ts`
- Modify: `frontend/src/App.tsx` (register app-level actions with access to `jumpToEpic`/tabs)
- Modify: `frontend/src/agent/index.ts` (register the new modules)
- Test: `frontend/src/agent/actions/sweep.test.ts`

**Interfaces:**
- Produces (sweep.ts): `registerSweepActions()` with
  - `sweep.start` (write, longRunning; args `{axes: array}` where axes match `lib/sweep`'s `SweepAxis[]`): sets `sweepAxesSignal`, bumps `requestBacktestRun()`, tracks `sweepStateSignal` for progress `{done, total, etaSeconds}`, resolves with `{rows, archivedId?}` when `running` flips false; rejects on `error`; abort -> `requestSweepCancel(true)`
  - `sweep.cancel` (write) -> `requestSweepCancel(true)`
  - `sweep.rows` (read) -> `sweepStateSignal.value?.rows ?? []`
- Produces (dealing.ts): `registerDealingActions()` with confirm-kind
  - `order.place` (args mirror `OrderRequest` from `lib/trading`: epic, side ("buy"|"sell"), quantity (number), type ("market"|"limit"), price?, stop?, takeProfit?) -> `placeOrder(...)`
  - `order.cancel` (args `{orderId: string}`) -> `cancelWorkingOrder(...)`
  - `position.close` (args `{dealId: string}`) -> `closePosition(...)`
  Open `frontend/src/lib/trading.ts` at the three functions (`placeOrder` ~line 351, `closePosition` ~line 574, `cancelWorkingOrder` ~line 758) and match their exact signatures (they may take an account argument: use `getTradesAccount()` from the same module for it).
- Produces (App.tsx): inline `registerAction` calls for
  - `market.select` (write; args `{epic: string, precision?: number}`) -> calls the existing `jumpToEpic(epic, precision ?? 2)`
  - `tab.list` (read) -> a plain summary of tabs/cells (id, symbol epic, active) derived from App's tab state
  - `panel.backtest.open` (write) -> `openBacktestSettings()`
  Registered inside a `useEffect(() => { ... }, [])` guarded by a module-level `let appActionsRegistered` flag (StrictMode runs effects twice). These have no unit tests (they close over App state); the e2e task covers them.
- Consumes: registry, signals (`sweepAxesSignal`, `sweepStateSignal`, `requestSweepCancel`, `sweepArchivedSignal`, `requestBacktestRun`), `lib/trading`.

- [ ] **Step 1: Write the failing sweep test**

```typescript
// frontend/src/agent/actions/sweep.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearRegistryForTest, invokeAction } from "../registry";
import { registerSweepActions } from "./sweep";
import {
  sweepAxesSignal, sweepStateSignal, backtestRunRequest,
} from "../../lib/signals";

const CTX = () => ({ progress: vi.fn(), signal: new AbortController().signal });

beforeEach(() => {
  clearRegistryForTest();
  sweepAxesSignal.set([]);
  sweepStateSignal.set(null);
  registerSweepActions();
});

describe("sweep actions", () => {
  it("sweep.start publishes axes, bumps the run request, resolves with rows", async () => {
    const axes = [{ param: "period", values: [5, 10] }] as any;
    const unsub = backtestRunRequest.subscribe(() => {
      expect(sweepAxesSignal.value).toEqual(axes);
      sweepStateSignal.set({ rows: [], done: 0, total: 2, running: true });
      setTimeout(() => {
        sweepStateSignal.set({ rows: [{ pnl: 1 } as any, { pnl: 2 } as any], done: 2, total: 2, running: false });
      }, 0);
    });
    const ctx = CTX();
    const res = (await invokeAction("sweep.start", { axes }, ctx)) as any;
    unsub();
    expect(res.rows).toHaveLength(2);
    expect(ctx.progress).toHaveBeenCalled();
  });

  it("sweep.start rejects when the sweep errors", async () => {
    const unsub = backtestRunRequest.subscribe(() => {
      sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true });
      setTimeout(() => {
        sweepStateSignal.set({ rows: [], done: 0, total: 1, running: false, error: "combo failed" });
      }, 0);
    });
    await expect(invokeAction("sweep.start", { axes: [{ param: "p", values: [1] }] }, CTX())).rejects.toThrow(/combo failed/);
    unsub();
  });

  it("sweep.rows reads the current rows", async () => {
    sweepStateSignal.set({ rows: [{ pnl: 9 } as any], done: 1, total: 1, running: false });
    const rows = (await invokeAction("sweep.rows", {}, CTX())) as any[];
    expect(rows[0].pnl).toBe(9);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement sweep.ts**

Run: `cd frontend && npx vitest run src/agent/actions/sweep.test.ts` -> FAIL, then:

```typescript
// frontend/src/agent/actions/sweep.ts
// Sweep actions: sweep.start reuses the exact production path (publish axes,
// bump the run request; BacktestButton branches into runSweep) and adapts
// sweepStateSignal into promise + progress for the bridge.
import { registerAction } from "../registry";
import {
  requestBacktestRun, requestSweepCancel, sweepAxesSignal, sweepStateSignal,
} from "../../lib/signals";
import type { SweepAxis } from "../../lib/sweep";

export function registerSweepActions(): void {
  registerAction({
    name: "sweep.start",
    description:
      "Start a parameter sweep with the current backtest config. axes: [{param, values}] (see lib/sweep SweepAxis). Long-running.",
    kind: "write",
    longRunning: true,
    params: {
      type: "object",
      properties: { axes: { type: "array", description: "SweepAxis[]" } },
      required: ["axes"],
    },
    handler: (args, ctx) =>
      new Promise((resolve, reject) => {
        let started = false;
        const unsub = sweepStateSignal.subscribe((st) => {
          if (!st) return;
          if (st.running) {
            started = true;
            ctx.progress({ done: st.done, total: st.total, etaSeconds: st.etaSeconds ?? null });
            return;
          }
          if (!started && st.rows.length === 0 && !st.error) return;
          unsub();
          ctx.signal.removeEventListener("abort", onAbort);
          if (st.error) reject(new Error(st.error));
          else if (st.cancelled) reject(new Error("sweep cancelled"));
          else resolve({ rows: st.rows });
        });
        const onAbort = () => requestSweepCancel(true);
        ctx.signal.addEventListener("abort", onAbort);
        sweepAxesSignal.set(args.axes as SweepAxis[]);
        requestBacktestRun();
        setTimeout(() => {
          if (!started) {
            unsub();
            reject(new Error("sweep did not start (is a chart with a symbol open and focused?)"));
          }
        }, 5000);
      }),
  });

  registerAction({
    name: "sweep.cancel",
    description: "Cancel the in-flight sweep (kills the server job)",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => { requestSweepCancel(true); return { requested: true }; },
  });

  registerAction({
    name: "sweep.rows",
    description: "Rows of the current/last sweep this session (empty when none)",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => sweepStateSignal.value?.rows ?? [],
  });
}
```

Run the test again: PASS.

- [ ] **Step 3: Implement dealing.ts**

First read the real signatures: `sed -n '340,380p;565,600p;750,790p' frontend/src/lib/trading.ts`. Then, adapting arg names to what you find (the shape below assumes `placeOrder(req: OrderRequest)` where OrderRequest carries epic/side/quantity/type/price/stop/takeProfit and the account comes from `getTradesAccount()` internally — adjust to reality, do not force this shape):

```typescript
// frontend/src/agent/actions/dealing.ts
// Confirm-gated dealing actions. The registry kind "confirm" means bridge.ts
// parks execution on an in-browser Approve click (agent/confirm.ts); these
// handlers only run after approval.
import { registerAction } from "../registry";
import { placeOrder, closePosition, cancelWorkingOrder } from "../../lib/trading";

export function registerDealingActions(): void {
  registerAction({
    name: "order.place",
    description: "Place an order (requires in-browser approval)",
    kind: "confirm",
    params: {
      type: "object",
      properties: {
        epic: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number" },
        type: { type: "string", enum: ["market", "limit"] },
        price: { type: "number", description: "limit level (limit orders only)" },
        stop: { type: "number" },
        takeProfit: { type: "number" },
      },
      required: ["epic", "side", "quantity", "type"],
    },
    handler: async (args) => placeOrder(args as never),
  });

  registerAction({
    name: "position.close",
    description: "Close an open position (requires in-browser approval)",
    kind: "confirm",
    params: {
      type: "object",
      properties: { dealId: { type: "string" } },
      required: ["dealId"],
    },
    handler: async (args) => closePosition(args.dealId as never),
  });

  registerAction({
    name: "order.cancel",
    description: "Cancel a resting working order (requires in-browser approval)",
    kind: "confirm",
    params: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
    handler: async (args) => cancelWorkingOrder(args.orderId as never),
  });
}
```

Replace the `as never` casts with the real parameter shapes once read from trading.ts (this is a must-do, not optional; the casts are stand-ins in this plan only because signatures beyond `placeOrder(req: OrderRequest)` weren't verified at planning time).

- [ ] **Step 4: Register app-level actions in App.tsx**

Inside `App()`, after `jumpToEpic` is defined (~line 835), add:

```tsx
// Agent bridge: actions that need App's handlers (tabs, symbol jump). Module
// flag guards StrictMode's double effect run and HMR re-registration.
useEffect(() => {
  if (appAgentActionsRegistered) return;
  appAgentActionsRegistered = true;
  registerAction({
    name: "market.select",
    description: "Focus (or open) a chart tab showing this epic",
    kind: "write",
    params: {
      type: "object",
      properties: {
        epic: { type: "string" },
        precision: { type: "number", description: "price precision guess, default 2" },
      },
      required: ["epic"],
    },
    handler: async (args) => jumpToEpic(args.epic as string, (args.precision as number) ?? 2),
  });
  registerAction({
    name: "panel.backtest.open",
    description: "Open the backtest settings panel",
    kind: "write",
    params: { type: "object", properties: {} },
    handler: async () => { openBacktestSettings(); return { opened: true }; },
  });
}, []);
```

with `let appAgentActionsRegistered = false;` at module scope in App.tsx and imports for `registerAction` (from `./agent/registry`) and `openBacktestSettings` (already imported in App or from `./lib/signals`). Also add a `tab.list` action there if App's tab state is easily serializable (id, cells' epics, active flag); skip it if the tab structure isn't accessible at that point and note the skip in the commit message.

Then in `agent/index.ts`, register the new modules:

```typescript
import { registerSweepActions } from "./actions/sweep";
import { registerDealingActions } from "./actions/dealing";
// inside initAgentBridge(), after registerBacktestActions():
registerSweepActions();
registerDealingActions();
```

- [ ] **Step 5: Run all agent tests + typecheck**

Run: `cd frontend && npx vitest run src/agent/ && npx tsc -b --noEmit 2>&1 | head -20`
Expected: PASS, no new type errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/agent frontend/src/App.tsx
git commit -m "feat(agent): sweep, dealing (confirm-gated), and app-level actions"
```

---

### Task 9: End-to-end probe script + docs

**Files:**
- Create: `backend/scripts/agent_bridge_probe.py`
- Modify: `CLAUDE.md` (add a short "Agent UI Bridge" section)

**Interfaces:**
- Consumes: the running system (backend on :8000 with a browser tab open on :5173).
- Produces: a CLI that exercises the full path: list sessions -> manifest -> `backtest.config.get` -> optionally `backtest.run` + `ui_wait`.

- [ ] **Step 1: Write the probe script**

```python
# backend/scripts/agent_bridge_probe.py
"""End-to-end probe for the Agent UI Bridge.

Prereqs: backend running (uvicorn auto_trader.api.app:app --port 8000) and the
frontend open in a browser (npm run dev, http://localhost:5173) so a tab is
connected. Run:  python -m scripts.agent_bridge_probe [--run]

Uses the MCP python client over streamable HTTP against /mcp.
"""
from __future__ import annotations

import argparse
import asyncio
import json

# v2 client imports; if these fail on the installed mcp version, check the
# client quickstart in the SDK docs (streamablehttp_client + ClientSession in 1.x).
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = "http://localhost:8000/mcp"


async def main(run: bool) -> None:
    async with streamablehttp_client(URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            def show(name: str, res) -> None:
                print(f"\n== {name} ==")
                for item in res.content:
                    print(item.text if hasattr(item, "text") else item)

            show("ui_sessions", await session.call_tool("ui_sessions", {}))
            show("ui_actions", await session.call_tool("ui_actions", {}))
            show("backtest.config.get", await session.call_tool(
                "ui_read_state", {"key": "backtest.config.get"}))

            if run:
                res = await session.call_tool("ui_invoke", {"action": "backtest.run", "args": {}})
                handle = json.loads(res.content[0].text)["handle"]
                print(f"\nrun started, handle={handle}")
                while True:
                    st = json.loads((await session.call_tool(
                        "ui_wait", {"handle": handle, "timeout_s": 10})).content[0].text)
                    print("status:", st.get("status"), "progress:", st.get("progress"))
                    if st["status"] != "running":
                        break
                print("final:", json.dumps(st, indent=2)[:2000])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="also trigger backtest.run")
    asyncio.run(main(ap.parse_args().run))
```

- [ ] **Step 2: Verify end-to-end manually**

1. `cd backend && uvicorn auto_trader.api.app:app --reload --port 8000`
2. `cd frontend && npm run dev`, open http://localhost:5173, open a chart with a symbol.
3. `cd backend && python -m scripts.agent_bridge_probe` -> expect one session, a manifest containing `backtest.run`, `market.select`, `order.place`, and a config dump.
4. `python -m scripts.agent_bridge_probe --run` -> expect progress lines then a result with metrics, and the run visibly appearing in the browser panel.
5. Confirm-gate check: call `ui_invoke` with `order.place` via the probe (edit locally or use an MCP client) and verify the Approve/Reject modal appears in the browser and Reject returns a REJECTED error.

Record actual outputs; if anything fails, fix before committing (superpowers:verification-before-completion applies).

- [ ] **Step 3: Document in CLAUDE.md**

Append:

```markdown
## Agent UI Bridge

MCP agents can drive the running UI: connect to `http://localhost:8000/mcp`
(streamable HTTP). Tools: `ui_sessions`, `ui_actions` (self-describing
manifest), `ui_invoke`, `ui_wait`, `ui_read_state`. Requires the app open in a
browser (the bridge executes actions in the live tab); no tab connected gives a
clear error. Dealing actions (`order.place`, `position.close`, `order.cancel`)
require an in-browser Approve click. The frontend bridge is on in dev builds
and off in production unless `VITE_AGENT_BRIDGE=1`. End-to-end probe:
`cd backend && python -m scripts.agent_bridge_probe [--run]`.
```

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/agent_bridge_probe.py CLAUDE.md
git commit -m "feat(agent): e2e probe script and bridge docs"
```

---

### Task 10: Playwright smoke test for the bridge connection

**Files:**
- Create: `frontend/e2e/agent-bridge.spec.ts`

**Interfaces:**
- Consumes: the existing e2e harness (`frontend/e2e/helpers.ts` — read it first to see how specs boot the app and whether a real backend runs on :8000/:5199) and `GET /api/agent/sessions`.

- [ ] **Step 1: Read the harness, then write the spec**

Open `frontend/e2e/helpers.ts` and one existing spec (e.g. `candle-cache-stats.spec.ts`) to learn the boot pattern and backend base URL used in e2e. Then:

```typescript
// frontend/e2e/agent-bridge.spec.ts
// The app tab connects to /ws/agent-ui on load (dev/e2e builds enable the
// bridge), and the backend lists it as a session. Full action round-trips are
// covered by backend tests + the probe script; this guards the wiring.
import { test, expect } from "@playwright/test";
// adapt: import whatever boot helper the sibling specs use from "./helpers"

test("agent bridge registers a session", async ({ page, request }) => {
  // adapt: boot/goto the app the same way sibling specs do
  await page.goto("/");
  await expect
    .poll(async () => {
      const res = await request.get("http://localhost:8000/api/agent/sessions");
      const body = await res.json();
      return body.sessions.length;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
});
```

Adapt the base URLs/boot to the harness conventions found in step 1 (if e2e runs against a mocked backend with no real :8000, mark the spec `test.skip` with a comment pointing at the probe script, and say so in the commit message).

- [ ] **Step 2: Run it**

Run: `cd frontend && npx playwright test e2e/agent-bridge.spec.ts` (with backend + dev server running, per the harness's requirements).
Expected: PASS (or documented skip)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/agent-bridge.spec.ts
git commit -m "test(agent): e2e smoke for bridge session registration"
```

---

## Self-review notes

- Spec coverage: architecture (Tasks 1-6), action surface (Tasks 7-8: backtest loop, sweep, market/panel, confirm-gated dealing; walk-forward/holdout/indicator/UI-chrome actions are follow-up registrations on the same registry — the spec's "registry growth rule"), safety (guard middleware covers /mcp and /ws/agent-ui by construction: Task 6 Step 5 note; enablement flag: Task 7), errors (schema echo: Tasks 1/3/4/6; no-tab: Task 4; disconnect: Task 4), testing (unit FE: 1-3, 7-8; backend: 4-6; e2e: 9-10).
- Deliberately deferred from v1 (registry growth, not plan gaps): `walkforward.*`, `holdout.evaluate`, `indicator.*`, `layout.set`, `tab.open/close`, `sweep.archive` (archiving already happens automatically on completion in BacktestButton), `mt5.deploy.*`, derived sweep analytics (`plateau`/`labels` readers). Each is one `registerAction` following Task 7/8 patterns.
- Type consistency check: frame shapes match between bridge.ts (Task 3) and agent_bridge.py (Task 4) — `{id, op, action, args}` in, `{id, ok, result|handle|error{code,message,expectedSchema}}` and `{handle, event, payload}` out. `ui_wait` returns `{status, progress, result?, error?}` in both Task 4 and Task 6.
