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
  initMobileAccount,
  mobileAccount,
  mobileBroker,
  mobileChartScope,
  mobileSymbol,
  setMobileAccount,
} from "./mobileChartState";
import { DEFAULT_ACCOUNT, getTradesAccount, setTradesAccount } from "../lib/trading";
import { getPersistBroker } from "../lib/persist/core";
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
