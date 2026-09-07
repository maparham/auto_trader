// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("klinecharts", async (orig) => ({
  ...(await orig<object>()),
  getSupportedOverlays: () => ["segment", "rect", "horizontalStraightLine"],
}));

import MobileDrawBar from "./MobileDrawBar";
import { mobileChartCtx } from "./mobileChartState";

afterEach(cleanup);

describe("MobileDrawBar", () => {
  const addDrawing = vi.fn();
  beforeEach(() => {
    addDrawing.mockClear();
    mobileChartCtx.set({
      chart: {},
      controller: {
        overlays: { addDrawing, getSelectedDrawingId: () => null },
        focusChart: vi.fn(),
      },
    } as never);
  });

  it("arms a tool through OverlayManager.addDrawing", async () => {
    render(<MobileDrawBar />);
    await userEvent.click(screen.getByRole("button", { name: "Draw" }));
    await userEvent.click(screen.getByRole("button", { name: "Trend line" }));
    expect(addDrawing).toHaveBeenCalledWith("segment");
  });

  it("hides tools klinecharts does not support", async () => {
    render(<MobileDrawBar />);
    await userEvent.click(screen.getByRole("button", { name: "Draw" }));
    expect(screen.queryByRole("button", { name: "Fib retracement" })).toBeNull();
  });
});
