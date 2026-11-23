// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

const hit = {
  paneId: "candle_pane", name: "TL",
  seg: { key: "1:2", x0: 0, y0: 0, x1: 100, y1: 100, clone: () => null },
};
const { admin } = vi.hoisted(() => ({ admin: { value: true } }));
vi.mock("../lib/indicators/trendlineMarks", async (orig) => ({
  ...(await orig<typeof import("../lib/indicators/trendlineMarks")>()),
  hitTrendline: () => hit,
}));
vi.mock("../lib/overrideExtend", () => ({ overrideExtend: vi.fn() }));
vi.mock("../lib/persist", () => ({ loadIndicatorConfigs: () => ({}), saveIndicatorConfig: vi.fn() }));
vi.mock("./lineAlertDraft", () => ({
  buildLineAlertDraft: () => ({ draft: { epic: "E", marker: "d" } }),
}));
vi.mock("../lib/trading", async (orig) => ({
  ...(await orig<typeof import("../lib/trading")>()),
  isAdminAccount: () => admin.value,
}));

import { useTrendlineMenu } from "./useTrendlineMenu";
import { lineAlertRequest, tradesSignal } from "../lib/signals";
import type { TradeView } from "../lib/trading";

const pos = (epic: string): TradeView => ({
  kind: "position", id: "d1", epic, side: "buy", quantity: 1, priceLevel: 100, stop: null, takeProfit: null,
  upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null,
});

function open() {
  const el = document.createElement("div");
  const { result } = renderHook(() =>
    useTrendlineMenu({
      chartRef: { current: { getIndicators: () => [{ name: "TL", paneId: "candle_pane", extendData: {} }] } as never },
      containerRef: { current: el }, scope: "s", epicRef: { current: "E" },
      overlays: { isDrawing: () => false, peekOverlayRightClick: () => false } as never,
      lineAlert: {
        ctx: { current: { epic: "E", broker: "b", precision: 2 } },
        resolutionRef: { current: "HOUR" }, blocked: () => false,
      },
    }),
  );
  act(() => { result.current.openAt(10, 10); });
  render(<>{result.current.menu}</>);
}

describe("Trendline menu move items", () => {
  beforeEach(() => { admin.value = true; });
  afterEach(() => { cleanup(); tradesSignal.set([]); lineAlertRequest.set(null); });

  it("has no move items without an open position on the epic", () => {
    tradesSignal.set([pos("OTHER")]);
    open();
    expect(screen.getByText("Add alert")).toBeTruthy();
    expect(screen.queryByText("Move SL when crossed…")).toBeNull();
  });

  it("has no move items for a non-admin", () => {
    admin.value = false;
    tradesSignal.set([pos("E")]);
    open();
    expect(screen.queryByText("Move TP when crossed…")).toBeNull();
  });

  it("opens the line modal with the move preselected", () => {
    tradesSignal.set([pos("E")]);
    open();
    fireEvent.click(screen.getByText("Move TP when crossed…"));
    expect(lineAlertRequest.value).toMatchObject({ mode: "create", move: { field: "tp" } });
    expect(screen.getByText("Move SL when crossed…")).toBeTruthy();
  });
});
