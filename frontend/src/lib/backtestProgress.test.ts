import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backtestProgressSignal } from "./signals";
import { startBacktestProgressPoller } from "./backtestProgress";
import * as api from "../api";

describe("startBacktestProgressPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backtestProgressSignal.set(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows download phase from active backfills when no simulate entry", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue(null);
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([
      { label: "dukascopy/US100/MINUTE_5/bid", doneChunks: 14, totalChunks: 70,
        bars: 27370, elapsedS: 49.8, etaS: 199, at: "2023-08-01 20:45" },
    ]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value).toEqual({
      phase: "download", label: "dukascopy/US100/MINUTE_5/bid",
      pct: 20, etaS: 199,
    });
    stop();
  });

  it("prefers simulate phase once the progress entry exists", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue({ stage: "simulate", done: 64, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value).toEqual({
      phase: "simulate", label: "Simulating", pct: 64, etaS: null,
    });
    stop();
  });

  it("translates extra-pass stages to display labels", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue({ stage: "cost-sensitivity", done: 40, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value?.label).toBe("Running cost sensitivity");
    stop();
  });

  it("falls back to 'Simulating' for unknown stages, even Object.prototype keys", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue({ stage: "constructor", done: 5, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value?.label).toBe("Simulating");
    stop();
  });

  it("never overlaps ticks: the next poll starts only after the previous settles", async () => {
    let resolveFirst: (v: { stage: string; done: number; total: number }) => void = () => {};
    const sim = vi.spyOn(api, "fetchBacktestProgress")
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue({ stage: "simulate", done: 85, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(3000); // tick 1 fires and hangs; no further ticks may start
    expect(sim).toHaveBeenCalledTimes(1);
    resolveFirst({ stage: "simulate", done: 80, total: 100 });
    await vi.advanceTimersByTimeAsync(0); // slow response applies (nothing newer exists)
    expect(backtestProgressSignal.value?.pct).toBe(80);
    await vi.advanceTimersByTimeAsync(1000); // next tick is chained off the settle
    expect(sim).toHaveBeenCalledTimes(2);
    expect(backtestProgressSignal.value?.pct).toBe(85);
    stop();
  });

  it("poll failures leave the signal unchanged, stop() resets it", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockRejectedValue(new Error("net"));
    vi.spyOn(api, "fetchActiveBackfills").mockRejectedValue(new Error("net"));
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(backtestProgressSignal.value).toBeNull();
    stop();
    expect(backtestProgressSignal.value).toBeNull();
  });

  it("stops rescheduling after stop()", async () => {
    const sim = vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue({ stage: "simulate", done: 1, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(backtestProgressSignal.value).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sim).toHaveBeenCalledTimes(1);
    expect(backtestProgressSignal.value).toBeNull();
  });
});
