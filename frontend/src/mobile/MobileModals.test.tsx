// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

vi.mock("../AlertModal", () => ({ default: () => <div data-testid="alert-modal" /> }));
vi.mock("../DrawingSettings", () => ({ default: () => <div data-testid="drawing-settings" /> }));
vi.mock("../IndicatorSettings", () => ({ default: () => <div data-testid="indicator-settings" /> }));
vi.mock("../ConfirmDialog", () => ({ default: () => <div data-testid="confirm" /> }));
vi.mock("../SymbolSearchModal", () => ({ default: () => <div data-testid="symbol-search" /> }));
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
import { mobileChartCtx, mobileSymbol, mobileTabSignal } from "./mobileChartState";

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
