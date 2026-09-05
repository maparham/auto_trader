// @vitest-environment jsdom
//
// The Long/Short Position drawing's own settings: which label groups it paints
// and the account it sizes the risk against. Everything here writes through
// OverlayManager.setTradeConfig, which is what persists it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import DrawingSettings from "./DrawingSettings";
import type { OverlayManager } from "./lib/overlays";
import { asTradeConfig, type TradeConfig } from "./lib/tradePlan";

const setTradeConfig = vi.fn();
const setText = vi.fn();
let stored: TradeConfig | undefined;

const overlays = {
  getDrawing: () => ({
    name: "tradeBox",
    points: [
      { timestamp: 1_750_000_000_000, value: 100, dataIndex: 4 },
      { timestamp: 1_750_000_600_000, value: 102, dataIndex: 14 },
      { timestamp: 1_750_000_600_000, value: 99, dataIndex: 14 },
    ],
    styles: { line: { color: "#2962ff", size: 1, style: "solid" } },
    lock: false,
    visible: true,
    zLevel: 0,
    extendData: { trade: stored },
  }),
  setStyle: () => {},
  setPoint: () => {},
  setTradeConfig,
  setText,
  onIdRemap: () => () => {},
} as unknown as OverlayManager;

function open() {
  render(
    <DrawingSettings overlays={overlays} id="draw-1" onIdChange={() => {}} onClose={() => {}} />,
  );
}

// The config the component last wrote.
const lastWrite = (): TradeConfig => setTradeConfig.mock.calls.at(-1)![1];

beforeEach(() => {
  stored = undefined;
  setTradeConfig.mockClear();
  setText.mockClear();
});
afterEach(cleanup);

describe("the Trade box settings", () => {
  it("is titled for the tool, which draws either direction", () => {
    open();
    expect(screen.getByText("Trade box")).toBeTruthy();
  });

  it("offers a Text tab, so a caption can be typed and not only set by an agent", () => {
    open();
    expect(screen.getByText("Text")).toBeTruthy();
    expect(screen.getByText("Coordinates")).toBeTruthy();
  });

  it("writes a typed caption through to the drawing", () => {
    open();
    fireEvent.click(screen.getByText("Text"));
    fireEvent.change(screen.getByPlaceholderText("Add text…"), {
      target: { value: "A+ setup" },
    });
    expect(setText.mock.calls.at(-1)?.[1]).toBe("A+ setup");
  });

  it("offers no midpoint marker — that is a line affordance, not a box one", () => {
    open();
    fireEvent.click(screen.getByText("Text"));
    expect(screen.queryByText("Show midpoint marker")).toBeNull();
  });

  it("turns a label group on", () => {
    open();
    fireEvent.click(screen.getByLabelText("Show level prices"));
    expect(lastWrite()).toMatchObject({ showPrice: true });
  });

  it("keeps the other groups as they were when one is toggled", () => {
    stored = { ...asTradeConfig(undefined), showDuration: true };
    open();
    fireEvent.click(screen.getByLabelText("Show point distance"));
    expect(lastWrite()).toMatchObject({ showPoints: true, showDuration: true });
  });

  it("takes a per-drawing account size override", () => {
    open();
    fireEvent.change(screen.getByLabelText("Account size"), { target: { value: "50000" } });
    expect(lastWrite()).toMatchObject({ accountSize: 50000 });
  });

  it("clears the override back to the live account when the field is emptied", () => {
    stored = { ...asTradeConfig(undefined), accountSize: 50000 };
    open();
    fireEvent.change(screen.getByLabelText("Account size"), { target: { value: "" } });
    expect(lastWrite()).toMatchObject({ accountSize: null });
  });

  it("takes the risk budget as a percent", () => {
    open();
    fireEvent.change(screen.getByLabelText("Risk per trade %"), { target: { value: "2.5" } });
    expect(lastWrite()).toMatchObject({ riskPct: 2.5 });
  });

  it("takes the instrument's value per point, since sizing cannot infer it", () => {
    open();
    fireEvent.change(screen.getByLabelText("Value per point"), { target: { value: "20" } });
    expect(lastWrite()).toMatchObject({ valuePerPoint: 20 });
  });
});
