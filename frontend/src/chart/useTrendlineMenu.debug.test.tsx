// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useTrendlineMenu } from "./useTrendlineMenu";

const hit = {
  paneId: "candle_pane", name: "TL",
  seg: { key: "dbg:1|2", x0: 0, y0: 0, x1: 100, y1: 100, clone: () => null },
};
vi.mock("../lib/indicators/trendlineMarks", async (orig) => ({
  ...(await orig<typeof import("../lib/indicators/trendlineMarks")>()),
  hitTrendline: () => hit,
}));
vi.mock("../lib/overrideExtend", () => ({ overrideExtend: vi.fn() }));

function setup(onDebugPick?: (...a: unknown[]) => boolean) {
  const el = document.createElement("div");
  const chartRef = { current: {} as never };
  const containerRef = { current: el };
  const overlays = { isDrawing: () => false, peekOverlayRightClick: () => false } as never;
  return renderHook(() =>
    useTrendlineMenu({ chartRef, containerRef, overlays, scope: "s", epicRef: { current: "E" }, onDebugPick }),
  );
}

describe("useTrendlineMenu on a debug line", () => {
  afterEach(cleanup);
  it("offers Explain and To drawing, never Highlight or Hide", () => {
    const pick = vi.fn(() => true);
    const { result, rerender } = setup(pick);
    expect(result.current.openAt(10, 10)).toBe(true);
    rerender();
    render(<>{result.current.menu}</>);
    expect(screen.queryByText("Highlight")).toBeNull();
    expect(screen.queryByText("Hide")).toBeNull();
    expect(screen.getByText("To drawing")).toBeTruthy();
    fireEvent.click(screen.getByText("Explain"));
    expect(pick).toHaveBeenCalledWith(hit, 10, 10);
  });
  it("without a debug popup there is no Explain", () => {
    const { result, rerender } = setup();
    expect(result.current.openAt(10, 10)).toBe(true);
    rerender();
    render(<>{result.current.menu}</>);
    expect(screen.queryByText("Explain")).toBeNull();
    expect(screen.getByText("To drawing")).toBeTruthy();
  });
});
