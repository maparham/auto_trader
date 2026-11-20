// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("./http", async (orig) => ({
  ...(await orig<object>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const toast = vi.fn();
vi.mock("./notify", async (orig) => ({
  ...(await orig<object>()),
  toast: (...args: unknown[]) => toast(...args),
}));
const openMobileAlert = vi.fn();
vi.mock("../mobile/mobileChartState", () => ({
  openMobileAlert: (...args: unknown[]) => openMobileAlert(...args),
}));

import { handleAppLink, registerAppPush } from "./appPush";
import { confirmRequest } from "./signals";

const w = window as unknown as Record<string, unknown>;
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  apiFetch.mockReset();
  toast.mockReset();
  openMobileAlert.mockReset();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  delete w.ChartkarAndroid;
  confirmRequest.set(null);
});

describe("registerAppPush", () => {
  it("does nothing outside the Android app", async () => {
    await registerAppPush();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("sends the app's FCM token to the backend", async () => {
    w.ChartkarAndroid = { invoke: (cmd: string) => (cmd === "fcm_token" ? JSON.stringify("tok-1") : "null") };
    apiFetch.mockReturnValue(Promise.resolve(new Response(null, { status: 204 })));
    await registerAppPush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/alerts\/fcm\/register$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ token: "tok-1" });
  });

  it("skips when the app has no token (Firebase not set up)", async () => {
    w.ChartkarAndroid = { invoke: () => "null" };
    await registerAppPush();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("handleAppLink", () => {
  it("opens the alert's chart from ?alertEpic and strips the params", () => {
    window.history.replaceState(null, "", "/?alertEpic=US100&alertBroker=capital");
    handleAppLink();
    expect(openMobileAlert).toHaveBeenCalledWith("US100", "capital", 2);
    expect(window.location.search).toBe("");
  });

  it("asks before removing a level, then confirms and toasts the answer", async () => {
    window.history.replaceState(null, "", "/?removeLevel=abcd1234");
    apiFetch.mockReturnValueOnce(json(200, { question: "Remove SL on US100 long (SL 18210.0) · Capital live?" }));
    handleAppLink();
    await flush();
    expect(window.location.search).toBe("");
    const req = confirmRequest.value!;
    expect(req.message).toBe("Remove SL on US100 long (SL 18210.0) · Capital live?");
    expect(req.confirmLabel).toBe("Remove");
    expect(String(apiFetch.mock.calls[0][0])).toMatch(/\/api\/alerts\/position-removal\/abcd1234$/);
    apiFetch.mockReturnValueOnce(json(200, { answer: "SL removed ✓" }));
    req.onConfirm();
    await flush();
    expect(apiFetch.mock.calls[1][1].method).toBe("POST");
    expect(toast).toHaveBeenCalledWith("SL removed ✓");
  });

  it("toasts the server's reason when the warning is stale or refused", async () => {
    window.history.replaceState(null, "", "/?removeLevel=old");
    apiFetch.mockReturnValueOnce(json(404, { detail: "This warning was already used or has expired" }));
    handleAppLink();
    await flush();
    expect(confirmRequest.value).toBeNull();
    expect(toast).toHaveBeenCalledWith("This warning was already used or has expired");
  });
});
