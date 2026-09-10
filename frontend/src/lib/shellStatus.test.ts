// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { liveStateSignal } from "./liveController";
import { startShellStatusMirror } from "./shellStatus";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
});

function withShell(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn().mockResolvedValue(null);
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
  return invoke;
}

describe("shell status mirror", () => {
  it("never calls into the shell when it was absent at start", () => {
    // Started in a plain browser: the mirror must stay inert for good, even if a
    // shell global appears later. Nothing but a callable unsubscribe comes back.
    const stop = startShellStatusMirror();
    const invoke = withShell();
    liveStateSignal.set({ ...liveStateSignal.value, status: "armed" });
    expect(invoke).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("maps armed to live, lost-lease to error and disarmed to idle", () => {
    const invoke = withShell();
    const stop = startShellStatusMirror();
    liveStateSignal.set({ ...liveStateSignal.value, status: "armed" });
    liveStateSignal.set({ ...liveStateSignal.value, status: "lost-lease" });
    liveStateSignal.set({ ...liveStateSignal.value, status: "disarmed" });
    stop();
    expect(invoke.mock.calls.map((c) => (c[1] as { state: string }).state)).toEqual([
      "live",
      "error",
      "idle",
    ]);
    expect(invoke.mock.calls.every((c) => c[0] === "set_status")).toBe(true);
  });

  it("does not re-send an unchanged status", () => {
    const invoke = withShell();
    const stop = startShellStatusMirror();
    liveStateSignal.set({ ...liveStateSignal.value, status: "armed" });
    liveStateSignal.set({ ...liveStateSignal.value, status: "armed", quantity: 2 });
    stop();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
