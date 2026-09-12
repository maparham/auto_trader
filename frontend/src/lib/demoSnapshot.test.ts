// vitest runs in the 'node' env (see vite.config.ts); provide a tiny
// in-memory localStorage before importing modules that touch it.
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDemoLayout,
  describeDemoLayout,
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

describe("describeDemoLayout", () => {
  const body = (tabId: string) =>
    JSON.stringify({
      tabs: [{ id: tabId, cells: [{ id: "c0", scope: `tab.${tabId}` }] }],
      activeTabId: tabId,
    });

  it("counts saved layouts, names the default, and sizes its content", () => {
    localStorage.setItem(
      "auto-trader.b.dukascopy.layouts",
      '[{"id":"a","name":"Demo"},{"id":"b","name":"Scratch"}]',
    );
    localStorage.setItem("auto-trader.b.dukascopy.defaultLayoutId", '"b"');
    localStorage.setItem("auto-trader.b.dukascopy.layout.a", body("T1"));
    localStorage.setItem("auto-trader.b.dukascopy.layout.b", body("T2"));
    // Content under the DEFAULT layout's cell counts; the other layout's does not.
    localStorage.setItem("auto-trader.tab.T2.drawings.US100", "[1]");
    localStorage.setItem("auto-trader.tab.T2.indicators", '["EMA"]');
    localStorage.setItem("auto-trader.tab.T1.drawings.US100", "[1]");

    const d = describeDemoLayout();
    expect(d.count).toBe(2);
    expect(d.defaultName).toBe("Scratch");
    expect(d.scopeItems).toBe(2);
    expect(d.bytes).toBeGreaterThan(0);
  });

  it("reports no default when nothing points at a saved layout", () => {
    localStorage.setItem("auto-trader.b.dukascopy.layouts", '[{"id":"a","name":"Demo"}]');
    expect(describeDemoLayout()).toMatchObject({ count: 1, defaultName: null, scopeItems: 0 });
  });

  it("counts nothing when the index is missing or malformed", () => {
    expect(describeDemoLayout()).toMatchObject({ count: 0, defaultName: null, scopeItems: 0 });
    localStorage.setItem("auto-trader.b.dukascopy.layouts", "not json");
    expect(describeDemoLayout()).toMatchObject({ count: 0, defaultName: null, scopeItems: 0 });
  });
});

describe("scope content round-trip", () => {
  const layoutBody = JSON.stringify({
    tabs: [
      {
        id: "T1",
        cells: [
          { id: "c0", scope: "tab.T1" },
          { id: "c1", scope: "tab.T1.cell.c1" },
        ],
      },
    ],
    activeTabId: "T1",
  });

  const seedAdminWorkspace = () => {
    localStorage.setItem("auto-trader.b.dukascopy.layouts", '[{"id":"a","name":"Demo"}]');
    localStorage.setItem("auto-trader.b.dukascopy.defaultLayoutId", '"a"');
    localStorage.setItem("auto-trader.b.dukascopy.layout.a", layoutBody);
    localStorage.setItem("auto-trader.tab.T1.drawings.US100", '[{"name":"ray"}]');
    localStorage.setItem("auto-trader.tab.T1.indicators", '["EMA"]');
    localStorage.setItem("auto-trader.tab.T1.cell.c1.indicatorConfig", '{"EMA":{}}');
  };

  it("captures each cell's drawings and indicators, and seeds them back verbatim", () => {
    seedAdminWorkspace();
    const captured = captureDemoLayout();
    expect(captured["scope:tab.T1.drawings.US100"]).toBe('[{"name":"ray"}]');
    expect(captured["scope:tab.T1.indicators"]).toBe('["EMA"]');
    expect(captured["scope:tab.T1.cell.c1.indicatorConfig"]).toBe('{"EMA":{}}');

    localStorage.clear();
    setPersistBroker("dukascopy");
    seedDemoLayout(captured);
    expect(localStorage.getItem("auto-trader.tab.T1.drawings.US100")).toBe('[{"name":"ray"}]');
    expect(localStorage.getItem("auto-trader.tab.T1.indicators")).toBe('["EMA"]');
    expect(localStorage.getItem("auto-trader.tab.T1.cell.c1.indicatorConfig")).toBe('{"EMA":{}}');
  });

  it("leaves out run pointers and gallery metadata a visitor cannot fetch", () => {
    seedAdminWorkspace();
    localStorage.setItem("auto-trader.tab.T1.backtest.US100", '"run-1"');
    localStorage.setItem("auto-trader.tab.T1.sweep.US100", '"sweep-1"');
    localStorage.setItem("auto-trader.tab.T1.snapshotMeta", "{}");

    const captured = captureDemoLayout();
    expect(Object.keys(captured).filter((k) => k.includes("backtest."))).toEqual([]);
    expect(Object.keys(captured).filter((k) => k.includes("sweep."))).toEqual([]);
    expect(Object.keys(captured).filter((k) => k.includes("snapshotMeta"))).toEqual([]);
  });
});
