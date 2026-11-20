// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const loadAllAlerts = vi.fn();
const deleteStoredAlert = vi.fn();
const loadTriggered = vi.fn();
const loadAllServerAlerts = vi.fn();
const deleteIndicatorAlert = vi.fn();
const clearTriggered = vi.fn();
const loadAccountAlerts = vi.fn(() => [] as unknown[]);
const loadPositionAlerts = vi.fn(() => [] as unknown[]);
const deleteAccountAlert = vi.fn();
const deletePositionAlert = vi.fn();
const loadTriggeredSeen = vi.fn(() => 0);
const pushTriggeredSeen = vi.fn();
vi.mock("../lib/alertsApi", async (orig) => ({
  ...(await orig<object>()),
  clearTriggered: (...args: unknown[]) => clearTriggered(...args),
  loadAccountAlerts: () => loadAccountAlerts(),
  loadPositionAlerts: () => loadPositionAlerts(),
  deleteAccountAlert: (...args: unknown[]) => deleteAccountAlert(...args),
  deletePositionAlert: (...args: unknown[]) => deletePositionAlert(...args),
  loadTriggeredSeen: () => loadTriggeredSeen(),
  pushTriggeredSeen: (...args: unknown[]) => pushTriggeredSeen(...args),
  loadAllServerAlerts: (...args: unknown[]) => loadAllServerAlerts(...args),
  deleteIndicatorAlert: (...args: unknown[]) => deleteIndicatorAlert(...args),
  loadAllAlerts: (...args: unknown[]) => loadAllAlerts(...args),
  deleteStoredAlert: (...args: unknown[]) => deleteStoredAlert(...args),
  loadTriggered: (...args: unknown[]) => loadTriggered(...args),
}));

const fetchQuote = vi.fn();
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  fetchQuote: (...args: unknown[]) => fetchQuote(...args),
}));

const openMobileAlert = vi.fn();
vi.mock("./mobileChartState", async (orig) => ({
  ...(await orig<object>()),
  openMobileAlert: (...args: unknown[]) => openMobileAlert(...args),
}));

import MobileAlertsView from "./MobileAlertsView";
import { mobileSymbol } from "./mobileChartState";
import {
  confirmRequest,
  alertGlobalEditRequest,
  alertModalRequest,
  indicatorAlertRequest,
  accountAlertRequest,
  positionAlertRequest,
} from "../lib/signals";
import { accountLabel, METRIC_LABELS, TRIGGER_LABELS, type AccountAlert, type PositionAlert, type IndicatorAlert, type SavedAlert, type TriggeredAlert } from "../lib/alertsApi";
import { brokerLabel } from "../lib/trading";

afterEach(() => {
  cleanup();
  confirmRequest.set(null);
  alertGlobalEditRequest.set(null);
  alertModalRequest.set(null);
  mobileSymbol.set(null);
  indicatorAlertRequest.set(null);
});

function indAlert(over: Partial<IndicatorAlert> = {}): IndicatorAlert {
  return {
    kind: "indicator",
    id: "ind1",
    epic: "US100",
    broker: "capital",
    condition: "crossing_up",
    trigger: "once",
    message: "ema cross",
    expiresAt: null,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    precision: 2,
    label: "EMA 50 (1H)",
    params: {
      type: "MA",
      config: { maType: "ema", source: "close" },
      output: "ma",
      timeframe: "HOUR",
      target: "price",
      value: null,
      evalOn: "close",
      link: null,
    },
    ...over,
  };
}

function alert(over: Partial<SavedAlert> = {}): SavedAlert {
  return {
    id: "a1",
    level: 100,
    condition: "crossing",
    trigger: "every",
    message: "test msg",
    ...over,
  };
}

