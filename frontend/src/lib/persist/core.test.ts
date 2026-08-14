import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("subscribeToBackendUpdates", () => {
  // Minimal WebSocket stand-in: captures the instance so tests can drive
  // onmessage directly. subscribeToBackendUpdates only assigns handlers.
  class FakeWS {
    static last: FakeWS | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeWS.last = this;
    }
    close() {}
  }

  const push = (msg: unknown) => FakeWS.last!.onmessage!({ data: JSON.stringify(msg) });

  let unsubscribe: (() => void) | null = null;
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWS);
    localStorage.clear();
  });
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    vi.unstubAllGlobals();
    FakeWS.last = null;
  });

  it("applies a foreign upsert to localStorage and notifies onChange", async () => {
    const { subscribeToBackendUpdates } = await import("./core");
    const seen: string[] = [];
    unsubscribe = subscribeToBackendUpdates((k) => seen.push(k));
    push({ key: "auto-trader.tab.A.backtest.US100", value: { a: 1 }, origin: "other-tab" });
    expect(localStorage.getItem("auto-trader.tab.A.backtest.US100")).toBe('{"a":1}');
    expect(seen).toEqual(["auto-trader.tab.A.backtest.US100"]);
  });

  it("notifies even when the pushed bytes match localStorage (same-browser tabs)", async () => {
    // Two tabs in the SAME browser share localStorage: the sibling's save() has
    // already written these exact bytes before its push arrives, so the
    // notification is the only signal telling this tab to re-sync its React
    // state/overlays to storage. It must fire regardless of byte equality —
    // suppressing "unchanged" pushes silently disables same-browser sync.
    const { subscribeToBackendUpdates } = await import("./core");
    localStorage.setItem("auto-trader.tab.A.drawings.US100", '{"a":1}');
    const seen: string[] = [];
    unsubscribe = subscribeToBackendUpdates((k) => seen.push(k));
    push({ key: "auto-trader.tab.A.drawings.US100", value: { a: 1 }, origin: "other-tab" });
    expect(seen).toEqual(["auto-trader.tab.A.drawings.US100"]);
  });

  it("notifies for deletions, including of a key this tab no longer holds", async () => {
    // Same-browser reasoning as above: a sibling's removeKeyEverywhere already
    // cleared the shared localStorage, so the pushed delete looks like a no-op
    // here — but this tab's UI still has to react to it.
    const { subscribeToBackendUpdates } = await import("./core");
    const seen: string[] = [];
    unsubscribe = subscribeToBackendUpdates((k) => seen.push(k));
    push({ key: "auto-trader.tab.A.drawings.US100", deleted: true, origin: "other-tab" });
    expect(seen).toEqual(["auto-trader.tab.A.drawings.US100"]);
    expect(localStorage.getItem("auto-trader.tab.A.drawings.US100")).toBeNull();
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
