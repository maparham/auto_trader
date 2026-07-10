import { describe, expect, it } from "vitest";
import { resolveExpiry, expiryToApi, isValidExpiry } from "./expiry";

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0); // 2026-07-11 12:00:00 UTC

describe("resolveExpiry", () => {
  it("gtc → null", () => {
    expect(resolveExpiry({ kind: "gtc" }, NOW)).toBeNull();
  });

  it("relative minutes → now + N*60_000", () => {
    expect(resolveExpiry({ kind: "relative", amount: 30, unit: "minutes" }, NOW)).toBe(NOW + 30 * 60_000);
  });

  it("relative hours", () => {
    expect(resolveExpiry({ kind: "relative", amount: 2, unit: "hours" }, NOW)).toBe(NOW + 2 * 3_600_000);
  });

  it("relative days", () => {
    expect(resolveExpiry({ kind: "relative", amount: 3, unit: "days" }, NOW)).toBe(NOW + 3 * 86_400_000);
  });

  it("absolute passes through", () => {
    expect(resolveExpiry({ kind: "absolute", atMs: NOW + 5000 }, NOW)).toBe(NOW + 5000);
  });

  it("preset d30 → now + 30 days", () => {
    expect(resolveExpiry({ kind: "preset", preset: "d30" }, NOW)).toBe(NOW + 30 * 86_400_000);
  });

  it("preset endOfDay → next UTC midnight is after now", () => {
    const eod = resolveExpiry({ kind: "preset", preset: "endOfDay" }, NOW)!;
    expect(eod).toBeGreaterThan(NOW);
    expect(new Date(eod).getUTCHours()).toBe(0);
  });
});

describe("expiryToApi", () => {
  it("null → null", () => expect(expiryToApi(null)).toBeNull());
  it("ms → ISO string", () => expect(expiryToApi(NOW)).toBe("2026-07-11T12:00:00.000Z"));
});

describe("isValidExpiry", () => {
  it("null (gtc) is valid", () => expect(isValidExpiry(null, NOW)).toBe(true));
  it("future is valid", () => expect(isValidExpiry(NOW + 1000, NOW)).toBe(true));
  it("past is invalid", () => expect(isValidExpiry(NOW - 1000, NOW)).toBe(false));
  it("now is invalid", () => expect(isValidExpiry(NOW, NOW)).toBe(false));
});
