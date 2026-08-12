import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelWithRetry } from "./cancelRetry";

describe("cancelWithRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves true when the first attempt succeeds", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    await expect(cancelWithRetry(cancel)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retries after a transient failure and resolves true on success", async () => {
    const cancel = vi.fn()
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce(undefined);
    const p = cancelWithRetry(cancel);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting every retry and resolves false (never throws)", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("down"));
    const p = cancelWithRetry(cancel);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it("backs off between retries: no second attempt before the first delay elapses", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("down"));
    void cancelWithRetry(cancel);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
