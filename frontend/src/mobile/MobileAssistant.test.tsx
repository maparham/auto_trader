// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

const installMobileAssistant = vi.fn();
vi.mock("./assistantSetup", () => ({
  installMobileAssistant: () => installMobileAssistant(),
  MOBILE_CELL_ID: "mobile",
}));
const panelProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("../AssistantPanel", () => ({
  default: (p: Record<string, unknown> & { onClose: () => void }) => {
    panelProps.last = p;
    return <button onClick={p.onClose}>close panel</button>;
  },
}));

import MobileAssistant from "./MobileAssistant";
import { assistantConfigured } from "../assistant/api";
import { mobilePeriod, mobileSymbol } from "./mobileChartState";

beforeEach(() => {
  installMobileAssistant.mockReset();
  panelProps.last = null;
  mobileSymbol.set({ epic: "US100", name: "US100", pricePrecision: 2 } as never);
  mobilePeriod.set({ resolution: "HOUR_4", label: "4H" } as never);
});
afterEach(() => {
  cleanup();
  assistantConfigured.set(false);
});

describe("MobileAssistant", () => {
  it("installs the phone's assistant and shows no button until it is configured", () => {
    render(<MobileAssistant />);
    expect(installMobileAssistant).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    act(() => assistantConfigured.set(true));
    expect(screen.getByRole("button", { name: "Assistant" })).toBeTruthy();
  });

  it("opens the panel on the phone's chart and closes it again", async () => {
    assistantConfigured.set(true);
    render(<MobileAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    await screen.findByRole("button", { name: "close panel" });
    expect(panelProps.last).toMatchObject({
      cellId: "mobile",
      cellIds: ["mobile"],
      chart: { epic: "US100", resolution: "HOUR_4" },
    });
    expect((panelProps.last!.examples as string[]).some((e) => /backtest/i.test(e))).toBe(false);
    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "close panel" }));
    expect(screen.queryByRole("button", { name: "close panel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Assistant" })).toBeTruthy();
  });
});
