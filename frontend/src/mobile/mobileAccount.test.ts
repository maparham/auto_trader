// Broker-account switching in the mobile shell (mobileChartState): the stored
// choice restores at init (with a fallback when the account vanished from the
// backend), and a switch repoints persistBroker + the trades account and
// reboots the chart symbol.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

// Before the state/trading/persist imports below touch localStorage at
// module-eval time (vitest runs in the node env).
installMemStorage();

const demo = vi.hoisted(() => ({ on: false, broker: null as string | null }));
vi.mock("../lib/demoMode", () => ({ isDemoMode: () => demo.on, setDemoMode: () => {} }));
vi.mock("../lib/demoSnapshot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoSnapshot: () => (demo.broker ? { broker: demo.broker } : null),
}));
import {
  MOBILE_ACCOUNT_KEY,
  bootMobileMarket,
  initMobileAccount,
  mobileAccount,
  mobileBroker,
  mobileChartScope,
  mobileSymbol,
  setMobileAccount,
} from "./mobileChartState";
import { DEFAULT_ACCOUNT, getTradesAccount, setTradesAccount } from "../lib/trading";
import { getPersistBroker } from "../lib/persist/core";
import { saveLayout, type Workspace } from "../lib/persist";
import { mobilePeriod, mobileTabSignal, showMobileEpic } from "./mobileChartState";
import { BROKERS_CACHE_KEY } from "../lib/brokerDefaults";
import type { Instrument } from "../lib/feed";

const IBM: Instrument = { epic: "IBM", name: "IBM Corp" } as Instrument;

function cacheBrokers(exec: { key: string; broker: string; env: string }[]): void {
  localStorage.setItem(BROKERS_CACHE_KEY, JSON.stringify({ data: exec.map((a) => a.broker), exec }));
}

beforeEach(() => {
  localStorage.clear();
  mobileAccount.set(DEFAULT_ACCOUNT);
  mobileSymbol.set(null);
  mobileChartScope.set(null);
  setTradesAccount(DEFAULT_ACCOUNT);
});

describe("initMobileAccount", () => {
  it("restores the stored account and applies it", () => {
    cacheBrokers([
      { key: "capital:paper", broker: "capital", env: "paper" },
      { key: "mt5:demo", broker: "mt5", env: "demo" },
    ]);
    localStorage.setItem(MOBILE_ACCOUNT_KEY, JSON.stringify("mt5:demo"));
    initMobileAccount();
    expect(mobileAccount.value).toBe("mt5:demo");
    expect(mobileBroker()).toBe("mt5");
    expect(getPersistBroker()).toBe("mt5");
    expect(getTradesAccount()).toBe("mt5:demo");
  });

  it("falls back to the default when the stored account is no longer registered", () => {
    cacheBrokers([{ key: "capital:paper", broker: "capital", env: "paper" }]);
    localStorage.setItem(MOBILE_ACCOUNT_KEY, JSON.stringify("gone:live"));
    initMobileAccount();
    expect(mobileAccount.value).toBe(DEFAULT_ACCOUNT);
  });

  it("keeps the stored account when no broker list is cached yet", () => {
    localStorage.setItem(MOBILE_ACCOUNT_KEY, JSON.stringify("mt5:demo"));
    initMobileAccount();
    expect(mobileAccount.value).toBe("mt5:demo");
  });
});

describe("initMobileAccount in the public demo", () => {
  beforeEach(() => {
    demo.on = true;
  });
  afterEach(() => {
    demo.on = false;
    demo.broker = null;
  });

  it("pins the published snapshot's data feed and ignores the stored account", () => {
    localStorage.setItem(MOBILE_ACCOUNT_KEY, JSON.stringify("capital:paper"));
    demo.broker = "yfinance";
    initMobileAccount();
    expect(mobileAccount.value).toBe("yfinance:data");
    expect(mobileBroker()).toBe("yfinance");
    expect(getPersistBroker()).toBe("yfinance");
    expect(getTradesAccount()).toBe("yfinance:data");
    // Never persisted: the key is not workspace-prefixed.
    expect(JSON.parse(localStorage.getItem(MOBILE_ACCOUNT_KEY)!)).toBe("capital:paper");
  });

  it("falls back to dukascopy with no snapshot", () => {
    initMobileAccount();
    expect(mobileAccount.value).toBe("dukascopy:data");
  });

  it("boots the chart on the published layout's first cell", async () => {
    demo.broker = "yfinance";
    initMobileAccount();
    const cell = {
      id: "c1",
      symbol: { epic: "NVDA", name: "NVIDIA" },
      period: { resolution: "HOUR_1", label: "1h" },
      scope: "demo-s1",
    };
    saveLayout("l1", "demo", { tabs: [{ id: "t1", layout: "1", cells: [cell], activeCellId: "c1" }], activeTabId: "t1" } as unknown as Workspace);
    await bootMobileMarket("yfinance");
    expect(mobileSymbol.value?.epic).toBe("NVDA");
    expect(mobileChartScope.value).toEqual({ epic: "NVDA", scope: "demo-s1" });
    expect(mobilePeriod.value?.resolution).toBe("HOUR_1");
  });
});