describe("MobileAlertsView", () => {
  beforeEach(() => {
    loadAllAlerts.mockReset();
    deleteStoredAlert.mockReset();
    loadTriggered.mockReset();
    loadAllServerAlerts.mockReset();
    deleteIndicatorAlert.mockReset();
    fetchQuote.mockReset();
    loadAllServerAlerts.mockReturnValue([]);
    loadAllAlerts.mockReturnValue([]);
    loadTriggered.mockReturnValue([]);
  });

  it("renders active alert rows across epics", () => {
    loadAllAlerts.mockReturnValue([
      { epic: "US100", alerts: [alert({ id: "a1", level: 100, message: "m1" })] },
      { epic: "EURUSD", alerts: [alert({ id: "a2", level: 1.5, message: "m2" })] },
    ]);

    render(<MobileAlertsView />);

    expect(screen.getByText("US100")).toBeTruthy();
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.getByText("m1")).toBeTruthy();
    expect(screen.getByText("m2")).toBeTruthy();
    expect(screen.getAllByText(/Crossing/).length).toBe(2);
  });

  it("tapping delete requests confirmation, then deletes + bumps on confirm", async () => {
    loadAllAlerts.mockReturnValue([
      { epic: "US100", alerts: [alert({ id: "a1", level: 100 })] },
    ]);

    render(<MobileAlertsView />);
    await userEvent.click(screen.getByRole("button", { name: /delete alert/i }));

    expect(confirmRequest.value).not.toBeNull();
    confirmRequest.value!.onConfirm();

    expect(deleteStoredAlert).toHaveBeenCalledWith("US100", "a1", expect.any(String));
  });

  it("tapping a row opens the global edit modal request", async () => {
    loadAllAlerts.mockReturnValue([
      { epic: "US100", alerts: [alert({ id: "a1", level: 100 })] },
    ]);

    render(<MobileAlertsView />);
    await userEvent.click(screen.getByText("US100"));

    expect(alertGlobalEditRequest.value).toEqual({
      epic: "US100",
      savedId: "a1",
      precision: 2,
    });
  });

  it("shows history rows newest-first with time/epic/price/message, text-only (no snapshot field)", async () => {
    const t: TriggeredAlert = {
      time: Date.now(),
      epic: "US100",
      condition: "crossing",
      level: 100,
      price: 100.2,
      message: "fired!",
      precision: 2,
    };
    loadTriggered.mockReturnValue([t]);

    render(<MobileAlertsView />);
    await userEvent.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByText("US100")).toBeTruthy();
    expect(screen.getByText("fired!")).toBeTruthy();
    expect(screen.getByText(/100\.20/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("create button fetches a quote for the current symbol and opens the create modal", async () => {
    mobileSymbol.set({ epic: "US100", name: "US100", pricePrecision: 2 } as never);
    fetchQuote.mockResolvedValue({ bid: 99, ask: 101, mid: 100 });

    render(<MobileAlertsView />);
    await userEvent.click(screen.getByRole("button", { name: /create alert/i }));

    expect(fetchQuote).toHaveBeenCalledWith("US100");
    await waitFor(() => expect(alertModalRequest.value).toEqual({ price: 100 }));
  });

  it("lists indicator alerts with their label and a waiting for data badge", async () => {
    loadAllServerAlerts.mockReturnValue([indAlert({ status: "waiting_for_data" })]);

    render(<MobileAlertsView />);

    expect(screen.getByText("Crossing Up EMA 50 (1H)")).toBeTruthy();
    expect(screen.getByText("ema cross")).toBeTruthy();
    expect(screen.getByText("waiting for data")).toBeTruthy();

    await userEvent.click(screen.getByText("Crossing Up EMA 50 (1H)"));
    expect(indicatorAlertRequest.value).toEqual({ mode: "edit", id: "ind1" });
  });

  it("an evaluating indicator alert has no waiting badge; delete confirms then deletes", async () => {
    loadAllServerAlerts.mockReturnValue([indAlert({ status: "ok" })]);

    render(<MobileAlertsView />);
    expect(screen.queryByText("waiting for data")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /delete alert/i }));
    expect(confirmRequest.value?.message).toBe("Delete this alert on US100?");
    confirmRequest.value!.onConfirm();
    expect(deleteIndicatorAlert).toHaveBeenCalledWith("ind1");
  });
});

