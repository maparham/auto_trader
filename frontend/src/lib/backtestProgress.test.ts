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
      phase: "simulate", label: "simulate", pct: 64, etaS: null,
    });
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
});
