import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();
const { save } = await import("./core");

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
