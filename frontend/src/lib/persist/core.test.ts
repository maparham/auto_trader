import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();
const { save, sessionGet, sessionSet, sessionRemove } = await import("./core");

beforeEach(() => localStorage.clear());

describe("save()", () => {
  it("returns true and writes on success", () => {
    expect(save("auto-trader.k", { a: 1 })).toBe(true);
    expect(localStorage.getItem("auto-trader.k")).toBe('{"a":1}');
  });

  it("returns false when setItem throws (quota) and does not throw", () => {
    const orig = localStorage.setItem.bind(localStorage);
    // Simulate a quota-exceeded write.
    localStorage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(save("auto-trader.big", { a: 1 })).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      localStorage.setItem = orig;
    }
  });
});

describe("session storage primitives", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("sessionGet/sessionSet round-trip raw strings in sessionStorage only", () => {
    expect(sessionGet("k")).toBeNull();
    sessionSet("k", "v1");
    expect(sessionGet("k")).toBe("v1");
    expect(localStorage.getItem("k")).toBeNull(); // never touches localStorage
  });

  it("sessionRemove deletes the key", () => {
    sessionSet("k", "v1");
    sessionRemove("k");
    expect(sessionGet("k")).toBeNull();
  });
});

describe("persistBroker init reads the per-tab session account first", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("session activeAccount wins over the localStorage seed", async () => {
    localStorage.setItem("activeAccount", "capital:paper");
    sessionStorage.setItem("activeAccount", "ig-demo:paper");
    vi.resetModules();
    const core = await import("./core");
    expect(core.getPersistBroker()).toBe("ig-demo");
  });

  it("falls back to the localStorage seed, then the default", async () => {
    localStorage.setItem("activeAccount", "ig-live:live");
    vi.resetModules();
    let core = await import("./core");
    expect(core.getPersistBroker()).toBe("ig-live");

    localStorage.clear();
    vi.resetModules();
    core = await import("./core");
    expect(core.getPersistBroker()).toBe("capital");
  });
});
