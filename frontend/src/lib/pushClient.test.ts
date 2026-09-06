import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { pushSupported, isSubscribed, subscribePush, unsubscribePush } from "./pushClient";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pushSupported", () => {
  it("false when serviceWorker/PushManager are missing", () => {
    vi.stubGlobal("navigator", {});
    delete (globalThis as { PushManager?: unknown }).PushManager;
    expect(pushSupported()).toBe(false);
  });

  it("true when both are present", () => {
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("PushManager", function PushManager() {});
    expect(pushSupported()).toBe(true);
  });
});

describe("subscribePush", () => {
  let subscribeMock: ReturnType<typeof vi.fn>;
  let registerMock: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const subscription = {
      endpoint: "https://push.example/abc",
      toJSON: () => ({
        endpoint: "https://push.example/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    subscribeMock = vi.fn().mockResolvedValue(subscription);
    const registration = { pushManager: { subscribe: subscribeMock } };
    registerMock = vi.fn().mockResolvedValue(registration);

    vi.stubGlobal("navigator", {
      serviceWorker: { register: registerMock },
    });
    vi.stubGlobal("PushManager", function PushManager() {});

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/alerts/push/vapid")) {
        return Promise.resolve(jsonResponse({ key: "abcd" }));
      }
      if (url.includes("/api/alerts/push/subscribe")) {
        return Promise.resolve(jsonResponse({}, true, 204));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("registers the service worker, subscribes with the decoded VAPID key, and POSTs the subscription", async () => {
    await subscribePush();

    expect(registerMock).toHaveBeenCalledWith("/alert-sw.js");

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const opts = subscribeMock.mock.calls[0][0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array);

    const postCall = fetchMock.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/api/alerts/push/subscribe"),
    );
    expect(postCall).toBeTruthy();
    const [, init] = postCall as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    });
  });
});

describe("unsubscribePush", () => {
  it("DELETEs the subscription and calls subscription.unsubscribe()", async () => {
    const unsubscribeMock = vi.fn().mockResolvedValue(true);
    const subscription = {
      endpoint: "https://push.example/abc",
      unsubscribe: unsubscribeMock,
    };
    const getSubscriptionMock = vi.fn().mockResolvedValue(subscription);
    const getRegistrationMock = vi.fn().mockResolvedValue({
      pushManager: { getSubscription: getSubscriptionMock },
    });

    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: getRegistrationMock },
    });
    vi.stubGlobal("PushManager", function PushManager() {});

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    vi.stubGlobal("fetch", fetchMock);

    await unsubscribePush();

    const deleteCall = fetchMock.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/api/alerts/push/subscribe"),
    );
    expect(deleteCall).toBeTruthy();
    const [, init] = deleteCall as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: "https://push.example/abc" });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-op when there is no registration", async () => {
    const getRegistrationMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: getRegistrationMock },
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await unsubscribePush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isSubscribed", () => {
  it("false when unsupported", async () => {
    vi.stubGlobal("navigator", {});
    delete (globalThis as { PushManager?: unknown }).PushManager;
    expect(await isSubscribed()).toBe(false);
  });

  it("false when there is no registration", async () => {
    const getRegistrationMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: getRegistrationMock },
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    expect(await isSubscribed()).toBe(false);
  });

  it("true when a subscription exists", async () => {
    const getSubscriptionMock = vi.fn().mockResolvedValue({ endpoint: "https://push.example/abc" });
    const getRegistrationMock = vi.fn().mockResolvedValue({
      pushManager: { getSubscription: getSubscriptionMock },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: getRegistrationMock },
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    expect(await isSubscribed()).toBe(true);
  });
});
