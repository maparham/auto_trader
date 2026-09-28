// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

vi.mock("../AlertModal", () => ({ default: () => <div data-testid="alert-modal" /> }));
vi.mock("../DrawingSettings", () => ({ default: () => <div data-testid="drawing-settings" /> }));
vi.mock("../IndicatorSettings", () => ({ default: () => <div data-testid="indicator-settings" /> }));
vi.mock("../ConfirmDialog", () => ({ default: () => <div data-testid="confirm" /> }));
// The pick epic is a hoisted ref (not a plain module-scope let) because
// vi.mock factories run before the rest of this file's top-level code.
const { mockPickEpic } = vi.hoisted(() => ({ mockPickEpic: { current: "NVDA" } }));
vi.mock("../SymbolSearchModal", () => ({
  default: ({ onPick, onClose }: { onPick: (s: { epic: string }) => void; onClose: () => void }) => (
    <div data-testid="symbol-search">
      <button onClick={() => onPick({ epic: mockPickEpic.current })}>pick</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));
vi.mock("../Settings", () => ({ default: () => <div data-testid="chart-settings" /> }));

import MobileModals from "./MobileModals";
import {
  alertModalRequest,
  drawingSettingsRequest,
  requestConfirm,
  confirmRequest,
  draftOrderSignal,
  stageChartOrder,
  symbolSearchRequest,
  openSettings,
} from "../lib/signals";
import {
  mobileChartCtx,
  mobileSymbol,
  mobileTabSignal,
  requestSymbolPick,
  symbolPickTarget,
} from "./mobileChartState";

describe("MobileModals", () => {
  beforeEach(() => {
    alertModalRequest.set(null);
    drawingSettingsRequest.set(null);
    confirmRequest.set(null);
    draftOrderSignal.set(null);
    mobileTabSignal.set("chart");
    mobileSymbol.set({ epic: "US100", name: "US 100" } as never);
    mobileChartCtx.set({ controller: { overlays: {}, scope: "mobile:US100" }, chart: {} } as never);
  });

  afterEach(cleanup);

  it("hosts the alert modal on alertModalRequest", () => {
    render(<MobileModals />);
    act(() => alertModalRequest.set({ price: 123 }));
    expect(screen.getByTestId("alert-modal")).toBeTruthy();
  });

  it("hosts confirm on requestConfirm", () => {
    render(<MobileModals />);
    act(() => requestConfirm({ message: "sure?", onConfirm: () => {} }));
    expect(screen.getByTestId("confirm")).toBeTruthy();
  });

  it("routes a staged chart order to the trade tab", () => {
    render(<MobileModals />);
    act(() => stageChartOrder({ epic: "US100", side: "buy", price: 100 }));
    expect(mobileTabSignal.value).toBe("trade");
  });

  it("hosts drawing settings when a controller with overlays is present", () => {
    render(<MobileModals />);
    act(() => drawingSettingsRequest.set({ id: "d1" }));
    expect(screen.getByTestId("drawing-settings")).toBeTruthy();
  });

  it("hosts the symbol search modal on symbolSearchRequest", () => {
    render(<MobileModals />);
    act(() => symbolSearchRequest.set(symbolSearchRequest.value + 1));
    expect(screen.getByTestId("symbol-search")).toBeTruthy();
  });

  it("hosts the chart settings modal on settingsRequest (context-menu Settings)", () => {
    render(<MobileModals />);
    expect(screen.queryByTestId("chart-settings")).toBeNull();
    act(() => openSettings());
    expect(screen.getByTestId("chart-settings")).toBeTruthy();
  });
});

describe("symbol pick routing", () => {
  beforeEach(() => {
    render(<MobileModals />);
  });

  afterEach(cleanup);

  async function pickSymbol(epic: string) {
    mockPickEpic.current = epic;
    const btn = await screen.findByText("pick");
    fireEvent.click(btn);
  }

  async function closeSymbolSearch() {
    const btn = await screen.findByText("close");
    fireEvent.click(btn);
  }

  it("a pending pick target gets the symbol instead of the chart", async () => {
    const got: string[] = [];
    mobileSymbol.set(null);
    act(() => requestSymbolPick((s) => got.push(s.epic)));
    // pick "NVDA" through the mocked modal
    await pickSymbol("NVDA");
    expect(got).toEqual(["NVDA"]);
    expect(mobileSymbol.value).toBeNull();
    expect(symbolPickTarget.value).toBeNull();
  });

  it("closing the modal drops the pending target", async () => {
    act(() => requestSymbolPick(() => {}));
    await closeSymbolSearch();
    expect(symbolPickTarget.value).toBeNull();
  });

  it("with no pending pick target, a pick switches the chart's symbol", async () => {
    symbolPickTarget.set(null);
    mobileSymbol.set(null);
    act(() => symbolSearchRequest.set(symbolSearchRequest.value + 1));
    await pickSymbol("NVDA");
    expect(symbolPickTarget.value).toBeNull();
    expect(mobileSymbol.value?.epic).toBe("NVDA");
  });
});
