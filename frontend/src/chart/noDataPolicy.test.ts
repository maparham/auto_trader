import { describe, expect, it } from "vitest";
import {
  classifyNoData,
  nextHistoryRetryDelayMs,
  shouldKeepPaintedBars,
  shouldRetryHistory,
} from "./noDataPolicy";

describe("nextHistoryRetryDelayMs", () => {
  it("backs off 5s → 10s → 20s → 40s and caps at 60s", () => {
    expect(nextHistoryRetryDelayMs(0)).toBe(5_000);
    expect(nextHistoryRetryDelayMs(1)).toBe(10_000);
    expect(nextHistoryRetryDelayMs(2)).toBe(20_000);
    expect(nextHistoryRetryDelayMs(3)).toBe(40_000);
    expect(nextHistoryRetryDelayMs(4)).toBe(60_000);
    expect(nextHistoryRetryDelayMs(50)).toBe(60_000);
  });

  it("treats a negative attempt count like the first attempt", () => {
    expect(nextHistoryRetryDelayMs(-1)).toBe(5_000);
  });
});

describe("shouldRetryHistory", () => {
  it("retries when the load produced no bars (existing empty-load behavior)", () => {
    expect(shouldRetryHistory(0, null)).toBe(true);
  });

  it("retries a degraded load even though cached bars painted — the tail heals when the broker returns", () => {
    expect(shouldRetryHistory(500, "broker unreachable (503)")).toBe(true);
  });

  it("does not retry a healthy load with bars", () => {
    expect(shouldRetryHistory(500, null)).toBe(false);
  });
});

describe("shouldKeepPaintedBars", () => {
  it("keeps painted bars when a same-series reload comes back empty", () => {
    expect(shouldKeepPaintedBars(0, 500, true)).toBe(true);
  });

  it("clears when the series identity changed — old bars must not masquerade as the new series", () => {
    expect(shouldKeepPaintedBars(0, 500, false)).toBe(false);
  });

  it("applies the loaded bars whenever the load produced any", () => {
    expect(shouldKeepPaintedBars(500, 500, true)).toBe(false);
    expect(shouldKeepPaintedBars(500, 0, true)).toBe(false);
  });

  it("has nothing to keep when the chart is already blank", () => {
    expect(shouldKeepPaintedBars(0, 0, true)).toBe(false);
  });
});

describe("classifyNoData", () => {
  it("is 'empty' when the chart has no bars painted", () => {
    expect(classifyNoData(0)).toBe("empty");
  });

  it("is 'stale' when bars from a previous load are still painted", () => {
    expect(classifyNoData(1)).toBe("stale");
    expect(classifyNoData(500)).toBe("stale");
  });
});
