import { describe, expect, it, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("../lib/http", () => ({ API_BASE: "", apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { assistantConfigured, fetchAssistantStatus } from "./api";

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe("fetchAssistantStatus", () => {
  beforeEach(() => { apiFetch.mockReset(); assistantConfigured.set(false); });

  it("retries a transient failure (backend restarting) until it answers", async () => {
    apiFetch
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json(502))
      .mockResolvedValueOnce(json(200, { configured: true }));
    expect(await fetchAssistantStatus(5, 0)).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(assistantConfigured.value).toBe(true);
  });

  it("takes a 403 as the answer without retrying", async () => {
    apiFetch.mockResolvedValue(json(403));
    expect(await fetchAssistantStatus(5, 0)).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retries", async () => {
    apiFetch.mockResolvedValue(json(503));
    expect(await fetchAssistantStatus(2, 0)).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});
