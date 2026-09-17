// @vitest-environment jsdom
// Demo mode and the toolbar. Backtest stays VISIBLE for a demo visitor (the
// panel inside shows the published canned results and its Run controls are
// sign-up CTAs), while write-only controls such as the price-alert button
// (POST /api/alerts answers 401 for the demo principal) must not render.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

beforeAll(() => {
  // jsdom implements no ResizeObserver; several toolbar-adjacent bits probe it.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// The admin probe hits /whoami; jsdom has no fetch. Not an admin either way.
vi.mock("./admin/useIsAdmin", () => ({ useIsAdmin: () => false }));

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("./lib/demoMode");
});

const BASE_PROPS = {
  controller: null,
  symbol: { epic: "OIL_CRUDE", name: "Crude Oil", status: "TRADEABLE", type: "COMMODITIES" },
  period: { resolution: "MINUTE", label: "1m" },
  onSymbol: vi.fn(),
  onPeriod: vi.fn(),
  brokerId: "dukascopy",
  priceSide: "mid" as const,
  accounts: [],
  onSelectBroker: vi.fn(),
  maximized: false,
  onToggleMaximize: vi.fn(),
};

describe("Toolbar demo mode", () => {
  it("keeps Backtest but drops the alert button in demo mode", async () => {
    vi.doMock("./lib/demoMode", () => ({ isDemoMode: () => true, setDemoMode: () => {} }));
    const { default: Toolbar } = await import("./Toolbar");
    render(<Toolbar {...BASE_PROPS} />);
    expect(screen.queryByText("Backtest")).not.toBeNull();
    expect(document.querySelector(".toolbar .alert-btn")).toBeNull();
  });

  it("shows both outside demo mode", async () => {
    vi.doMock("./lib/demoMode", () => ({ isDemoMode: () => false, setDemoMode: () => {} }));
    const { default: Toolbar } = await import("./Toolbar");
    render(<Toolbar {...BASE_PROPS} />);
    expect(screen.queryByText("Backtest")).not.toBeNull();
    expect(document.querySelector(".toolbar .alert-btn")).not.toBeNull();
  });
});
