// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { inAndroidApp, inShell, shellInvoke } from "./shellBridge";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
});

describe("shellBridge", () => {
  it("reports not-in-shell in a plain browser", () => {
    expect(inShell()).toBe(false);
  });

  it("resolves to null in a plain browser instead of throwing", async () => {
    await expect(shellInvoke("ping")).resolves.toBeNull();
  });

  it("forwards to the Tauri invoke when the shell is present", async () => {
    const invoke = vi.fn().mockResolvedValue("pong");
    (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
    expect(inShell()).toBe(true);
    await expect(shellInvoke("ping")).resolves.toBe("pong");
    expect(invoke).toHaveBeenCalledWith("ping", undefined);
  });

  it("swallows a rejecting invoke so callers never need a try block", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("nope"));
    (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
    await expect(shellInvoke("ping")).resolves.toBeNull();
  });
});

function ua(value: string) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: value });
}

it("is true only inside a Tauri webview on Android", () => {
  const w = window as unknown as Record<string, unknown>;
  ua("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36");
  expect(inAndroidApp()).toBe(false); // Android Chrome, no shell
  w.__TAURI__ = { core: {} };
  expect(inAndroidApp()).toBe(true);
  ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  expect(inAndroidApp()).toBe(false); // desktop shell
});
