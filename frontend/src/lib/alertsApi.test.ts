import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastSpy = vi.fn();
vi.mock("./notify", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

import {
  hydrateAlerts,
  loadAlerts,
  loadAllAlerts,
  loadStoredAlert,
  loadTriggered,
  loadTriggeredSeen,
  addStoredAlert,
  updateStoredAlert,
  deleteStoredAlert,
  applyAlertEvent,
  setOnAlertFired,
  type SavedAlert,
  type FiredPayload,
} from "./alertsApi";

let n = 0;
const freshBroker = () => `test-broker-${n++}`;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function alertRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "al-1",
    broker: "b1",
    epic: "US100",
    kind: "price_level",
    params: { level: 100, condition: "crossing", trigger: "every" },
    message: "hi",
    expires_at: null,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    precision: 2,
    active: 1,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

const SAVED: SavedAlert = {
  id: "al-new",
  level: 50,
  condition: "greater",
  trigger: "once",
  message: "m",
  expiresAt: null,
  notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  createdAt: 0,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  setOnAlertFired(null);
  toastSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hydrateAlerts", () => {
  it("populates the synchronous reads from GET /api/alerts + /api/alerts/triggered", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/api/alerts/triggered")) {
        return Promise.resolve(
          jsonResponse({
            entries: [
              {
                time: 5000,
                alert_id: "al-1",
                broker,
                epic: "US100",
                kind: "price_level",
                price: 101,
                level: 100,
                condition: "crossing",
                message: "hi",
                precision: 2,
              },
            ],
            seen: 4000,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ alerts: [alertRow({ broker })] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await hydrateAlerts();

    expect(loadAlerts("US100", broker)).toHaveLength(1);
    expect(loadAlerts("US100", broker)[0]).toMatchObject({
      id: "al-1",
      level: 100,
      condition: "crossing",
      trigger: "every",
      message: "hi",
    });
    expect(loadStoredAlert("US100", "al-1", broker)).toMatchObject({ id: "al-1" });
    expect(loadAllAlerts(broker)).toEqual([{ epic: "US100", alerts: loadAlerts("US100", broker) }]);
    expect(loadTriggered()).toHaveLength(1);
    expect(loadTriggered()[0]).toMatchObject({ epic: "US100", alertId: "al-1", price: 101 });
    expect(loadTriggeredSeen()).toBe(4000);
  });
});

describe("addStoredAlert", () => {
  it("is readable synchronously before the POST resolves", () => {
    const broker = freshBroker();
    let resolvePost!: (r: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolvePost = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);

    void addStoredAlert("US100", SAVED, broker);

    // Cache already holds the optimistic row — no await needed.
    expect(loadStoredAlert("US100", SAVED.id, broker)).toMatchObject({ id: SAVED.id, level: 50 });

    resolvePost(jsonResponse({}));
  });

  it("rolls back the cache and toasts on a failed POST", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    await addStoredAlert("US100", SAVED, broker);

    expect(loadStoredAlert("US100", SAVED.id, broker)).toBeNull();
    expect(toastSpy).toHaveBeenCalledWith("Alert save failed");
  });

  it("rolls back the cache on a network error", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await addStoredAlert("US100", SAVED, broker);

    expect(loadStoredAlert("US100", SAVED.id, broker)).toBeNull();
  });
});

describe("updateStoredAlert", () => {
  it("debounces two rapid updates into a single trailing PATCH", async () => {
    vi.useFakeTimers();
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    // Seed the cache directly via a fresh add-like state: bypass network by
    // calling addStoredAlert then letting its POST resolve immediately.
    await addStoredAlert("US100", SAVED, broker);
    fetchMock.mockClear();

    const cfg = {
      condition: "less" as const,
      trigger: "every" as const,
      message: "first",
      expiresAt: null,
      notify: SAVED.notify!,
    };
    updateStoredAlert("US100", SAVED.id, 60, cfg, broker);
    updateStoredAlert("US100", SAVED.id, 65, { ...cfg, message: "second" }, broker);

    // Readable synchronously (cache updated immediately, no PATCH sent yet).
    expect(loadStoredAlert("US100", SAVED.id, broker)).toMatchObject({ level: 65, message: "second" });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(String(reqUrl)).toContain(`/api/alerts/${SAVED.id}`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body.params).toMatchObject({ level: 65 });
    expect(body.message).toBe("second");
  });
});

describe("deleteStoredAlert", () => {
  it("removes from the cache and DELETEs", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await addStoredAlert("US100", SAVED, broker);
    fetchMock.mockClear();

    deleteStoredAlert("US100", SAVED.id, broker);

    expect(loadStoredAlert("US100", SAVED.id, broker)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(String(reqUrl)).toContain(`/api/alerts/${SAVED.id}`);
    expect(init.method).toBe("DELETE");
  });
});

describe("applyAlertEvent — changed", () => {
  it("re-hydrates on a remote change and picks up the new row", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/api/alerts/triggered")) return Promise.resolve(jsonResponse({ entries: [], seen: 0 }));
      return Promise.resolve(jsonResponse({ alerts: [alertRow({ broker, id: "al-remote" })] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const handled = applyAlertEvent("__alerts__:changed", { broker, epic: "US100", origin: "other-tab" });
    expect(handled).toBe(true);

    // hydrateAlerts() fires as a background task inside applyAlertEvent — wait
    // a tick for its fetches + cache assignment to land.
    await vi.waitFor(() => expect(loadStoredAlert("US100", "al-remote", broker)).not.toBeNull());
  });

  it("coalesces two back-to-back changed events into a single GET /api/alerts (single-flight)", async () => {
    const broker = freshBroker();
    let getAlertsCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/api/alerts/triggered")) return Promise.resolve(jsonResponse({ entries: [], seen: 0 }));
      getAlertsCalls++;
      return Promise.resolve(jsonResponse({ alerts: [alertRow({ broker })] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    applyAlertEvent("__alerts__:changed", { broker, epic: "US100", origin: "other-tab" });
    applyAlertEvent("__alerts__:changed", { broker, epic: "US100", origin: "other-tab" });

    await vi.waitFor(() => expect(getAlertsCalls).toBeGreaterThan(0));
    expect(getAlertsCalls).toBe(1);
  });
});

describe("applyAlertEvent — unknown alerts subkey", () => {
  it("still returns true for an unrecognized __alerts__: key (namespace claim, not routed anywhere)", () => {
    const handled = applyAlertEvent("__alerts__:something-future", {});
    expect(handled).toBe(true);
  });
});

describe("applyAlertEvent", () => {
  it("a fired value invokes the onFired callback and grows loadTriggered()", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ alerts: [] })));
    const before = loadTriggered().length;
    const cb = vi.fn();
    setOnAlertFired(cb);

    const payload: FiredPayload = {
      id: "al-9",
      broker: "b1",
      epic: "US100",
      price: 123,
      level: 120,
      condition: "greater",
      message: "boom",
      precision: 2,
      notify: {},
    };
    const handled = applyAlertEvent("__alerts__:fired", payload);

    expect(handled).toBe(true);
    expect(cb).toHaveBeenCalledWith(payload);
    expect(loadTriggered().length).toBe(before + 1);
    expect(loadTriggered()[0]).toMatchObject({ epic: "US100", alertId: "al-9", price: 123 });
  });

  it("non-alert keys return false and change nothing", () => {
    const before = loadTriggered().length;
    const handled = applyAlertEvent("__trades__:acct1", { foo: "bar" });
    expect(handled).toBe(false);
    expect(loadTriggered().length).toBe(before);
  });
});
