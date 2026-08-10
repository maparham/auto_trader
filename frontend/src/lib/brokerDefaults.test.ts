// The fallback broker/account the app uses before (or without) a live
// /api/brokers fetch. Derived from the last-good cache so a deployment without
// capital creds (demo host: dukascopy/yfinance only) never defaults onto a
// broker the backend doesn't have.
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { BROKERS_CACHE_KEY, defaultAccount, defaultBrokerId } from "./brokerDefaults";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function seedCache(info: unknown): void {
  store.set(BROKERS_CACHE_KEY, JSON.stringify(info));
}

describe("defaultBrokerId", () => {
  it("falls back to capital with no cache (first-ever visit)", () => {
    expect(defaultBrokerId()).toBe("capital");
  });

  it("prefers capital when the backend has it", () => {
    seedCache({ data: ["capital", "dukascopy", "yfinance"], exec: [] });
    expect(defaultBrokerId()).toBe("capital");
  });

  it("lands on the first registered broker when capital is absent", () => {
    seedCache({ data: ["dukascopy", "yfinance"], exec: [] });
    expect(defaultBrokerId()).toBe("dukascopy");
  });

  it("survives an unavailable localStorage", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(defaultBrokerId()).toBe("capital");
  });
});

describe("defaultAccount", () => {
  it("falls back to capital:paper with no cache", () => {
    expect(defaultAccount()).toBe("capital:paper");
  });

  it("prefers capital:paper when registered", () => {
    seedCache({
      data: ["capital", "dukascopy"],
      exec: [
        { key: "dukascopy:data", broker: "dukascopy", env: "data", isRealMoney: false, dataOnly: true },
        { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false },
      ],
    });
    expect(defaultAccount()).toBe("capital:paper");
  });

  it("prefers any paper account over a data-only pseudo-account", () => {
    seedCache({
      data: ["dukascopy", "mt5"],
      exec: [
        { key: "dukascopy:data", broker: "dukascopy", env: "data", isRealMoney: false, dataOnly: true },
        { key: "mt5:paper", broker: "mt5", env: "paper", isRealMoney: false },
      ],
    });
    expect(defaultAccount()).toBe("mt5:paper");
  });

  it("takes the first account when capital is absent (data-only demo)", () => {
    seedCache({
      data: ["dukascopy", "yfinance"],
      exec: [
        { key: "dukascopy:data", broker: "dukascopy", env: "data", isRealMoney: false, dataOnly: true },
        { key: "yfinance:data", broker: "yfinance", env: "data", isRealMoney: false, dataOnly: true },
      ],
    });
    expect(defaultAccount()).toBe("dukascopy:data");
  });

  it("ignores a corrupt cache", () => {
    store.set(BROKERS_CACHE_KEY, "{not json");
    expect(defaultAccount()).toBe("capital:paper");
  });
});