describe("MobileAlertsView History like the desktop", () => {
  beforeEach(() => {
    loadAllServerAlerts.mockReturnValue([]);
    loadAllAlerts.mockReturnValue([]);
    loadTriggered.mockReset();
    clearTriggered.mockReset();
    pushTriggeredSeen.mockReset();
    loadTriggeredSeen.mockReturnValue(Number.MAX_SAFE_INTEGER);
  });

  function fired(over: Partial<TriggeredAlert> = {}): TriggeredAlert {
    return {
      time: Date.now() - 5 * 60_000,
      epic: "US100",
      condition: "crossing",
      level: 100,
      price: 100.2,
      message: "",
      precision: 2,
      ...over,
    };
  }

  async function openHistory() {
    render(<MobileAlertsView />);
    await userEvent.click(screen.getByRole("button", { name: "History" }));
  }

  it("caps the unseen count at 99+", () => {
    loadTriggeredSeen.mockReturnValue(0);
    loadTriggered.mockReturnValue(Array.from({ length: 120 }, (_, k) => fired({ time: 1000 + k })));
    render(<MobileAlertsView />);
    expect(document.querySelector(".m-seg-count")?.textContent).toBe("99+");
  });

  it("shows relative times", async () => {
    loadTriggered.mockReturnValue([fired()]);
    await openHistory();
    expect(screen.getByText("5m ago")).toBeTruthy();
  });

  it("names an account firing by its account", async () => {
    loadTriggered.mockReturnValue([
      fired({ epic: "", kind: "account", broker: "capital-live:live", headline: "Margin level 118% < 120% (danger)" }),
    ]);
    await openHistory();
    expect(screen.getByText(accountLabel("capital-live:live"))).toBeTruthy();
    expect(screen.getByText("Margin level 118% < 120% (danger)")).toBeTruthy();
  });

  it("badges a firing on another broker only", async () => {
    loadTriggered.mockReturnValue([fired({ broker: "ig", time: Date.now() - 1000 }), fired({ epic: "DE40" })]);
    await openHistory();
    const rows = document.querySelectorAll(".m-alerts-hist");
    expect(rows[0].querySelector(".m-alerts-broker")?.textContent).toBe(brokerLabel("ig"));
    expect(rows[1].querySelector(".m-alerts-broker")).toBeNull();
  });

  it("clears history, and offers no Clear on an empty list", async () => {
    loadTriggered.mockReturnValue([fired()]);
    clearTriggered.mockImplementation(() => loadTriggered.mockReturnValue([]));
    await openHistory();
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(clearTriggered).toHaveBeenCalled();
    expect(screen.getByText("No alerts have triggered yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear history" })).toBeNull();
  });

  it("counts unseen firings on the History button and marks them seen when opened", async () => {
    loadTriggeredSeen.mockReturnValue(0);
    const newest = Date.now() - 1000;
    loadTriggered.mockReturnValue([fired({ time: newest }), fired()]);
    render(<MobileAlertsView />);
    expect(document.querySelector(".m-seg-count")?.textContent).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(pushTriggeredSeen).toHaveBeenCalledWith(newest);
  });

  it("tapping a symbol row opens its chart through openMobileAlert", async () => {
    openMobileAlert.mockReset();
    loadTriggered.mockReturnValue([fired({ broker: "ig", precision: 5 })]);
    await openHistory();
    await userEvent.click(screen.getByText("US100"));
    expect(openMobileAlert).toHaveBeenCalledWith("US100", "ig", 5);
  });

  it("tapping an account row opens nothing", async () => {
    openMobileAlert.mockReset();
    loadTriggered.mockReturnValue([fired({ epic: "", kind: "account", broker: "capital-live:live" })]);
    await openHistory();
    await userEvent.click(screen.getByText(accountLabel("capital-live:live")));
    expect(openMobileAlert).not.toHaveBeenCalled();
  });
});

