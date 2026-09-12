// vitest runs in the 'node' env (see vite.config.ts); provide a tiny
// in-memory localStorage before importing modules that touch it.
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDemoLayout,
  fetchDemoSnapshot,
  getDemoSnapshot,
  seedDemoLayout,
} from "./demoSnapshot";
import { setPersistBroker } from "./persist/core";

beforeEach(() => {
  localStorage.clear();
  setPersistBroker("dukascopy");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDemoSnapshot", () => {
  it("parses a 200 payload into a DemoSnapshot", async () => {
    const body = {
      version: 3,
      payload: {
        layout: { layouts: '[{"id":"a","name":"Demo"}]' },
        watchlist: ["US100", "EURUSD"],
        backtests: [{ name: "trend", result: { pnl: 1 } }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) }),
    );
    const snapshot = await fetchDemoSnapshot();
    expect(snapshot).toEqual({
      version: 3,
      layout: { layouts: '[{"id":"a","name":"Demo"}]' },
      watchlist: ["US100", "EURUSD"],
      backtests: [{ name: "trend", result: { pnl: 1 } }],
    });
    expect(getDemoSnapshot()).toEqual(snapshot);
  });

  it("returns null on a 404 (nothing published)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    );
    expect(await fetchDemoSnapshot()).toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchDemoSnapshot()).toBeNull();
  });
});

describe("seedDemoLayout / captureDemoLayout", () => {
  it("writes the layout map under the dukascopy broker's persist keys", () => {
    seedDemoLayout({
      layouts: '[{"id":"a","name":"Demo"}]',
      defaultLayoutId: '"a"',
      "layout.a": '{"tabs":[],"activeTabId":""}',
    });
    expect(localStorage.getItem("auto-trader.b.dukascopy.layouts")).toBe(
      '[{"id":"a","name":"Demo"}]',
    );
    expect(localStorage.getItem("auto-trader.b.dukascopy.defaultLayoutId")).toBe('"a"');
    expect(localStorage.getItem("auto-trader.b.dukascopy.layout.a")).toBe(
      '{"tabs":[],"activeTabId":""}',
    );
  });

  it("round-trips: capture reads back exactly what was seeded", () => {
    const layout = {
      layouts: '[{"id":"a","name":"Demo"}]',
      defaultLayoutId: '"a"',
      "layout.a": '{"tabs":[],"activeTabId":""}',
    };
    seedDemoLayout(layout);
    expect(captureDemoLayout()).toEqual(layout);
  });

  it("capture returns an empty map when no layouts index exists", () => {
    expect(captureDemoLayout()).toEqual({});
  });

  it("splits family-shared vs per-feed keys for a Capital feed", () => {
    // capital-live shares its layout INDEX/BODIES with the "capital" family
    // (familyRoot) but keeps defaultLayoutId per-feed (root) - the one case
    // where the two builders diverge, unlike "dukascopy" above where they
    // coincide.
    setPersistBroker("capital-live");
    try {
      seedDemoLayout({
        layouts: '[{"id":"a","name":"Demo"}]',
        defaultLayoutId: '"a"',
      });
      expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBe(
        '[{"id":"a","name":"Demo"}]',
      );
      expect(localStorage.getItem("auto-trader.b.capital-live.defaultLayoutId")).toBe('"a"');
      expect(localStorage.getItem("auto-trader.b.capital-live.layouts")).toBeNull();
      expect(localStorage.getItem("auto-trader.b.capital.defaultLayoutId")).toBeNull();
    } finally {
      setPersistBroker("dukascopy");
    }
  });
});
