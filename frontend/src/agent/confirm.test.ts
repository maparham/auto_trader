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

  // Abort is the money-safety path: the invocation has already been reported to
  // the agent as failed, so the dialog must not stay live and approvable.
  it("aborting while pending resolves false and clears the pending state", async () => {
    const ctl = new AbortController();
    const p = requestAgentConfirm({
      action: "order.place", description: "d", args: {}, signal: ctl.signal,
    });
    expect(agentConfirmSignal.value?.action).toBe("order.place");
    ctl.abort();
    await expect(p).resolves.toBe(false);
    expect(agentConfirmSignal.value).toBeNull();
    // Cleared, not merely resolved: the gate accepts a fresh request, and a
    // late Approve for the abandoned one lands on nothing.
    resolveAgentConfirm(true);
    const p2 = requestAgentConfirm({ action: "next", description: "d", args: {} });
    expect(agentConfirmSignal.value?.action).toBe("next");
    resolveAgentConfirm(true);
    await expect(p2).resolves.toBe(true);
  });

  it("an already-aborted signal never opens a dialog", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const p = requestAgentConfirm({
      action: "order.place", description: "d", args: {}, signal: ctl.signal,
    });
    await expect(p).resolves.toBe(false);
    expect(agentConfirmSignal.value).toBeNull();
  });

  it("a settled request's signal aborting later does not reject the next dialog", async () => {
    const ctl = new AbortController();
    const p1 = requestAgentConfirm({
      action: "first", description: "d", args: {}, signal: ctl.signal,
    });
    resolveAgentConfirm(true);
    await expect(p1).resolves.toBe(true);

    const p2 = requestAgentConfirm({ action: "second", description: "d", args: {} });
    ctl.abort(); // the *first* invocation's controller
    expect(agentConfirmSignal.value?.action).toBe("second");
    resolveAgentConfirm(true);
    await expect(p2).resolves.toBe(true);
  });

  it("rejects a second concurrent request immediately", async () => {
    const p1 = requestAgentConfirm({ action: "a", description: "d", args: {} });
    const p2 = requestAgentConfirm({ action: "b", description: "d", args: {} });
    await expect(p2).resolves.toBe(false);
    resolveAgentConfirm(true);
    await expect(p1).resolves.toBe(true);
  });
});
