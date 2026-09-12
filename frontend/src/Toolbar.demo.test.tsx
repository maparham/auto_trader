// @vitest-environment jsdom
// Finding 2 (public-demo fix wave): the Toolbar's Backtest/Live cluster
// (BacktestButton) fails with raw 401s in demo mode, since the demo
// principal has no write access. The cluster must not render at all.
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
  it("hides the Backtest cluster in demo mode", async () => {
    vi.doMock("./lib/demoMode", () => ({ isDemoMode: () => true, setDemoMode: () => {} }));
    const { default: Toolbar } = await import("./Toolbar");
    render(<Toolbar {...BASE_PROPS} />);
    expect(screen.queryByText("Backtest")).toBeNull();
  });

  it("shows the Backtest cluster outside demo mode", async () => {
    vi.doMock("./lib/demoMode", () => ({ isDemoMode: () => false, setDemoMode: () => {} }));
    const { default: Toolbar } = await import("./Toolbar");
    render(<Toolbar {...BASE_PROPS} />);
    expect(screen.queryByText("Backtest")).not.toBeNull();
  });
});
