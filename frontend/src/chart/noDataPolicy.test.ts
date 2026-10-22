import { describe, expect, it } from "vitest";
import {
  classifyLoadFailure,
  classifyNoData,
  degradedPillText,
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

describe("classifyLoadFailure", () => {
  it("names a dead session for 401 — the retry in apiFetch already failed", () => {
    expect(classifyLoadFailure(401)).toBe("auth");
  });

  it("names a refused broker for 403, not a dead session", () => {
    expect(classifyLoadFailure(403)).toBe("forbidden");
  });

  it("blames the broker for 429 and 5xx", () => {
    expect(classifyLoadFailure(429)).toBe("broker");
    expect(classifyLoadFailure(500)).toBe("broker");
    expect(classifyLoadFailure(502)).toBe("broker");
    expect(classifyLoadFailure(503)).toBe("broker");
  });

  it("stays generic for a status that names no cause", () => {
    expect(classifyLoadFailure(404)).toBe("unknown");
    expect(classifyLoadFailure(422)).toBe("unknown");
  });

  it("stays generic when there is no status at all (offline / DNS / timeout)", () => {
    expect(classifyLoadFailure(null)).toBe("unknown");
    expect(classifyLoadFailure(undefined)).toBe("unknown");
  });
});

describe("degradedPillText", () => {
  it("names who is at fault, falling back to the generic text", () => {
    const pill = (cause: "broker" | "server" | "blocked" | null) =>
      degradedPillText({ reason: "x", cause }, "Capital.com (live)");
    expect(pill("broker")).toMatch(/^Capital\.com \(live\) isn't responding/);
    expect(pill("server")).toMatch(/^Chartkar's server is overloaded/);
    expect(pill("blocked")).toMatch(/^Your network is blocking the broker/);
    expect(pill(null)).toMatch(/^Broker unreachable/);
  });
});
