// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const loadAllAlerts = vi.fn();
const deleteStoredAlert = vi.fn();
const loadTriggered = vi.fn();
vi.mock("../lib/alertsApi", async (orig) => ({
  ...(await orig<object>()),
  loadAllAlerts: (...args: unknown[]) => loadAllAlerts(...args),
  deleteStoredAlert: (...args: unknown[]) => deleteStoredAlert(...args),
  loadTriggered: (...args: unknown[]) => loadTriggered(...args),
}));

const fetchQuote = vi.fn();
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<object>()),
  fetchQuote: (...args: unknown[]) => fetchQuote(...args),
}));

import MobileAlertsView from "./MobileAlertsView";
import { mobileSymbol } from "./mobileChartState";
import {
  confirmRequest,
  alertGlobalEditRequest,
  alertModalRequest,
} from "../lib/signals";
import type { SavedAlert, TriggeredAlert } from "../lib/alertsApi";

afterEach(() => {
  cleanup();
  confirmRequest.set(null);
  alertGlobalEditRequest.set(null);
  alertModalRequest.set(null);
  mobileSymbol.set(null);
});

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
    fetchQuote.mockReset();
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
});
