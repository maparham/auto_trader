import { describe, expect, it, vi, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

describe("demo mode persistence lockdown", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("flag is one-way and default off", async () => {
    const { isDemoMode, setDemoMode } = await import("./demoMode");
    expect(isDemoMode()).toBe(false);
    setDemoMode();
    expect(isDemoMode()).toBe(true);
  });

  it("save() writes localStorage but never fetches in demo mode", async () => {
    const { setDemoMode } = await import("./demoMode");
    setDemoMode();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { save, hydrateFromBackend } = await import("./persist/core");
    await hydrateFromBackend(); // would normally enable mirroring
    save("auto-trader.test-key", { a: 1 });
    expect(localStorage.getItem("auto-trader.test-key")).toBe('{"a":1}');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hydrateFromBackend resolves false without fetching in demo mode", async () => {
    const { setDemoMode } = await import("./demoMode");
    setDemoMode();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { hydrateFromBackend } = await import("./persist/core");
    await expect(hydrateFromBackend()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
