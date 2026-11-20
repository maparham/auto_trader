// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const toast = vi.fn();
vi.mock("../lib/notify", async (orig) => ({
  ...(await orig<object>()),
  toast: (...args: unknown[]) => toast(...args),
}));

const accounts = vi.hoisted(() => ({ exec: [] as { key: string; broker: string; env: string; isRealMoney: boolean }[] }));
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  cachedBrokers: () => ({ exec: accounts.exec }),
  setTradesAccount: vi.fn(),
}));

const resolveInstrument = vi.fn();
vi.mock("../lib/feed", async (orig) => ({
  ...(await orig<object>()),
  resolveInstrument: (...args: unknown[]) => resolveInstrument(...args),
}));

const initialMarket = vi.fn();
vi.mock("../lib/mobileScope", async (orig) => ({
  ...(await orig<object>()),
  initialMarket: (...args: unknown[]) => initialMarket(...args),
}));

import {
  mobileAccount,
  mobileSymbol,
  mobileTabSignal,
  openMobileAlert,
  bootMobileMarket,
} from "./mobileChartState";
import { confirmRequest, symbolSearchRequest } from "../lib/signals";
import { brokerLabel } from "../lib/trading";

function inst(epic: string) {
  return { epic, name: epic, pricePrecision: 2 } as never;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("openMobileAlert", () => {
  beforeEach(() => {
    accounts.exec = [
      { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false },
      { key: "ig-demo:demo", broker: "ig-demo", env: "demo", isRealMoney: false },
    ];
    mobileAccount.set("capital:demo");
    mobileSymbol.set(inst("DE40"));
    mobileTabSignal.set("alerts");
    resolveInstrument.mockImplementation(async (epic: string) => inst(epic));
    initialMarket.mockResolvedValue({ symbol: inst("HEARTBEAT"), resolution: "HOUR" });
  });
  afterEach(() => {
    toast.mockReset();
    confirmRequest.set(null);
  });

  it("opens a same-broker epic on the chart, no confirm", async () => {
    openMobileAlert("US100", "capital", 2);
    await flush();
    expect(confirmRequest.value).toBeNull();
    expect(mobileSymbol.value?.epic).toBe("US100");
    expect(mobileTabSignal.value).toBe("chart");
  });

  it("reads a position firing's account key as this broker", async () => {
    openMobileAlert("US100", "capital:demo", 2);
    await flush();
    expect(confirmRequest.value).toBeNull();
    expect(mobileSymbol.value?.epic).toBe("US100");
  });

  it("toasts when no account is on that broker", () => {
    openMobileAlert("US100", "ig-live", 2);
    expect(toast).toHaveBeenCalledWith(`${brokerLabel("ig-live")} is not available, so US100 cannot be opened.`);
    expect(confirmRequest.value).toBeNull();
    expect(mobileAccount.value).toBe("capital:demo");
  });

  it("asks before switching broker, then lands on the alert's epic", async () => {
    openMobileAlert("US500", "ig-demo", 2);
    const req = confirmRequest.value!;
    expect(req.title).toBe("Switch broker?");
    req.onConfirm();
    expect(mobileAccount.value).toBe("ig-demo:demo");
    await bootMobileMarket("ig-demo");
    await flush();
    expect(mobileSymbol.value?.epic).toBe("US500");
    expect(mobileTabSignal.value).toBe("chart");
  });

  it("does not open symbol search when the new broker has no boot market while the jump resolves", async () => {
    initialMarket.mockResolvedValue(null);
    let release: (v: unknown) => void = () => {};
    resolveInstrument.mockImplementation((epic: string) => new Promise((r) => { release = () => r(inst(epic)); }));
    const before = symbolSearchRequest.value;
    openMobileAlert("US500", "ig-demo", 2);
    confirmRequest.value!.onConfirm();
    await bootMobileMarket("ig-demo");
    await flush();
    expect(symbolSearchRequest.value).toBe(before);
    release(null);
    await flush();
    expect(mobileSymbol.value?.epic).toBe("US500");
    expect(symbolSearchRequest.value).toBe(before);
  });
});
