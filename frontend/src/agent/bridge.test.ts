import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleFrame, startAgentBridge } from "./bridge";
import { registerAction, clearRegistryForTest } from "./registry";

vi.mock("./confirm");

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

  it("stop() aborts in-flight long-running invocations", async () => {
    // A stub socket: startAgentBridge must not dial a real relay from a test.
    class StubSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      closed = false;
      close() { this.closed = true; this.onclose?.(); }
    }
    const prev = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = StubSocket;
    try {
      let aborted = false;
      registerAction({
        name: "hang", description: "d", kind: "write", longRunning: true,
        params: { type: "object", properties: {} },
        handler: (_a, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => { aborted = true; resolve("stopped"); });
          }),
      });
      const stop = startAgentBridge("ws://stub/ws");
      const c = collector();
      await handleFrame({ id: "10", op: "invoke", action: "hang", args: {} }, c.send);
      stop();
      await new Promise((r) => setTimeout(r, 0));
      expect(aborted).toBe(true);
      // Drained: a later abort frame finds no controller for the handle.
      await handleFrame({ id: "11", op: "abort", handle: "10" }, c.send);
      expect(c.sent.find((f) => f.id === "11")?.result).toEqual({ aborted: false });
    } finally {
      (globalThis as any).WebSocket = prev;
    }
  });

  // Confirm-kind actions always ack a handle first (see bridge.ts): the dialog
  // can outlive the backend's 30s relay timeout, and on the fast path a later
  // Approve would execute an order the agent had already been told failed.
  it("confirm-kind action: acks a handle, then done on approve", async () => {
    const { requestAgentConfirm } = await import("./confirm");
    vi.mocked(requestAgentConfirm).mockResolvedValue(true);

    registerAction({
      name: "approve_action", description: "d", kind: "confirm",
      params: { type: "object", properties: {} },
      handler: async () => ({ approved: true }),
    });
    const c = collector();
    await handleFrame({ id: "8", op: "invoke", action: "approve_action", args: {} }, c.send);
    expect(c.sent[0]).toEqual({ id: "8", ok: true, handle: "8" });
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(requestAgentConfirm)).toHaveBeenCalledWith({
      action: "approve_action", description: "d", args: {},
      warning: null,
      signal: expect.any(AbortSignal),
    });
    expect(c.sent[1]).toEqual({ handle: "8", event: "done", payload: { approved: true } });
  });

  it("confirm-kind action: confirmContext is shown in the dialog but not passed to the handler", async () => {
    const { requestAgentConfirm } = await import("./confirm");
    vi.mocked(requestAgentConfirm).mockResolvedValue(true);

    let seen: Record<string, unknown> | null = null;
    registerAction({
      name: "ctx_action", description: "d", kind: "confirm",
      params: { type: "object", properties: { epic: { type: "string" } }, required: ["epic"] },
      confirmContext: () => ({ account: "capital:paper" }),
      handler: async (args) => { seen = args; return { ok: 1 }; },
    });
    const c = collector();
    await handleFrame({ id: "12", op: "invoke", action: "ctx_action", args: { epic: "US100" } }, c.send);
    await new Promise((r) => setTimeout(r, 0));

    // The dialog sees the resolved context alongside the agent's args...
    expect(vi.mocked(requestAgentConfirm)).toHaveBeenCalledWith({
      action: "ctx_action", description: "d",
      args: { epic: "US100", account: "capital:paper" },
      warning: null,
      signal: expect.any(AbortSignal),
    });
    // ...but the handler receives only the validated args (an unknown key would
    // otherwise be an INVALID_ARGS-shaped surprise inside the handler).
    expect(seen).toEqual({ epic: "US100" });
    expect(c.sent[0]).toEqual({ id: "12", ok: true, handle: "12" });
    expect(c.sent[1]).toEqual({ handle: "12", event: "done", payload: { ok: 1 } });
  });

  // confirmWarning is the other half of confirmContext: a fact resolved at gate
  // time that the DIALOG shows and the handler never sees. It exists for state
  // that changes what approving means without changing the args at all — a real
  // order requested while the user is watching a replay session.
  it("confirm-kind action: confirmWarning reaches the dialog and not the handler", async () => {
    const { requestAgentConfirm } = await import("./confirm");
    vi.mocked(requestAgentConfirm).mockResolvedValue(true);

    let seen: Record<string, unknown> | null = null;
    registerAction({
      name: "warn_action", description: "d", kind: "confirm",
      params: { type: "object", properties: { epic: { type: "string" } }, required: ["epic"] },
      confirmWarning: () => "this is REAL",
      handler: async (args) => { seen = args; return { ok: 1 }; },
    });
    const c = collector();
    await handleFrame({ id: "13", op: "invoke", action: "warn_action", args: { epic: "US100" } }, c.send);
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(requestAgentConfirm)).toHaveBeenCalledWith({
      action: "warn_action", description: "d",
      args: { epic: "US100" },
      warning: "this is REAL",
      signal: expect.any(AbortSignal),
    });
    expect(seen).toEqual({ epic: "US100" });
  });

  it("confirm-kind action: reject path does not run handler", async () => {
    const { requestAgentConfirm } = await import("./confirm");
    vi.mocked(requestAgentConfirm).mockResolvedValue(false);

    let handlerRan = false;
    registerAction({
      name: "reject_action", description: "d", kind: "confirm",
      params: { type: "object", properties: {} },
      handler: async () => { handlerRan = true; return {}; },
    });
    const c = collector();
    await handleFrame({ id: "9", op: "invoke", action: "reject_action", args: {} }, c.send);
    expect(c.sent[0]).toEqual({ id: "9", ok: true, handle: "9" });
    await new Promise((r) => setTimeout(r, 0));
    expect(handlerRan).toBe(false);
    expect(c.sent[1]).toEqual({
      handle: "9", event: "error",
      payload: { code: "REJECTED", message: "user rejected or confirm timed out" },
    });
  });

  it("abort dismisses a pending confirm dialog: a late approve cannot run the handler", async () => {
    // The real gate, reached through the module mock, so this exercises the
    // actual abort wiring rather than a stubbed promise.
    const { requestAgentConfirm } = await import("./confirm");
    const actual = await vi.importActual<typeof import("./confirm")>("./confirm");
    vi.mocked(requestAgentConfirm).mockImplementation(actual.requestAgentConfirm);

    let handlerRan = false;
    registerAction({
      name: "order.place", description: "d", kind: "confirm",
      params: { type: "object", properties: {} },
      handler: async () => { handlerRan = true; return { dealId: "x" }; },
    });
    const c = collector();
    await handleFrame({ id: "15", op: "invoke", action: "order.place", args: {} }, c.send);
    expect(c.sent[0]).toEqual({ id: "15", ok: true, handle: "15" });
    await new Promise((r) => setTimeout(r, 0));
    expect(actual.agentConfirmSignal.value?.action).toBe("order.place");

    await handleFrame({ id: "16", op: "abort", handle: "15" }, c.send);
    await new Promise((r) => setTimeout(r, 0));

    // Dialog gone, invocation reported as failed...
    expect(actual.agentConfirmSignal.value).toBeNull();
    expect(c.sent.find((f) => f.handle === "15" && f.event === "error")?.payload.code)
      .toBe("REJECTED");
    // ...and a late Approve lands on nothing: no order is placed.
    actual.resolveAgentConfirm(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(handlerRan).toBe(false);
  });

  // ui_read_state sets readOnly on the frame; the tab is what enforces it.
  it("readOnly frame refuses a non-read action before running anything", async () => {
    let handlerRan = false;
    registerAction({
      name: "dealing.order", description: "d", kind: "confirm",
      params: { type: "object", properties: {} },
      handler: async () => { handlerRan = true; return {}; },
    });
    const c = collector();
    await handleFrame(
      { id: "13", op: "invoke", action: "dealing.order", args: {}, readOnly: true },
      c.send,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(handlerRan).toBe(false);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].ok).toBe(false);
    expect(c.sent[0].error.code).toBe("NOT_READ_ACTION");
  });

  it("readOnly frame runs a read-kind action normally", async () => {
    registerAction({
      name: "backtest.result", description: "d", kind: "read",
      params: { type: "object", properties: {} },
      handler: async () => ({ pnl: 1 }),
    });
    const c = collector();
    await handleFrame(
      { id: "14", op: "invoke", action: "backtest.result", args: {}, readOnly: true },
      c.send,
    );
    expect(c.sent[0]).toEqual({ id: "14", ok: true, result: { pnl: 1 } });
  });
});