describe("setMobileAccount", () => {
  it("persists the choice, repoints trading/persist, and clears the chart for reboot", () => {
    cacheBrokers([
      { key: "capital:paper", broker: "capital", env: "paper" },
      { key: "dukascopy:data", broker: "dukascopy", env: "data" },
    ]);
    initMobileAccount();
    mobileSymbol.set(IBM);
    mobileChartScope.set({ epic: "IBM", scope: "s" });

    setMobileAccount("dukascopy:data");

    expect(JSON.parse(localStorage.getItem(MOBILE_ACCOUNT_KEY)!)).toBe("dukascopy:data");
    expect(mobileAccount.value).toBe("dukascopy:data");
    expect(getPersistBroker()).toBe("dukascopy");
    expect(getTradesAccount()).toBe("dukascopy:data");
    // Symbol/scope cleared so the view unmounts ChartCore and reboots.
    expect(mobileSymbol.value).toBeNull();
    expect(mobileChartScope.value).toBeNull();
  });

  it("is a no-op for the already-active account", () => {
    mobileSymbol.set(IBM);
    setMobileAccount(mobileAccount.value);
    expect(mobileSymbol.value).toBe(IBM); // no reboot
  });
});

describe("showMobileEpic", () => {
  beforeEach(() => {
    mobileTabSignal.set("positions");
    mobilePeriod.set(null);
  });

  it("adopts the mirrored layout cell showing the epic, scope and timeframe included", () => {
    const cell = {
      id: "c1",
      symbol: { epic: "NVDA", name: "NVIDIA" },
      period: { resolution: "HOUR_1", label: "1h" },
      scope: "s1",
    };
    saveLayout("l1", "Main", { tabs: [{ id: "t1", layout: "1", cells: [cell], activeCellId: "c1" }], activeTabId: "t1" } as unknown as Workspace);
    showMobileEpic("NVDA", 2);
    expect(mobileSymbol.value?.name).toBe("NVIDIA");
    expect(mobileChartScope.value).toEqual({ epic: "NVDA", scope: "s1" });
    expect(mobilePeriod.value?.resolution).toBe("HOUR_1");
    expect(mobileTabSignal.value).toBe("chart");
  });

  it("opens an epic as a bare instrument at the given precision when the catalogue is down", async () => {
    // A failed fetch is not cached, so the next test's catalogue still loads.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    await showMobileEpic("EURUSD", 5);
    vi.unstubAllGlobals();
    expect(mobileSymbol.value).toEqual({ epic: "EURUSD", name: "EURUSD", status: null, pricePrecision: 5 });
    expect(mobileTabSignal.value).toBe("chart");
  });

  it("opens a catalogue epic with its catalogue row", async () => {
    const row = { epic: "MU", name: "Micron Technology", status: "TRADEABLE", type: "SHARES", pricePrecision: 2 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([row]) }));
    await showMobileEpic("MU", 4);
    vi.unstubAllGlobals();
    expect(mobileSymbol.value).toEqual(row);
    expect(mobileTabSignal.value).toBe("chart");
  });

  it("only switches tabs when the chart already shows the epic", () => {
    mobileSymbol.set(IBM);
    mobileChartScope.set({ epic: "IBM", scope: "keep" });
    showMobileEpic("IBM");
    expect(mobileSymbol.value).toBe(IBM);
    expect(mobileChartScope.value?.scope).toBe("keep");
    expect(mobileTabSignal.value).toBe("chart");
  });
});
