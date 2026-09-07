import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const { reportView, viewKey, flushViewHeartbeat } = await import("./viewHeartbeat");
import type { Instrument } from "./feed";

const SYM: Instrument = { epic: "US100", name: "US 100", status: "TRADEABLE" };
const BASE = {
  scope: "tab.t1.cell.c1", epic: "US100", broker: "capital",
  resolution: "MINUTE_5", symbol: SYM, barSpace: 8, width: 1280, height: 640,
};

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

const stored = () =>
  JSON.parse(localStorage.getItem(viewKey("capital", "US100")) ?? "null");

describe("reportView", () => {
  it("keys under the exact backend-consumed format", () => {
    // Tasks 4/5 (backend snapshot reconstruction) read this literal key format —
    // pin it so a brokerRoot() refactor can't silently break the contract.
    expect(viewKey("capital", "US100")).toBe("auto-trader.b.capital.view.US100");
  });

  it("flush writes pending views immediately", () => {
    reportView(BASE);
    flushViewHeartbeat();
    expect(stored()).not.toBeNull();
  });

  it("writes the descriptor under the per-broker view key after the debounce", () => {
    reportView(BASE);
    expect(stored()).toBeNull(); // not yet — debounced
    vi.advanceTimersByTime(2100);
    expect(stored()).toMatchObject({ scope: "tab.t1.cell.c1", resolution: "MINUTE_5" });
    expect(typeof stored().updatedAt).toBe("number");
  });

  it("coalesces rapid updates to the last one", () => {
    reportView(BASE);
    reportView({ ...BASE, resolution: "HOUR" });
    vi.advanceTimersByTime(2100);
    expect(stored().resolution).toBe("HOUR");
  });

  it("keys per (broker, epic) independently", () => {
    reportView(BASE);
    reportView({ ...BASE, epic: "EURUSD" });
    vi.advanceTimersByTime(2100);
    expect(stored()).not.toBeNull();
    expect(localStorage.getItem(viewKey("capital", "EURUSD"))).not.toBeNull();
  });

  it("prunes to the 30 most-recently-updated heartbeats per broker", () => {
    for (let i = 0; i < 35; i++) {
      vi.setSystemTime(i * 1000);
      reportView({ ...BASE, epic: `E${i}` });
      vi.advanceTimersByTime(2100); // commit this one before the next report
    }
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith("auto-trader.b.capital.view."),
    );
    expect(keys.length).toBe(30);
    // Oldest 5 (E0..E4) pruned, newest 30 (E5..E34) kept.
    for (let i = 0; i < 5; i++) {
      expect(localStorage.getItem(viewKey("capital", `E${i}`))).toBeNull();
    }
    for (let i = 5; i < 35; i++) {
      expect(localStorage.getItem(viewKey("capital", `E${i}`))).not.toBeNull();
    }
  });
});
