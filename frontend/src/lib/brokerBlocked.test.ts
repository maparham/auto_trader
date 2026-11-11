import { describe, it, expect, vi, beforeEach } from "vitest";

const toast = vi.fn();
const dismissToast = vi.fn();
vi.mock("./notify", () => ({ toast, dismissToast }));

const { reportBrokerOutage, reportBrokerReachable } = await import("./brokerBlocked");

describe("reportBrokerOutage", () => {
  beforeEach(() => {
    reportBrokerReachable();
    toast.mockClear();
    dismissToast.mockClear();
  });

  it("shows the broker's own message in place of the generic text", () => {
    reportBrokerOutage("broker", "MT5", "The MT5 terminal is not logged in.");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe("MT5: The MT5 terminal is not logged in.");
  });

  it("does not re-toast the same message on every poll", () => {
    reportBrokerOutage("broker", "MT5", "Logged out.");
    reportBrokerOutage("broker", "MT5", "Logged out.");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("swaps a generic outage toast for the broker's message", () => {
    reportBrokerOutage("broker", "MT5");
    reportBrokerOutage("broker", "MT5", "Logged out.");
    expect(toast).toHaveBeenCalledTimes(2);
    expect(dismissToast).toHaveBeenCalledTimes(1);
  });
});
