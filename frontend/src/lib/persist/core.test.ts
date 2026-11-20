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

describe("save() mirror skipping (no-op writes)", () => {
  // Reuses the FakeWS double above. Fresh module instance per test: hydrate
  // flips the module-level mirrorEnabled, which must not leak into the shared
  // core instance the other tests use.
  class FakeWS2 {
    static last: FakeWS2 | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeWS2.last = this;
    }
    close() {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWS2.last = null;
  });

  it("mirrors byte-changed writes only; an unchanged write still consumes a pending remote echo", async () => {
    localStorage.clear();
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, opts?: { method?: string; body?: string }) => {
        if (opts?.method === "PUT") puts.push(opts.body ?? "");
        return { ok: true, json: async () => ({}) };
      }),
    );
    vi.stubGlobal("WebSocket", FakeWS2);
    vi.resetModules();
    const core = await import("./core");
    await core.hydrateFromBackend(); // empty snapshot + empty storage → just enables mirroring
    const unsub = core.subscribeToBackendUpdates(() => {});
    const K = "auto-trader.tab.A.viewpos.US100";

    // Sends to one key go out one at a time, so let each finish before the next.
    const settle = () => new Promise((r) => setTimeout(r, 0));
    core.save(K, { a: 1 });
    expect(puts.length).toBe(1); // genuine new value mirrors
    await settle();
    core.save(K, { a: 1 });
    expect(puts.length).toBe(1); // byte-identical re-save (mount-time save) does NOT re-mirror

    // Remote push applies {a:2} to localStorage and records the echo.
    FakeWS2.last!.onmessage!({
      data: JSON.stringify({ key: K, value: { a: 2 }, origin: "other-tab" }),
    });
    core.save(K, { a: 2 }); // the React save effect re-firing after the push
    expect(puts.length).toBe(1); // unchanged → skipped, and the echo entry is consumed

    core.save(K, { a: 3 });
    expect(puts.length).toBe(2); // genuine local edit mirrors
    await settle();
    core.save(K, { a: 2 });
    // Revert to the previously-pushed value must mirror too — if the echo entry
    // from the push above lingered (not consumed by the skipped save), mirrorSet
    // would swallow this as "the echo" and the revert would never propagate.
    expect(puts.length).toBe(3);

    unsub();
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

describe("backend mirror: ordered sends", () => {
  const K = "auto-trader.tab.A.indicatorConfig";
  const UNSENT = "auto-trader.mirrorUnsent";
  type Call = { method: string; url: string; body: string; resolve: (status: number) => void; fail: () => void };

  // A backend whose answers the test releases by hand, plus the snapshot the
  // boot-time GET returns.
  async function boot(snapshot: Record<string, unknown> = { "auto-trader.seeded": 1 }) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, opts?: { method?: string; body?: string }) => {
        const method = opts?.method ?? "GET";
        if (method === "GET") return Promise.resolve({ ok: true, status: 200, json: async () => snapshot });
        return new Promise((resolve, reject) => {
          calls.push({
            method,
            url: String(url),
            body: opts?.body ?? "",
            resolve: (status) => resolve({ ok: status < 300, status }),
            fail: () => reject(new TypeError("network")),
          });
        });
      }),
    );
    vi.resetModules();
    const core = await import("./core");
    await core.hydrateFromBackend();
    return { core, calls };
  }
  const tick = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends one write per key at a time and skips to the latest value", async () => {
    const { core, calls } = await boot();
    core.save(K, { v: 1 });
    core.save(K, { v: 2 });
    core.save(K, { v: 3 });
    core.save("auto-trader.tab.A.indicators", [1]); // another key is not held back
    expect(calls.map((c) => c.body)).toEqual(['{"value":{"v":1}}', '{"value":[1]}']);
    calls[0].resolve(204);
    await tick();
    // v2 was replaced while v1 was on its way: it is never sent, so no older
    // map can land after the newest one.
    expect(calls.map((c) => c.body)).toEqual(['{"value":{"v":1}}', '{"value":[1]}', '{"value":{"v":3}}']);
    calls[2].resolve(204);
    calls[1].resolve(204);
    await tick();
    expect(calls.length).toBe(3);
    expect(localStorage.getItem(UNSENT)).toBeNull();
  });

  it("retries a write the backend did not take (restart, network)", async () => {
    const { core, calls } = await boot();
    core.save(K, { v: 1 });
    calls[0].fail();
    await tick();
    expect(calls.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(UNSENT)!)).toHaveProperty(K);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(2);
    calls[1].resolve(502);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.map((c) => c.body)).toEqual(Array(3).fill('{"value":{"v":1}}'));
    calls[2].resolve(204);
    await tick();
    expect(localStorage.getItem(UNSENT)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(3);
  });

  it("does not retry a write the backend refuses", async () => {
    const { core, calls } = await boot();
    core.save(K, { v: 1 });
    calls[0].resolve(403);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(1);
    expect(localStorage.getItem(UNSENT)).toBeNull();
  });

  it("orders a delete after the write before it", async () => {
    const { core, calls } = await boot();
    core.save(K, { v: 1 });
    core.mirrorDelete(K);
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    calls[0].resolve(204);
    await tick();
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
  });

  it("keeps an unconfirmed local write through a reload and sends it again", async () => {
    const first = await boot();
    first.core.save(K, { v: "new" });
    first.core.save("auto-trader.tab.A.indicators", ["mine"]);
    // Page reloads before either send is confirmed. The backend still holds
    // the older map, and nothing at all for the second key.
    const { calls } = await boot({ "auto-trader.seeded": 1, [K]: { v: "old" } });
    expect(localStorage.getItem(K)).toBe('{"v":"new"}');
    expect(localStorage.getItem("auto-trader.tab.A.indicators")).toBe('["mine"]');
    expect(calls.map((c) => c.body).sort()).toEqual(['{"value":["mine"]}', '{"value":{"v":"new"}}']);
  });

  it("drops a waiting write when another tab's value arrives for the key", async () => {
    class WS {
      static last: WS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        WS.last = this;
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", WS);
    const { core, calls } = await boot();
    const unsub = core.subscribeToBackendUpdates(() => {});
    core.save(K, { v: 1 });
    calls[0].fail(); // backend down: v1 waits for its retry
    await tick();
    WS.last!.onmessage!({ data: JSON.stringify({ key: K, value: { v: "theirs" }, origin: "other" }) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(1); // the older v1 is never sent over theirs
    expect(localStorage.getItem(K)).toBe('{"v":"theirs"}');
    expect(localStorage.getItem(UNSENT)).toBeNull();
    unsub();
  });

  it("lets the backend win for an unconfirmed write older than a day", async () => {
    const first = await boot();
    first.core.save(K, { v: "new" });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const { calls } = await boot({ "auto-trader.seeded": 1, [K]: { v: "other device" } });
    expect(localStorage.getItem(K)).toBe('{"v":"other device"}');
    expect(calls.length).toBe(0);
  });
});