describe("MobileAlertsView Active list like the desktop", () => {
  const acct = {
    kind: "account", id: "ac1", account: "capital-live:live", metric: "marginLevel",
    tiers: [{ level: 150, label: "warn" }, { level: 50, label: "critical" }],
    firedTiers: [150], monitored: false, unmonitoredReason: "Poll failing",
    message: "", expiresAt: null, precision: 2, current: 180, currency: "EUR",
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  } as unknown as AccountAlert;
  const posAl = {
    kind: "position", id: "po1", account: "capital:demo", epic: "US100", dealId: "D1",
    side: "tp", atrMult: 0.5, distanceAtr: 1.2, precision: 1,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  } as unknown as PositionAlert;

  beforeEach(() => {
    loadAllServerAlerts.mockReturnValue([]);
    loadAllAlerts.mockReturnValue([]);
    loadTriggered.mockReturnValue([]);
    loadAccountAlerts.mockReturnValue([]);
    loadPositionAlerts.mockReturnValue([]);
    deleteAccountAlert.mockReset();
    deletePositionAlert.mockReset();
  });
  afterEach(() => {
    accountAlertRequest.set(null);
    positionAlertRequest.set(null);
  });

  it("shows a trigger badge on a price row", () => {
    loadAllAlerts.mockReturnValue([{ epic: "US100", alerts: [alert({ trigger: "once" })] }]);
    render(<MobileAlertsView />);
    expect(document.querySelector(".m-alerts-trigger")?.textContent).toBe(TRIGGER_LABELS.once);
  });

  it("drops an expired price alert", () => {
    loadAllAlerts.mockReturnValue([{ epic: "US100", alerts: [alert({ expiresAt: Date.now() - 1000 })] }]);
    render(<MobileAlertsView />);
    expect(screen.getByText("No active alerts.")).toBeTruthy();
  });

  it("formats an off-chart level with its own decimals", () => {
    mobileSymbol.set({ epic: "US100", pricePrecision: 2 } as never);
    loadAllAlerts.mockReturnValue([{ epic: "EURUSD", alerts: [alert({ level: 1.08234 })] }]);
    render(<MobileAlertsView />);
    expect(screen.getByText(/1\.08234/)).toBeTruthy();
  });

  it("lists Account then Positions above the symbol alerts", () => {
    loadAccountAlerts.mockReturnValue([acct]);
    loadPositionAlerts.mockReturnValue([posAl]);
    loadAllAlerts.mockReturnValue([{ epic: "US100", alerts: [alert()] }]);
    render(<MobileAlertsView />);
    const heads = [...document.querySelectorAll(".m-alerts-group")].map((h) => h.textContent);
    expect(heads).toEqual(["Account", "Positions"]);
    const tiers = document.querySelectorAll(".m-alerts-tier");
    expect(tiers).toHaveLength(2);
    expect(tiers[0].classList.contains("fired")).toBe(true);
    expect(screen.getByText("Unmonitored")).toBeTruthy();
    expect(screen.getByText("TP · 0.5× ATR · now 1.2 ATR")).toBeTruthy();
  });

  it("tapping account and position rows opens their editors", async () => {
    loadAccountAlerts.mockReturnValue([acct]);
    loadPositionAlerts.mockReturnValue([posAl]);
    render(<MobileAlertsView />);
    await userEvent.click(screen.getByText(accountLabel("capital-live:live")));
    expect(accountAlertRequest.value).toEqual({ mode: "edit", id: "ac1" });
    await userEvent.click(screen.getByText("TP · 0.5× ATR · now 1.2 ATR"));
    expect(positionAlertRequest.value).toEqual({ account: "capital:demo", epic: "US100", dealId: "D1", precision: 1 });
  });

  it("Delete confirms with the desktop's text, then deletes", async () => {
    loadAccountAlerts.mockReturnValue([acct]);
    loadPositionAlerts.mockReturnValue([posAl]);
    render(<MobileAlertsView />);
    await userEvent.click(screen.getByRole("button", { name: `Delete alert on ${accountLabel("capital-live:live")}` }));
    expect(confirmRequest.value?.message).toBe(`Delete this ${METRIC_LABELS.marginLevel} alert on ${accountLabel("capital-live:live")}?`);
    confirmRequest.value!.onConfirm();
    expect(deleteAccountAlert).toHaveBeenCalledWith("ac1");
    await userEvent.click(screen.getByRole("button", { name: "Delete TP warning on US100" }));
    expect(confirmRequest.value?.message).toBe("Delete this TP warning on US100?");
    confirmRequest.value!.onConfirm();
    expect(deletePositionAlert).toHaveBeenCalledWith("po1");
  });

  it("takes an epic's indicator alert precision into the guess, as the desktop does", () => {
    mobileSymbol.set({ epic: "US100", pricePrecision: 2 } as never);
    loadAllAlerts.mockReturnValue([{ epic: "EURUSD", alerts: [alert({ level: 1.1 })] }]);
    loadAllServerAlerts.mockReturnValue([indAlert({ epic: "EURUSD", precision: 5 })]);
    render(<MobileAlertsView />);
    expect(screen.getByText(/1\.10000/)).toBeTruthy();
  });

  it("shows the Unmonitored reason as text on a phone", () => {
    loadAccountAlerts.mockReturnValue([acct]);
    render(<MobileAlertsView />);
    expect(screen.getByText("Poll failing")).toBeTruthy();
  });
});
