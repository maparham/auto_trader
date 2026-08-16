import { describe, expect, it } from "vitest";
import { cachedRunNotice, emptyRangeError, warmupError } from "./backtestDataHealth";

describe("emptyRangeError", () => {
  it("keeps the plain message when the fetch was healthy (data genuinely absent)", () => {
    expect(emptyRangeError(null)).toBe("no candles in the selected range");
  });

  it("names the outage when the empty range came from an unreachable broker", () => {
    const msg = emptyRangeError("broker unreachable (503)");
    expect(msg).toContain("broker unreachable (503)");
    expect(msg).toContain("cached");
    expect(msg).not.toBe("no candles in the selected range");
  });
});

describe("warmupError", () => {
  const base = "not enough history: 10 of 50 warm-up bars before the window.";

  it("passes the base message through when healthy", () => {
    expect(warmupError(base, null)).toBe(base);
  });

  it("attributes the shortage to the outage when degraded", () => {
    const msg = warmupError(base, "broker unreachable (503)");
    expect(msg).toContain(base);
    expect(msg).toContain("broker unreachable (503)");
  });
});

describe("cachedRunNotice", () => {
  const resSeconds = 60;

  it("is null for a healthy run", () => {
    expect(cachedRunNotice(null, 1_000_000_000_000, 1_000_000_000, resSeconds)).toBeNull();
  });

  it("announces the cached run when degraded", () => {
    // Last bar right at the requested end (within a bar or two) — complete range.
    const toSec = 1_000_000_000;
    const lastBarMs = (toSec - resSeconds) * 1000;
    const msg = cachedRunNotice("broker unreachable (503)", lastBarMs, toSec, resSeconds);
    expect(msg).toContain("cached");
    expect(msg).not.toContain("Data ends");
  });

  it("names the effective end when the cached tail stops short of the requested end", () => {
    const toSec = 1_000_000_000;
    const lastBarMs = (toSec - 3600) * 1000; // an hour of minute bars missing
    const msg = cachedRunNotice("broker unreachable (503)", lastBarMs, toSec, resSeconds);
    expect(msg).toContain("cached");
    expect(msg).toContain("Data ends");
    expect(msg).toContain(new Date(lastBarMs).toISOString().slice(0, 16).replace("T", " "));
  });

  it("is degraded-but-noticeable even when no bars loaded at all", () => {
    const msg = cachedRunNotice("broker unreachable (503)", null, 1_000_000_000, resSeconds);
    expect(msg).toContain("cached");
  });
});
