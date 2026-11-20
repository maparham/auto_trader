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
const loadTriggeredSeen = vi.fn(() => 0);
const pushTriggeredSeen = vi.fn();
vi.mock("../lib/alertsApi", async (orig) => ({
  ...(await orig<object>()),
  clearTriggered: (...args: unknown[]) => clearTriggered(...args),
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
} from "../lib/signals";
import { accountLabel, type IndicatorAlert, type SavedAlert, type TriggeredAlert } from "../lib/alertsApi";
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
