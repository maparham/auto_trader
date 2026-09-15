// Watcher for an admin history download: chained 1s polls of the jobs list,
// delivering this series' job to the callback until it leaves "running".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../api";
import { watchHistoryDownload } from "./historyDownload";

const job = (over: Partial<api.HistoryJob> = {}): api.HistoryJob => ({
  broker: "capital",
  epic: "EURUSD",
  resolution: "MINUTE_5",
  priceSide: "mid",
  status: "running",
  result: null,
  error: null,
  pct: 0.5,
  oldestTs: 1000,
  targetOldestTs: 0,
  bars: 100,
  elapsedS: 3,
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.restoreAllMocks());

describe("watchHistoryDownload", () => {
  it("delivers this series' job on each tick and stops once it finishes", async () => {
    const spy = vi
      .spyOn(api, "fetchHistoryJobs")
      .mockResolvedValueOnce([job({ epic: "US100" }), job()])
      .mockResolvedValueOnce([job({ status: "done", result: "target", pct: 1 })])
      .mockResolvedValue([]);
    const seen: Array<api.HistoryJob | null> = [];
    watchHistoryDownload({ broker: "capital", epic: "EURUSD" }, (j) => seen.push(j));

    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.epic).toBe("EURUSD"); // the US100 job is someone else's
    expect(seen[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1000);
    expect(seen[1]?.status).toBe("done");

    // Terminal state delivered -> no further polls are scheduled.
    await vi.advanceTimersByTimeAsync(3000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reports null when no job matches, and keeps polling", async () => {
    vi.spyOn(api, "fetchHistoryJobs").mockResolvedValue([]);
    const seen: Array<api.HistoryJob | null> = [];
    watchHistoryDownload({ broker: "capital", epic: "EURUSD" }, (j) => seen.push(j));
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual([null, null]);
  });

  it("stop() halts polling and suppresses late deliveries", async () => {
    const spy = vi.spyOn(api, "fetchHistoryJobs").mockResolvedValue([job()]);
    const seen: Array<api.HistoryJob | null> = [];
    const stop = watchHistoryDownload({ broker: "capital", epic: "EURUSD" }, (j) =>
      seen.push(j),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
