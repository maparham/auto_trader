// @vitest-environment jsdom
// A drag of a Move SL / Move TP line (`move:` ids, lib/moveRuleLines) moves the
// rule's line only. It must never stage a real SL/TP edit (pendingEditsSignal),
// which no-confirm mode would send to the broker on the drop.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Chart } from "klinecharts";

vi.mock("../lib/moveRuleLines", async (orig) => {
  const real = await orig<typeof import("../lib/moveRuleLines")>();
  return {
    ...real,
    applyMoveLineDrag: vi.fn(),
    endMoveLineDrag: vi.fn(async () => {}),
    abortMoveLineDrag: vi.fn(),
  };
});

import { useLineDrag, type LineDragDeps, type TradeLinePx } from "./useLineDrag";
import { applyMoveLineDrag, endMoveLineDrag } from "../lib/moveRuleLines";
import { pendingEditsSignal, draggingLineSignal, Signal } from "../lib/signals";
import type { ChartHandle } from "./chartHandle";
import type { SelectedIndicator } from "../lib/chartController";
import type { OverlayManager } from "../lib/overlays";
import type { IndicatorAlertLines } from "../lib/overlays/indicatorAlerts";

const MOVE_ID = "move:draft:sl:trigger";
const LINE_Y = 50;

// y pixel -> price: 100 at y=0, falling 0.1 per px.
const fakeChart = {
  getSize: () => ({ width: 1000 }),
  convertFromPixel: (pts: { y?: number }[]) => pts.map((p) => ({ value: 100 - (p.y ?? 0) / 10 })),
  convertToPixel: (pts: { value?: number }[]) => pts.map((p) => ({ y: (100 - (p.value ?? 0)) * 10 })),
  getIndicators: () => [],
  getDataList: () => [],
} as unknown as Chart;

const ref = <T,>(current: T) => ({ current });

function setup() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const draggingTradeRef = ref<string | null>(null);
  const line: TradeLinePx = {
    id: MOVE_ID, field: "stop", level: 95, draggable: true, y: LINE_Y,
    emphasized: false, fullWidth: true, anchorX: null,
  };
  const handle = {
    chartRef: ref(fakeChart),
    tradesRef: ref([]),
    epicRef: ref("EURUSD"),
    replayRef: ref(null),
    paintBracketRef: ref(() => {}),
    posDrawRef: ref(() => {}),
    redrawRef: ref(() => {}),
  } as unknown as ChartHandle;
  const deps: LineDragDeps = {
    containerRef: ref(el),
    scope: "test",
    avwapAnchorMode: new Signal<string | null>(null),
    measureArmed: new Signal(false),
    slopeArmed: new Signal(false),
    selectedIndicator: new Signal<SelectedIndicator | null>(null),
    overlays: {
      isMeasureDrawing: () => false,
      isSlopeDrawing: () => false,
      getAlertsHidden: () => false,
      getAlerts: () => [],
    } as unknown as OverlayManager,
    indicatorAlerts: { lines: () => [] } as unknown as IndicatorAlertLines,
    ANCHOR_GRAB_PX: 8,
    precisionRef: ref(2),
    confirmLineEditsRef: ref(false),
    cursorModeRef: ref(""),
    draggingAnchorRef: ref(false),
    dragMovedRef: ref(false),
    justDraggedRef: ref(false),
    anchorPxRef: ref(null),
    pendingAnchorXRef: ref(0),
    anchorRafRef: ref(0),
    draggingTradeRef,
    setCursorMode: () => {},
    setTradeSelectedFn: vi.fn(),
    tradeLinePixelsRef: ref(() => [line]),
    tradePillHitTest: () => null,
    tradeDragActiveRef: ref(() => false),
    alertDragActiveRef: ref(() => false),
  };
  const hook = renderHook(() => useLineDrag(handle, deps));
  return { el, hook, draggingTradeRef, deps };
}

describe("useLineDrag: move: lines", () => {
  beforeEach(() => {
    pendingEditsSignal.set({});
    draggingLineSignal.set(false);
    vi.mocked(applyMoveLineDrag).mockClear();
    vi.mocked(endMoveLineDrag).mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves the rule line and never stages a real SL/TP edit", () => {
    const { el, hook, draggingTradeRef, deps } = setup();
    const before = pendingEditsSignal.value;

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: LINE_Y, bubbles: true }));
    expect(deps.tradeDragActiveRef.current()).toBe(true);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 40 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 30 }));

    expect(applyMoveLineDrag).toHaveBeenCalledWith(MOVE_ID, 97);
    expect(pendingEditsSignal.value).toBe(before);
    expect(draggingTradeRef.current).toBeNull();
    expect(endMoveLineDrag).not.toHaveBeenCalled();

    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 30 }));

    expect(endMoveLineDrag).toHaveBeenCalledTimes(1);
    expect(endMoveLineDrag).toHaveBeenCalledWith(MOVE_ID);
    expect(pendingEditsSignal.value).toBe(before);
    expect(draggingLineSignal.value).toBe(false);
    hook.unmount();
  });
});
