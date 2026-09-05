import { describe, it, expect, afterEach } from "vitest";
import { accountSnapshotFrom, getAccountSnapshot, setAccountSnapshot } from "./accountSnapshot";

afterEach(() => setAccountSnapshot(null));

describe("accountSnapshot", () => {
  it("starts empty, so a paint before the first poll shows no money figures", () => {
    expect(getAccountSnapshot()).toBeNull();
  });

  it("hands back the last account pushed into it", () => {
    setAccountSnapshot({ balance: 25_000, currency: "GBP" });
    expect(getAccountSnapshot()).toEqual({ balance: 25_000, currency: "GBP" });
  });

  it("clears back to empty when the account goes away", () => {
    setAccountSnapshot({ balance: 1, currency: "USD" });
    setAccountSnapshot(null);
    expect(getAccountSnapshot()).toBeNull();
  });
});

describe("accountSnapshotFrom", () => {
  const paper = { accountBalance: 100_000, accountCurrency: "USD" };

  it("prefers the broker's real figures for a live account", () => {
    const s = accountSnapshotFrom({ balance: 8_432.5, currency: "EUR" }, paper);
    expect(s).toEqual({ balance: 8_432.5, currency: "EUR" });
  });

  it("falls back to the configured paper account when there is no summary", () => {
    expect(accountSnapshotFrom(null, paper)).toEqual({ balance: 100_000, currency: "USD" });
  });

  it("fills only the fields the broker omitted", () => {
    const s = accountSnapshotFrom({ balance: null, currency: "GBP" }, paper);
    expect(s).toEqual({ balance: 100_000, currency: "GBP" });
  });
});
