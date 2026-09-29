// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";

vi.mock("../lib/indicators/trendlines", () => ({
  getTrendlineHandles: () => [],
  hitHandle: () => "line-key",
}));

import { useTrendlinePins } from "./useTrendlinePins";

const chart = {
  getIndicators: () => [{ paneId: "candle_pane", name: "TRENDLINES" }],
} as unknown as Chart;

function setup(hoveredDrawingId: string | null) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const overlays = {
    getHoveredDrawingId: () => hoveredDrawingId,
  } as unknown as OverlayManager;
  renderHook(() =>
    useTrendlinePins({
      chartRef: { current: chart },
      containerRef: { current: el },
      overlays,
    }),
  );
  const target = document.createElement("canvas");
  el.appendChild(target);
  const reached = vi.fn();
  target.addEventListener("mousedown", reached);
  return { target, reached };
}

describe("useTrendlinePins press arbitration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("claims a press on a pin handle when nothing is drawn over it", () => {
    const { target, reached } = setup(null);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(reached).not.toHaveBeenCalled();
  });

  it("lets a drawing painted over the handle take the press", () => {
    const { target, reached } = setup("overlay_1");
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(reached).toHaveBeenCalledTimes(1);
  });
});
