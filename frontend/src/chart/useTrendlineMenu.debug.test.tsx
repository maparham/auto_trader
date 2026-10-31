// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
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
const configs: Record<string, Record<string, { extendData?: Record<string, unknown> }>> = {};
vi.mock("../lib/persist", () => ({
  loadIndicatorConfigs: (scope: string) => configs[scope] ?? {},
  saveIndicatorConfig: (scope: string, name: string, cfg: { extendData?: Record<string, unknown> }) => {
    (configs[scope] ??= {})[name] = cfg;
  },
}));

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
  beforeEach(() => { hit.seg.key = "dbg:1|2"; });
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

function setupReal(blocked = false) {
  const el = document.createElement("div");
  return renderHook(() =>
    useTrendlineMenu({
      chartRef: { current: { getIndicators: () => [{ name: "TL", paneId: "candle_pane", extendData: {} }] } as never },
      containerRef: { current: el }, scope: "s", epicRef: { current: "E" },
      overlays: { isDrawing: () => false, peekOverlayRightClick: () => false } as never,
      lineAlert: {
        ctx: { current: { epic: "E", broker: "b", precision: 2 } },
        resolutionRef: { current: "HOUR" }, blocked: () => blocked,
      },
    }),
  );
}

describe("useTrendlineMenu on a real line", () => {
  afterEach(cleanup);
  beforeEach(() => { hit.seg.key = "1:2"; });
  it("offers Add alert, disabled with the reason when the line can't take one", () => {
    const { result } = setupReal();
    act(() => { result.current.openAt(10, 10); });
    render(<>{result.current.menu}</>);
    const item = screen.getByText("Add alert").closest("button");
    expect(item?.hasAttribute("disabled") || item?.getAttribute("aria-disabled") === "true").toBe(true);
  });
  it("a blocked chart (demo, snapshot) has no Add alert", () => {
    const { result } = setupReal(true);
    act(() => { result.current.openAt(10, 10); });
    render(<>{result.current.menu}</>);
    expect(screen.queryByText("Add alert")).toBeNull();
    expect(screen.getByText("Highlight")).toBeTruthy();
  });
});

describe("useTrendlineMenu line notes", () => {
  afterEach(() => { cleanup(); delete configs.s; });
  beforeEach(() => { hit.seg.key = "1:2"; });
  it("Add note saves the note per epic; an empty one clears it", () => {
    const { result, rerender } = setupReal();
    act(() => { result.current.openAt(10, 10); });
    const view = render(<>{result.current.menu}</>);
    act(() => { fireEvent.click(screen.getByText("Add note")); });
    rerender();
    view.rerender(<>{result.current.menu}</>);
    const input = screen.getByLabelText("Line note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "retest zone" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(configs.s?.TL?.extendData?.lineMarks).toEqual({ E: { notes: { "1:2": "retest zone" } } });

    act(() => { result.current.openAt(10, 10); });
    view.rerender(<>{result.current.menu}</>);
    act(() => { fireEvent.click(screen.getByText("Edit note")); });
    view.rerender(<>{result.current.menu}</>);
    const again = screen.getByLabelText("Line note") as HTMLInputElement;
    expect(again.value).toBe("retest zone");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(configs.s?.TL?.extendData?.lineMarks).toBeUndefined();
  });
});
