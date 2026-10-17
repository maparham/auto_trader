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
  loadIndicatorAlerts,
  loadAllIndicatorAlerts,
  linkedAlerts,
  addIndicatorAlert,
  patchIndicatorAlert,
  repointIndicatorAlert,
  deleteIndicatorAlert,
  alertLabel,
  triggeredLabel,
  levelText,
  addLineAlert,
  patchLineAlert,
  loadLineAlerts,
  loadServerAlerts,
  linkedLineAlerts,
  type LineAlert,
  type SavedAlert,
  type FiredPayload,
  type IndicatorAlert,
} from "./alertsApi";
import type { AlertInstance } from "./indicatorAlertInstance";

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
    expect(loadTriggered()[0]).toMatchObject({ epic: "US100", alertId: "al-1", price: 101, broker });
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

describe("startAtCreation (where the chart line starts)", () => {
  it("rides in the POST params, defaulted on when the caller omits it", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await addStoredAlert("US100", SAVED, broker);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.params.startAtCreation).toBe(true);
  });

  it("defaults on when reading back a server row saved before the flag existed", async () => {
    const broker = freshBroker();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ alerts: [alertRow({ broker })] }))),
    );

    await hydrateAlerts();

    expect(loadStoredAlert("US100", "al-1", broker)!.startAtCreation).toBe(true);
  });

  it("round-trips an off flag from the server row's params", async () => {
    const broker = freshBroker();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            alerts: [
              alertRow({
                broker,
                params: { level: 100, condition: "crossing", trigger: "every", startAtCreation: false },
              }),
            ],
          }),
        ),
      ),
    );

    await hydrateAlerts();

    expect(loadStoredAlert("US100", "al-1", broker)!.startAtCreation).toBe(false);
  });

  it("transmits a toggle in the PATCH params (an edit that leaves the level alone)", async () => {
    vi.useFakeTimers();
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await addStoredAlert("US100", SAVED, broker);
    fetchMock.mockClear();

    updateStoredAlert(
      "US100",
      SAVED.id,
      SAVED.level,
      {
        condition: SAVED.condition,
        trigger: SAVED.trigger,
        message: SAVED.message,
        expiresAt: null,
        notify: SAVED.notify!,
        startAtCreation: false,
      },
      broker,
    );
    await vi.advanceTimersByTimeAsync(300);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.params.startAtCreation).toBe(false);
    expect(loadStoredAlert("US100", SAVED.id, broker)!.startAtCreation).toBe(false);
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
      startAtCreation: true,
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
    expect(loadTriggered()[0]).toMatchObject({ epic: "US100", alertId: "al-9", price: 123, broker: "b1" });
  });

  it("non-alert keys return false and change nothing", () => {
    const before = loadTriggered().length;
    const handled = applyAlertEvent("__trades__:acct1", { foo: "bar" });
    expect(handled).toBe(false);
    expect(loadTriggered().length).toBe(before);
  });
});

function indRow(broker: string, overrides: Record<string, unknown> = {}) {
  return alertRow({
    id: "al-ind", broker, kind: "indicator",
    label: "EMA 50 (1H)",
    params: {
      type: "MA", config: { maType: "ema", source: "close" }, output: "ma",
      timeframe: "HOUR", target: "price", value: null,
      condition: "crossing_up", trigger: "every", evalOn: "close",
      link: { scope: "tab.t1.cell.c2", instanceId: "EMA" },
    },
    status: "waiting_for_data",
    ...overrides,
  });
}

function indRowAsAlert(broker: string): IndicatorAlert {
  return {
    kind: "indicator", id: "al-ind", epic: "US100", broker, condition: "crossing_up", trigger: "every",
    message: "hi", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    precision: 2, label: "EMA 50 (1H)", params: {
      type: "MA", config: { maType: "ema", source: "close" }, output: "ma",
      timeframe: "HOUR", target: "price", value: null, evalOn: "close",
      link: { scope: "tab.t1.cell.c2", instanceId: "EMA" } },
  };
}

