// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { firedDetail } from "./useAlertFiredNotices";

const toast = vi.fn();
const notify = vi.fn();
vi.mock("../lib/notify", async (orig) => ({
  ...(await orig<typeof import("../lib/notify")>()),
  toast: (...a: unknown[]) => toast(...a),
  notify: (...a: unknown[]) => notify(...a),
  playPing: () => {},
}));
const toggleSidePanel = vi.fn();
vi.mock("../lib/signals", async (orig) => ({
  ...(await orig<typeof import("../lib/signals")>()),
  toggleSidePanel: (...a: unknown[]) => toggleSidePanel(...a),
}));

let fired: ((p: unknown) => void) | null = null;
let monitor: ((p: unknown) => void) | null = null;
vi.mock("../lib/persist", () => ({ setOnAlertFired: (fn: typeof fired) => { fired = fn; } }));
vi.mock("../lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("../lib/alertsApi")>()),
  setOnAccountMonitor: (fn: typeof monitor) => { monitor = fn; },
}));

const { useAlertFiredNotices } = await import("./useAlertFiredNotices");

describe("firedDetail", () => {
  it("price alerts keep the level", () => {
    expect(firedDetail({ level: 100, message: "", condition: "crossing" } as never, 2)).toBe("@ 100.00");
  });
  it("indicator alerts name the indicator", () => {
    expect(firedDetail({ level: 70, message: "", condition: "greater", label: "RSI 14 (1H)", target: "value" } as never, 2))
      .toBe("RSI 14 (1H) Greater Than 70");
    // fmtPrice groups thousands (priceFormat.ts), same as every other price
    // readout on the chart - "21400.0" (ungrouped) would be the one price
    // display in the app that doesn't match the axis/tags (F3).
    expect(firedDetail({ level: 21400, message: "", condition: "crossing_up", label: "EMA 50 (1H)", target: "price" } as never, 1))
      .toBe("Crossing Up EMA 50 (1H) 21,400.0");
  });
  it("value levels use the panel's 6 significant digit format", () => {
    expect(firedDetail({ level: 0.00005, message: "", condition: "greater", label: "ATR 14 (1m)", target: "value" } as never, 6))
      .toBe("ATR 14 (1m) Greater Than 0.00005");
  });
  it("a custom message wins", () => {
    expect(firedDetail({ level: 70, message: "rsi hot", label: "RSI 14 (1H)" } as never, 2)).toBe("rsi hot");
  });
});

describe("account alert notices", () => {
  beforeEach(() => {
    toast.mockClear();
    notify.mockClear();
    toggleSidePanel.mockClear();
  });

  it("toasts the headline, opens the trade list on click, never navigates to a chart", () => {
    renderHook(() => useAlertFiredNotices());
    fired!({ id: "al-a1", broker: "capital-live:live", epic: "", kind: "account", price: 118.4, level: 120,
      condition: "below", message: "", precision: 2, notify: {}, headline: "MARGIN LEVEL 118.4% < 120% (danger) · Capital live", critical: false });
    expect(toast).toHaveBeenCalledTimes(1);
    const [text, opts] = toast.mock.calls[0] as [string, { onClick?: () => void }];
    expect(text).toContain("MARGIN LEVEL 118.4%");
    opts.onClick?.();
    expect(toggleSidePanel).toHaveBeenCalledWith("tradeList");
  });

  it("monitor events toast without channel gates", () => {
    renderHook(() => useAlertFiredNotices());
    monitor!({ broker: "capital-live:live", status: "unmonitored", reason: "session dropped", headline: "Capital live is not being monitored: session dropped" });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls.at(-1)![0]).toContain("not being monitored");
  });

  it("firedDetail still formats price alerts", () => {
    expect(firedDetail({ id: "x", broker: "b", epic: "E", price: 1, level: 2, condition: "crossing", message: "", precision: 2, notify: {} } as never, 2)).toBe("@ 2.00");
  });
});
