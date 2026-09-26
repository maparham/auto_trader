import { describe, expect, it } from "vitest";
import { dropPaintedLines, hitPaintedLine, setPaintedLines } from "./paintedLines";

// A chart stand-in that knows which instances exist and whether each is shown.
function fakeChart(inds: Record<string, { visible?: boolean }>) {
  return {
    getIndicators: ({ paneId, name }: { paneId: string; name: string }) =>
      paneId === "candle_pane" && inds[name] ? [{ name, paneId, ...inds[name] }] : [],
  };
}

describe("painted-line hit targets", () => {
  it("hits a recorded line within the slop and misses beyond it", () => {
    const chart = fakeChart({ fib: {} });
    setPaintedLines(chart, "candle_pane", "fib", [{ x0: 10, y0: 50, x1: 200, y1: 50 }]);
    expect(hitPaintedLine(chart, 100, 54, 6)).toEqual({ paneId: "candle_pane", name: "fib" });
    expect(hitPaintedLine(chart, 100, 60, 6)).toBeNull();
    expect(hitPaintedLine(chart, 300, 50, 6)).toBeNull();
  });

  it("picks the nearest instance when two are in reach", () => {
    const chart = fakeChart({ a: {}, b: {} });
    setPaintedLines(chart, "candle_pane", "a", [{ x0: 0, y0: 50, x1: 100, y1: 50 }]);
    setPaintedLines(chart, "candle_pane", "b", [{ x0: 0, y0: 54, x1: 100, y1: 54 }]);
    expect(hitPaintedLine(chart, 50, 53, 6)?.name).toBe("b");
    expect(hitPaintedLine(chart, 50, 51, 6)?.name).toBe("a");
  });

  it("ignores a hidden or removed instance, whose last frame is still recorded", () => {
    const chart = fakeChart({ shown: {}, hidden: { visible: false } });
    const line = [{ x0: 0, y0: 50, x1: 100, y1: 50 }];
    setPaintedLines(chart, "candle_pane", "hidden", line);
    setPaintedLines(chart, "candle_pane", "gone", line);
    expect(hitPaintedLine(chart, 50, 50, 6)).toBeNull();
  });

  it("clears on null and on drop", () => {
    const chart = fakeChart({ fib: {} });
    const line = [{ x0: 0, y0: 50, x1: 100, y1: 50 }];
    setPaintedLines(chart, "candle_pane", "fib", line);
    setPaintedLines(chart, "candle_pane", "fib", null);
    expect(hitPaintedLine(chart, 50, 50, 6)).toBeNull();
    setPaintedLines(chart, "candle_pane", "fib", line);
    dropPaintedLines(chart, "fib");
    expect(hitPaintedLine(chart, 50, 50, 6)).toBeNull();
  });
});
