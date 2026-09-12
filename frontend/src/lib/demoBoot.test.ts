// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldShowSignIn } from "./demoBoot";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  vi.resetModules();
  vi.doUnmock("./demoMode");
  vi.doUnmock("./demoSnapshot");
});

describe("shouldShowSignIn", () => {
  it("false for a plain visit (demo renders)", () => {
    expect(shouldShowSignIn("")).toBe(false);
  });
  it("true for ?sign_in=1", () => {
    expect(shouldShowSignIn("?sign_in=1")).toBe(true);
  });
  it("true inside the native shell even without ?sign_in=1", () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: () => {} } };
    expect(shouldShowSignIn("")).toBe(true);
  });
});

