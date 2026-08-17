// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const InsetBandResizer = (await import("./InsetBandResizer")).default;
const { insetBandFraction, setInsetBandFraction, INSET_BAND_FRACTION } = await import(
  "./lib/indicators/inset"
);

afterEach(cleanup);

// A 400px candle pane, so the pixel→fraction arithmetic is readable: 40px = 0.1.
const stubChart = () =>
  ({
    getSize: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    resize: vi.fn(),
  }) as unknown as import("klinecharts").Chart;

function mount(chart: import("klinecharts").Chart, onCommit = vi.fn(), onRepaint = vi.fn()) {
  render(
    <InsetBandResizer
      box={{ top: 288, left: 0, width: 600, height: 112 }}
      getChart={() => chart}
      onRepaint={onRepaint}
      onCommit={onCommit}
    />,
  );
  const handle = screen.getByRole("separator", { name: /resize the inset band/i });
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  return { handle, onCommit, onRepaint };
}

// The component drives repaints through rAF; run them by hand so the assertions are
// not racing a frame.
function withFrames<T>(fn: (flush: () => void) => T): T {
  const frames: FrameRequestCallback[] = [];
  const raf = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((cb) => { frames.push(cb); return frames.length; });
  try {
    return fn(() => act(() => frames.splice(0).forEach((cb) => cb(0))));
  } finally {
    raf.mockRestore();
  }
}

describe("InsetBandResizer", () => {
  it("grows the band when dragged up, and repaints once per frame", () => {
    withFrames((flush) => {
      const chart = stubChart();
      const { handle, onRepaint } = mount(chart);
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 300 });
      act(() => {
        // Three moves inside one frame: 300 -> 280 -> 270 -> 260, a net 40px up.
        for (const clientY of [280, 270, 260])
          handle.dispatchEvent(new MouseEvent("pointermove", { clientY, bubbles: true }));
      });
      // 112 + 40 = 152 of a 400px pane.
      expect(insetBandFraction(chart)).toBeCloseTo(0.38);
      // The height is on the chart, but nothing is on screen until the frame runs.
      expect(onRepaint).not.toHaveBeenCalled();
      flush();
      expect(onRepaint).toHaveBeenCalledTimes(1);
      expect(chart.resize).toHaveBeenCalledTimes(1);
    });
  });

  it("shrinks the band when dragged down", () => {
    withFrames(() => {
      const chart = stubChart();
      const { handle } = mount(chart);
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 300 });
      act(() => {
        handle.dispatchEvent(new MouseEvent("pointermove", { clientY: 340, bubbles: true }));
      });
      expect(insetBandFraction(chart)).toBeCloseTo(0.18);
    });
  });

  it("persists the settled height on release, not on every move", () => {
    withFrames(() => {
      const chart = stubChart();
      const { handle, onCommit } = mount(chart);
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 300 });
      act(() => {
        handle.dispatchEvent(new MouseEvent("pointermove", { clientY: 260, bubbles: true }));
      });
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.38);
    });
  });

  it("ignores pointer moves that are not part of a drag", () => {
    withFrames(() => {
      const chart = stubChart();
      const { handle, onRepaint } = mount(chart);
      setInsetBandFraction(chart, 0.3);
      act(() => {
        handle.dispatchEvent(new MouseEvent("pointermove", { clientY: 100, bubbles: true }));
      });
      // Merely sweeping across the strip must not resize the band.
      expect(insetBandFraction(chart)).toBe(0.3);
      expect(onRepaint).not.toHaveBeenCalled();
    });
  });

  it("resets to the default height on a double-click, and persists that", () => {
    withFrames((flush) => {
      const chart = stubChart();
      const { handle, onCommit, onRepaint } = mount(chart);
      setInsetBandFraction(chart, 0.7);
      fireEvent.doubleClick(handle);
      flush();
      expect(insetBandFraction(chart)).toBe(INSET_BAND_FRACTION);
      expect(onCommit).toHaveBeenCalledWith(INSET_BAND_FRACTION);
      expect(onRepaint).toHaveBeenCalledTimes(1);
    });
  });
});
