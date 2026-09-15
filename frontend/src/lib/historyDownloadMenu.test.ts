// Admin "Download history" context-menu entries: pure builders, so the
// admin gate and the duration → request mapping are testable outside ChartCore.
import { describe, expect, it, vi } from "vitest";

import {
  historyDownloadItems,
  historyDurationItems,
  historyJobLabel,
} from "./historyDownloadMenu";
import type { HistoryJob } from "../api";

const base = {
  isAdmin: true,
  synthetic: false,
  liveOnly: false,
  running: false,
  openDurations: () => {},
  cancel: () => {},
};

describe("historyDownloadItems", () => {
  it("is empty for non-admins", () => {
    expect(historyDownloadItems({ ...base, isAdmin: false })).toEqual([]);
  });

  it("is empty for synthetic charts and live-only intervals", () => {
    expect(historyDownloadItems({ ...base, synthetic: true })).toEqual([]);
    expect(historyDownloadItems({ ...base, liveOnly: true })).toEqual([]);
  });

  it("offers the duration chooser when idle", () => {
    const openDurations = vi.fn();
    const items = historyDownloadItems({ ...base, openDurations });
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/download history/i);
    items[0].onClick();
    expect(openDurations).toHaveBeenCalledOnce();
  });

  it("offers cancel while a download runs", () => {
    const cancel = vi.fn();
    const items = historyDownloadItems({ ...base, running: true, cancel });
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/cancel history download/i);
    items[0].onClick();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("historyJobLabel", () => {
  const job = (over: Partial<HistoryJob>): HistoryJob => ({
    broker: "capital", epic: "EURUSD", resolution: "MINUTE_5", priceSide: "mid",
    status: "running", result: null, error: null, pct: null,
    oldestTs: Date.UTC(2019, 2, 4) / 1000, targetOldestTs: 0, bars: 12400, elapsedS: 3,
    ...over,
  });

  it("shows percent while running a bounded download", () => {
    expect(historyJobLabel(job({ pct: 0.42 }))).toBe(
      "Downloading history 42% (12,400 bars)",
    );
  });

  it("shows the date reached while running an unbounded download", () => {
    expect(historyJobLabel(job({}))).toBe(
      "Downloading history, back to 2019-03-04 (12,400 bars)",
    );
  });

  it("names terminal states", () => {
    expect(historyJobLabel(job({ status: "done", result: "floor" }))).toBe(
      "Full history loaded, back to 2019-03-04",
    );
    expect(historyJobLabel(job({ status: "done", result: "target" }))).toBe(
      "History loaded, back to 2019-03-04",
    );
    expect(historyJobLabel(job({ status: "error" }))).toBe("History download failed");
    expect(historyJobLabel(job({ status: "cancelled" }))).toBe(
      "History download cancelled",
    );
  });
});

describe("historyDurationItems", () => {
  it("maps each duration to its year count, with null meaning everything", () => {
    const start = vi.fn();
    const items = historyDurationItems(start);
    expect(items.map((i) => i.label)).toEqual([
      "Past year",
      "Past 5 years",
      "Past 10 years",
      "All available history",
    ]);
    items.forEach((i) => i.onClick());
    expect(start.mock.calls.map((c) => c[0])).toEqual([1, 5, 10, null]);
  });
});
