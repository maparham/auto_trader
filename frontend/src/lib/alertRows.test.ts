// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const resyncAlerts = vi.fn(() => Promise.resolve());
const loadAccountAlerts = vi.fn(() => [] as unknown[]);
const loadPositionAlerts = vi.fn(() => [] as unknown[]);
vi.mock("./alertsApi", async (orig) => ({
  ...(await orig<object>()),
  resyncAlerts: () => resyncAlerts(),
  loadAccountAlerts: () => loadAccountAlerts(),
  loadPositionAlerts: () => loadPositionAlerts(),
}));

import {
  accountRowView,
  decimalsOf,
  historyRowView,
  positionRowView,
  unseenCount,
  useAlertTick,
} from "./alertRows";
import { accountLabel, type AccountAlert, type PositionAlert, type TriggeredAlert } from "./alertsApi";

function hist(over: Partial<TriggeredAlert> = {}): TriggeredAlert {
  return {
    time: 1,
    epic: "US100",
    condition: "crossing_up",
    level: 18000,
    price: 18001,
    message: "",
    ...over,
  };
}

function acct(over: Partial<AccountAlert> = {}): AccountAlert {
  return {
    kind: "account",
    id: "a1",
    account: "capital-live:live",
    metric: "marginLevel",
    tiers: [
      { level: 150, label: "warn" },
      { level: 50, label: "critical" },
    ],
    message: "",
    expiresAt: null,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    precision: 2,
    ...over,
  } as AccountAlert;
}

function pos(over: Partial<PositionAlert> = {}): PositionAlert {
  return {
    kind: "position",
    id: "p1",
    account: "capital:demo",
    epic: "US100",
    dealId: "D1",
    side: "sl",
    atrMult: 0.5,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    ...over,
  };
}

describe("historyRowView", () => {
  it("names an account firing by its account", () => {
    const v = historyRowView(hist({ kind: "account", broker: "capital-live:live" }), "capital", 2);
    expect(v.title).toBe(accountLabel("capital-live:live"));
    expect(v.isAccount).toBe(true);
    expect(v.foreignBroker).toBeNull();
  });

  it("flags a firing on another broker", () => {
    expect(historyRowView(hist({ broker: "ig" }), "capital", 2).foreignBroker).toBe("ig");
    expect(historyRowView(hist(), "capital", 2).foreignBroker).toBeNull();
  });

  it("reads a position firing's account key as its broker", () => {
    const v = historyRowView(hist({ kind: "position", broker: "capital:demo" }), "capital", 2);
    expect(v.foreignBroker).toBeNull();
  });

  it("uses the firing's own precision, else the fallback", () => {
    expect(historyRowView(hist({ precision: 5 }), "capital", 2).precision).toBe(5);
    expect(historyRowView(hist(), "capital", 3).precision).toBe(3);
  });
});

describe("decimalsOf", () => {
  it("counts decimals, capped at 8", () => {
    expect(decimalsOf(1.08234)).toBe(5);
    expect(decimalsOf(18000)).toBe(0);
    expect(decimalsOf(0.123456789012)).toBe(8);
  });
});

describe("unseenCount", () => {
  it("counts firings newer than the marker", () => {
    expect(unseenCount([hist({ time: 5 }), hist({ time: 3 }), hist({ time: 1 })], 3)).toBe(1);
  });
});

describe("accountRowView", () => {
  it("leaves out 'now' without a value", () => {
    expect(accountRowView(acct({ current: null, currency: null })).now).toBeNull();
  });

  it("marks fired tiers", () => {
    const v = accountRowView(acct({ firedTiers: [50] }));
    expect(v.tiers.find((t) => t.level === 50)?.fired).toBe(true);
    expect(v.tiers.find((t) => t.level === 150)?.fired).toBe(false);
  });

  it("reports an unmonitored account", () => {
    expect(accountRowView(acct({ monitored: false, unmonitoredReason: null })).unmonitored).toBe("Not monitored");
    expect(accountRowView(acct()).unmonitored).toBeNull();
  });
});

describe("positionRowView", () => {
  it("names the side and the ATR distance", () => {
    const v = positionRowView(pos({ distanceAtr: 0.8123 }), [{ id: "D1", side: "buy" }]);
    expect(v.title).toBe("US100 long");
    expect(v.cond).toBe("SL · 0.5× ATR · now 0.81 ATR");
  });

  it("says n/a without a distance and drops the side for another account's deal", () => {
    const v = positionRowView(pos({ distanceAtr: null }), []);
    expect(v.title).toBe("US100");
    expect(v.cond).toBe("SL · 0.5× ATR · now n/a");
  });
});

describe("useAlertTick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    resyncAlerts.mockClear();
  });

  it("resyncs every 30 s while account or position alerts exist", () => {
    loadAccountAlerts.mockReturnValue([{}]);
    const { unmount } = renderHook(() => useAlertTick());
    vi.advanceTimersByTime(30_000);
    expect(resyncAlerts).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not resync without them", () => {
    loadAccountAlerts.mockReturnValue([]);
    loadPositionAlerts.mockReturnValue([]);
    const { unmount } = renderHook(() => useAlertTick());
    vi.advanceTimersByTime(30_000);
    expect(resyncAlerts).not.toHaveBeenCalled();
    unmount();
  });
});
