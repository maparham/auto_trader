import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getTelegramStatus,
  startTelegramLink,
  unlinkTelegram,
  sendTelegramTest,
  pollTelegramLink,
} from "./telegramClient";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTelegramStatus", () => {
  it("GETs /api/alerts/telegram and returns {linked, enabled}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ linked: true, enabled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await getTelegramStatus();

    expect(status).toEqual({ linked: true, enabled: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/alerts/telegram");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("throws on a failed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getTelegramStatus()).rejects.toThrow();
  });
});

describe("startTelegramLink", () => {
  it("POSTs /api/alerts/telegram/link and returns the t.me url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ url: "https://t.me/mybot?start=abc123" }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await startTelegramLink();

    expect(url).toBe("https://t.me/mybot?start=abc123");
    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(String(reqUrl)).toContain("/api/alerts/telegram/link");
    expect(init?.method).toBe("POST");
  });

  it("propagates a 503 (bot token unset) as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "no bot token" }, false, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startTelegramLink()).rejects.toThrow();
  });
});

describe("unlinkTelegram", () => {
  it("DELETEs /api/alerts/telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    vi.stubGlobal("fetch", fetchMock);

    await unlinkTelegram();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/alerts/telegram");
    expect(init?.method).toBe("DELETE");
  });

  it("throws on a failed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(unlinkTelegram()).rejects.toThrow();
  });
});

describe("sendTelegramTest", () => {
  it("POSTs /api/alerts/telegram/test", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramTest();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/alerts/telegram/test");
    expect(init?.method).toBe("POST");
  });

  it("throws (404) when unlinked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "not linked" }, false, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTelegramTest()).rejects.toThrow();
  });
});

describe("pollTelegramLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls on the given interval and calls onLinked once linked, then stops", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ linked: false, enabled: true }))
      .mockResolvedValueOnce(jsonResponse({ linked: false, enabled: true }))
      .mockResolvedValueOnce(jsonResponse({ linked: true, enabled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const onLinked = vi.fn();
    pollTelegramLink(onLinked, { intervalMs: 2000, timeoutMs: 60000 });

    await vi.advanceTimersByTimeAsync(2000);
    expect(onLinked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLinked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLinked).toHaveBeenCalledWith({ linked: true, enabled: true });

    const callsAtLink = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock.mock.calls.length).toBe(callsAtLink);
  });

  it("stops polling after the timeout elapses without linking", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ linked: false, enabled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const onLinked = vi.fn();
    const onTimeout = vi.fn();
    pollTelegramLink(onLinked, { intervalMs: 2000, timeoutMs: 5000, onTimeout });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const callsBeforeDeadline = fetchMock.mock.calls.length;
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10000);

    expect(onLinked).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(callsBeforeDeadline + 1);
  });

  it("keeps polling past a transient rejection, until the deadline stops it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network blip"));
    vi.stubGlobal("fetch", fetchMock);

    const onLinked = vi.fn();
    pollTelegramLink(onLinked, { intervalMs: 2000, timeoutMs: 5000 });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const callsBeforeDeadline = fetchMock.mock.calls.length;
    expect(callsBeforeDeadline).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10000);
    expect(onLinked).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(callsBeforeDeadline + 1);
  });

  it("cancel() stops polling immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ linked: false, enabled: true }));
    vi.stubGlobal("fetch", fetchMock);

    const onLinked = vi.fn();
    const cancel = pollTelegramLink(onLinked, { intervalMs: 2000, timeoutMs: 60000 });

    await vi.advanceTimersByTimeAsync(2000);
    const callsBeforeCancel = fetchMock.mock.calls.length;
    cancel();
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock.mock.calls.length).toBe(callsBeforeCancel);
  });
});