describe("indicator alerts", () => {
  it("hydrate splits kinds: price lines never see indicator alerts", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [alertRow({ broker }), indRow(broker)] }))));
    await hydrateAlerts();
    expect(loadAlerts("US100", broker).map((a) => a.id)).toEqual(["al-1"]);
    const ind = loadIndicatorAlerts("US100", broker);
    expect(ind).toHaveLength(1);
    expect(ind[0].params.config).toEqual({ maType: "ema", source: "close" });
    expect(ind[0].status).toBe("waiting_for_data");
  });

  it("linkedAlerts matches scope and instanceId", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [
            indRow(broker),
            indRow(broker, { id: "al-other", params: { ...indRow(broker).params, link: { scope: "tab.t1.cell.c9", instanceId: "EMA" } } }),
          ] }))));
    await hydrateAlerts();
    expect(linkedAlerts("tab.t1.cell.c2", "EMA").map((a) => a.id)).toEqual(["al-ind"]);
  });

  it("labels read the same everywhere", () => {
    const base = {
      kind: "indicator", id: "x", epic: "US100", broker: "b", condition: "crossing_up", trigger: "every",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2,
    } as const;
    const price: IndicatorAlert = { ...base, label: "EMA 50 (1H)", params: {
      type: "MA", config: { maType: "ema", source: "close" }, output: "ma",
      timeframe: "HOUR", target: "price", value: null, evalOn: "close", link: null } };
    expect(alertLabel(price, 2)).toBe("Crossing Up EMA 50 (1H)");
    const val: IndicatorAlert = { ...base, condition: "greater", label: "RSI 14 (1H)", params: {
      type: "RSI", config: { source: "close" }, output: "value",
      timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null } };
    expect(alertLabel(val, 2)).toBe("RSI 14 (1H) Greater Than 70");
  });

  it("triggeredLabel puts the condition first for a price target (F18)", () => {
    const priceTarget = {
      time: 1, epic: "US100", condition: "crossing_up" as const, level: 21400, price: 21430,
      message: "", precision: 1, alertId: "a", broker: "b",
      label: "EMA 50 (1H)", target: "price" as const,
    };
    expect(triggeredLabel(priceTarget, 2)).toBe("Crossing Up EMA 50 (1H) 21,400.00 @ 21,430.00");
    const valueTarget = { ...priceTarget, condition: "greater" as const, level: 70, label: "RSI 14 (1H)", target: "value" as const };
    expect(triggeredLabel(valueTarget, 2)).toBe("RSI 14 (1H) Greater Than 70 @ 21,430.00");
  });

  it("addIndicatorAlert posts the wire shape and rolls back on failure", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}, false, 422)));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-z", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    expect(await addIndicatorAlert(a)).toBe(false);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.kind).toBe("indicator");
    expect(body.params).toMatchObject({ type: "RSI", output: "value", target: "value", value: 70 });
    expect(loadIndicatorAlerts("US100", broker)).toEqual([]);
  });

  it("addIndicatorAlert is idempotent (already cached)", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-idem", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    expect(await addIndicatorAlert(a)).toBe(true);
    const result = await addIndicatorAlert(a);
    expect(result).toBe(true); // already present, returns true without POST
    expect(fetchMock).toHaveBeenCalledTimes(1); // fetch called only once, on first add
  });

  it("patchIndicatorAlert updates cache and posts the patch", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-patch", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "m1", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    await addIndicatorAlert(a);
    fetchMock.mockClear();

    const result = await patchIndicatorAlert(a.id, { message: "m2", condition: "less" });
    expect(result).toBe(true);
    expect(loadIndicatorAlerts("US100", broker)[0]).toMatchObject({ message: "m2", condition: "less" });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.message).toBe("m2");
  });

  it("patchIndicatorAlert takes the server row, so the label follows an output change", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-relabel", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "m1", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, label: "RSI 14 (1H)", params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    await addIndicatorAlert(a);
    fetchMock.mockResolvedValue(jsonResponse(alertRow({
      id: a.id, broker, kind: "indicator", label: "RSI 14 bearish divergence (1H)",
      params: { ...a.params, output: "bearDiv", condition: "crossing_up", trigger: "once" },
    })));

    expect(await patchIndicatorAlert(a.id, { params: { output: "bearDiv" } })).toBe(true);
    const row = loadIndicatorAlerts("US100", broker)[0];
    expect(row.label).toBe("RSI 14 bearish divergence (1H)");
    expect(row.condition).toBe("crossing_up");
  });

  it("patchIndicatorAlert rolls back on failure", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-rollback", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "m1", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    await addIndicatorAlert(a);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 422));

    const result = await patchIndicatorAlert(a.id, { message: "m2" });
    expect(result).toBe(false);
    expect(loadIndicatorAlerts("US100", broker)[0].message).toBe("m1"); // restored
  });

  it("a hydrate that overlaps an in-flight create neither drops nor keeps a stale snapshot", async () => {
    const broker = freshBroker();
    let releasePost: (r: Response) => void = () => {};
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((r) => { releasePost = r; });
      if (String(input).includes("triggered")) return Promise.resolve(jsonResponse({ entries: [], seen: 0 }));
      // The first GET predates the server's commit; the re-pull sees the row.
      gets++;
      return Promise.resolve(jsonResponse({ alerts: gets === 1 ? [] : [indRow(broker, { id: "al-race" })] }));
    }));
    const add = addIndicatorAlert({ ...indRowAsAlert(broker), id: "al-race" });
    await hydrateAlerts();
    // Stale snapshot dropped for the indicator cache: the optimistic row stays.
    expect(loadIndicatorAlerts("US100", broker).map((a) => a.id)).toEqual(["al-race"]);
    releasePost(jsonResponse({}));
    expect(await add).toBe(true);
    await vi.waitFor(() => expect(gets).toBe(2));
    expect(loadIndicatorAlerts("US100", broker).map((a) => a.id)).toEqual(["al-race"]);
  });

  it("deleteIndicatorAlert removes from cache", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-delete", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    await addIndicatorAlert(a);
    deleteIndicatorAlert(a.id);
    expect(loadIndicatorAlerts("US100", broker)).toEqual([]);
  });

  it("linkedAlerts excludes same-scope-different-instanceId", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [
            indRow(broker),
            indRow(broker, { id: "al-other", params: { ...indRow(broker).params, link: { scope: "tab.t1.cell.c2", instanceId: "DIFFERENT" } } }),
          ] }))));
    await hydrateAlerts();
    expect(linkedAlerts("tab.t1.cell.c2", "EMA").map((a) => a.id)).toEqual(["al-ind"]);
    expect(linkedAlerts("tab.t1.cell.c2", "DIFFERENT").map((a) => a.id)).toEqual(["al-other"]);
  });

  it("alertLabel price-target formats as indicator name only (no level)", () => {
    const priceAlert: IndicatorAlert = {
      kind: "indicator", id: "al-price-fmt", epic: "US100", broker: "b", condition: "crossing_up", trigger: "every",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, label: "EMA 50 (4H)", params: {
        type: "MA", config: { maType: "ema", source: "close" }, output: "ma",
        timeframe: "HOUR_4", target: "price", value: null, evalOn: "close", link: null },
    };
    expect(alertLabel(priceAlert, 2)).toBe("Crossing Up EMA 50 (4H)");
  });

  it("alertLabel price-level (SavedAlert) branch", () => {
    const priceAlert: SavedAlert = {
      id: "al-saved", level: 100, condition: "greater", trigger: "once", message: "", notify: undefined, expiresAt: null,
    };
    expect(alertLabel(priceAlert, 2)).toBe("Greater Than 100.00");
  });

  it("levelText: value targets use 6 significant digits, price targets group like fmtPrice", () => {
    expect(levelText("value", 70, 2)).toBe("70");
    expect(levelText("value", 0.0015, 2)).toBe("0.0015");
    expect(levelText("price", 21400, 1)).toBe("21,400.0");
  });

  it("triggeredLabel price_level branch formats level at precision", () => {
    const triggered = {
      time: 1, epic: "US100", condition: "greater" as const, level: 100, price: 101,
      message: "", precision: 2, alertId: "al-trig-price", broker: "b",
      label: undefined, target: undefined,
    };
    expect(triggeredLabel(triggered, 2)).toBe("Greater Than 100.00 @ 101.00");
  });

  it("alertLabel and triggeredLabel handle ATR sub-1 values (6 sig figs)", () => {
    const atrAlert: IndicatorAlert = {
      kind: "indicator", id: "al-atr-small", epic: "EURUSD", broker: "b", condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 6, label: "ATR 14 (1H)", params: {
        type: "ATR", config: { smoothing: "rma" }, output: "value",
        timeframe: "HOUR", target: "value", value: 0.0015, evalOn: "close", link: null },
    };
    expect(alertLabel(atrAlert, 6)).toBe("ATR 14 (1H) Greater Than 0.0015");

    const triggered = {
      time: 1, epic: "EURUSD", condition: "greater" as const, level: 0.0015, price: 1.1234,
      message: "", precision: 6, alertId: "al-atr-small", broker: "b",
      label: "ATR 14 (1H)", target: "value" as const,
    };
    expect(triggeredLabel(triggered, 4)).toBe("ATR 14 (1H) Greater Than 0.0015 @ 1.1234");
  });

  it("fmtIndicatorValue handles extreme values (tiny and huge)", () => {
    // 1m FX ATR: very small
    expect(alertLabel({
      kind: "indicator", id: "al-tiny", epic: "EURUSD", broker: "b", condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 6, label: "ATR 14 (1m)", params: {
        type: "ATR", config: { smoothing: "rma" }, output: "value",
        timeframe: "MINUTE", target: "value", value: 0.00005, evalOn: "close", link: null },
    }, 6)).toBe("ATR 14 (1m) Greater Than 0.00005");

    // JPY-priced MA: very large (1234567 rounds to 1234570 at 6 sig figs)
    expect(alertLabel({
      kind: "indicator", id: "al-huge", epic: "USDJPY", broker: "b", condition: "crossing_up", trigger: "every",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 0, label: "EMA 20 (1H)", params: {
        type: "MA", config: { maType: "ema", source: "close" }, output: "ma",
        timeframe: "HOUR", target: "value", value: 1234570, evalOn: "close", link: null },
    }, 0)).toBe("EMA 20 (1H) Crossing Up 1234570");

    const tinyTriggered = {
      time: 1, epic: "EURUSD", condition: "greater" as const, level: 0.00005, price: 1.1234,
      message: "", precision: 6, alertId: "al-tiny", broker: "b",
      label: "ATR 14 (1m)", target: "value" as const,
    };
    expect(triggeredLabel(tinyTriggered, 4)).toBe("ATR 14 (1m) Greater Than 0.00005 @ 1.1234");

    const hugeTriggered = {
      time: 1, epic: "USDJPY", condition: "crossing_up" as const, level: 1234570, price: 156.7,
      message: "", precision: 0, alertId: "al-huge", broker: "b",
      label: "EMA 20 (1H)", target: "value" as const,
    };
    expect(triggeredLabel(hugeTriggered, 1)).toBe("EMA 20 (1H) Crossing Up 1234570 @ 156.7");
  });

  it("maps a server row's label and new params", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [indRow(broker, {
            label: "RSI 14 (1H)",
            params: {
              type: "RSI", config: { source: "close" }, output: "value",
              timeframe: "HOUR", target: "value", value: 70,
              condition: "greater", trigger: "every", evalOn: "close", link: null,
            },
          })] }))));
    await hydrateAlerts();
    const alerts = loadAllIndicatorAlerts(broker);
    expect(alerts[0].label).toBe("RSI 14 (1H)");
    expect(alerts[0].params.output).toBe("value");
  });

  it("alertLabel uses the server label", () => {
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-server-label", epic: "US100", broker: "b", condition: "greater", trigger: "every",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, label: "RSI 14 (1H)", params: {
        type: "RSI", config: { source: "close" }, output: "value",
        timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    expect(alertLabel(a, 2)).toContain("RSI 14 (1H)");
  });

  it("repointIndicatorAlert reports a 422 as refused without a toast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "x" }, false, 422)));
    const instance: AlertInstance = { type: "RSI", calcParams: [14], extendData: {} };
    expect(await repointIndicatorAlert("al-1", instance)).toBe("refused");
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

function lineRow(broker: string, overrides: Record<string, unknown> = {}) {
  return alertRow({
    id: "al-line", broker, kind: "line",
    params: {
      timeframe: "HOUR", evalOn: "close", condition: "crossing", trigger: "every",
      tRef: 9, pRef: 13, slope: 0.5, anchors: { t1: 2, p1: 10, t2: 6, p2: 12 },
      link: { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", lineKey: "2:6" },
    },
    ...overrides,
  });
}

describe("line alerts", () => {
  it("hydrate keeps line alerts apart from indicator and price alerts", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [alertRow({ broker }), indRow(broker), lineRow(broker)] }))));
    await hydrateAlerts();
    expect(loadIndicatorAlerts("US100", broker).map((a) => a.id)).toEqual(["al-ind"]);
    expect(loadLineAlerts("US100", broker).map((a) => a.id)).toEqual(["al-line"]);
    expect(loadServerAlerts("US100", broker).map((a) => a.id).sort()).toEqual(["al-ind", "al-line"]);
    expect(linkedLineAlerts("tab.t1.cell.c2", "TRENDLINES").map((a) => a.id)).toEqual(["al-line"]);
    const line = loadLineAlerts("US100", broker)[0];
    expect(alertLabel(line, 2)).toBe("Crossing Trendline (1H)");
  });

  it("addLineAlert posts the line wire shape; patchLineAlert sends only what may change", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: LineAlert = {
      kind: "line", id: "al-l2", epic: "US100", broker, condition: "crossing", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        timeframe: "HOUR", evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
        anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: { scope: "s", instanceId: "TRENDLINES", lineKey: "2:6" } },
    };
    expect(await addLineAlert(a)).toBe(true);
    const post = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(post.kind).toBe("line");
    expect(post.params).toMatchObject({ tRef: 9, slope: 0.5, condition: "crossing", trigger: "once" });
    expect(await patchLineAlert("al-l2", { condition: "greater", params: { evalOn: "intrabar" } })).toBe(true);
    const patch = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(patch.params).toEqual({ evalOn: "intrabar", condition: "greater", trigger: "once" });
  });

  it("an engine rebase push refreshes the cached tRef/pRef, and a later patch never sends them", async () => {
    const broker = freshBroker();
    const id = `al-rebase-${broker}`;
    let tRef = 9;
    let pRef = 13;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("triggered")) return Promise.resolve(jsonResponse({ entries: [], seen: 0 }));
      if (u.includes(`/api/alerts/${id}`)) return Promise.resolve(jsonResponse({}));
      const row = lineRow(broker, { id });
      (row.params as Record<string, unknown>).tRef = tRef;
      (row.params as Record<string, unknown>).pRef = pRef;
      return Promise.resolve(jsonResponse({ alerts: [row] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await hydrateAlerts();
    expect(loadLineAlerts("US100", broker)[0].params.tRef).toBe(9);

    // The server engine rolls the reference bar forward and broadcasts.
    tRef = 21;
    pRef = 19;
    applyAlertEvent("__alerts__:changed", { broker, epic: "US100", origin: "engine" });
    await vi.waitFor(() => expect(loadLineAlerts("US100", broker)[0].params).toMatchObject({ tRef: 21, pRef: 19 }));

    expect(await patchLineAlert(id, { message: "m", params: { link: null } })).toBe(true);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(`/api/alerts/${id}`)) as unknown as
      [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.params).not.toHaveProperty("tRef");
    expect(body.params).not.toHaveProperty("pRef");
    expect(body.params).not.toHaveProperty("slope");
    expect(body.params).not.toHaveProperty("anchors");
    expect(body.params).toEqual({ link: null, condition: "crossing", trigger: "every" });
  });
});
