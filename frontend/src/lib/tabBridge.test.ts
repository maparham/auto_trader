// frontend/src/lib/tabBridge.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  probeTabBridge, tabBridgeScreenshot, tabBridgeFocus, TabBridgeError, resetTabBridgeForTest,
} from "./tabBridge";

type Frame = { ns: string; dir: string; id: string; op?: string; args?: unknown };

// A fake extension: answers every "req" frame posted on this window.
function installFakeExtension(answer: (f: Frame) => object | null) {
  const handler = (e: MessageEvent) => {
    const f = e.data as Frame;
    if (!f || f.ns !== "tab-bridge" || f.dir !== "req") return;
    const res = answer(f);
    if (res) window.postMessage({ ns: "tab-bridge", dir: "res", id: f.id, ...res }, "*");
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

describe("tabBridge", () => {
  let uninstall: (() => void) | null = null;
  beforeEach(() => { resetTabBridgeForTest(); vi.useFakeTimers(); });
  afterEach(() => { uninstall?.(); uninstall = null; vi.useRealTimers(); });

  it("probe resolves to the hello result and caches it", async () => {
    let hellos = 0;
    uninstall = installFakeExtension((f) => {
      if (f.op === "hello") { hellos++; return { ok: true, result: { version: "1.0.0", ops: ["screenshot", "focus"] } }; }
      return null;
    });
    const p = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ version: "1.0.0", ops: ["screenshot", "focus"] });
    const again = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await again).toEqual({ version: "1.0.0", ops: ["screenshot", "focus"] });
    expect(hellos).toBe(1);
  });

  it("probe resolves null after 300ms with no extension, and re-probes next time", async () => {
    const p = probeTabBridge();
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBeNull();
    uninstall = installFakeExtension(() => ({ ok: true, result: { version: "1.0.0", ops: [] } }));
    const p2 = probeTabBridge();
    await vi.runAllTimersAsync();
    expect(await p2).toEqual({ version: "1.0.0", ops: [] });
  });

  it("screenshot forwards args and resolves the matching reply only", async () => {
    let seen: Frame | null = null;
    uninstall = installFakeExtension((f) => {
      if (f.op !== "screenshot") return null;
      seen = f;
      // A stray reply with another id must be ignored:
      window.postMessage({ ns: "tab-bridge", dir: "res", id: "nope", ok: true, result: { mime: "x" } }, "*");
      return { ok: true, result: { mime: "image/png", image_base64: "QUJD", width: 10, height: 5 } };
    });
    const p = tabBridgeScreenshot({ clip: { x: 1, y: 2, width: 10, height: 5 }, scale: 2, format: "png" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ mime: "image/png", image_base64: "QUJD", width: 10, height: 5 });
    expect(seen!.args).toEqual({ clip: { x: 1, y: 2, width: 10, height: 5 }, scale: 2, format: "png" });
  });

  it("screenshot rejects with the extension's error code", async () => {
    uninstall = installFakeExtension(() => ({ ok: false, error: { code: "DEBUGGER_BUSY", message: "devtools open" } }));
    const p = tabBridgeScreenshot({});
    await vi.runAllTimersAsync();
    await expect(p).rejects.toMatchObject({ code: "DEBUGGER_BUSY" });
    await expect(p).rejects.toBeInstanceOf(TabBridgeError);
  });

  it("screenshot times out after 10s as EXTENSION_TIMEOUT", async () => {
    const p = tabBridgeScreenshot({});
    const assertion = expect(p).rejects.toMatchObject({ code: "EXTENSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("ignores frames with the wrong namespace or direction", async () => {
    uninstall = installFakeExtension((f) => {
      window.postMessage({ ns: "other", dir: "res", id: f.id, ok: true, result: { focused: true } }, "*");
      window.postMessage({ ns: "tab-bridge", dir: "req", id: f.id, ok: true, result: { focused: true } }, "*");
      return null;
    });
    const p = tabBridgeFocus();
    const assertion = expect(p).rejects.toMatchObject({ code: "EXTENSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
