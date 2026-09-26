import { describe, expect, it } from "vitest";
import type { Chart } from "klinecharts";
import { emphasizeAutoFibs } from "./autoFibEmphasis";

// Candle-pane instances by name; overrideIndicator merges like klinecharts
// (null assigned, so a cleared key reads null).
function fakeChart(types: Record<string, string>) {
  const inds = Object.fromEntries(
    Object.entries(types).map(([name, t]) => [name, { name, paneId: "candle_pane", extendData: { indType: t } as Record<string, unknown> }]),
  );
  const writes: string[] = [];
  const chart = {
    getIndicators: ({ name }: { name: string }) => (inds[name] ? [inds[name]] : []),
    overrideIndicator: (o: { name: string; extendData?: Record<string, unknown> }) => {
      if (!o.extendData || !inds[o.name]) return false;
      Object.assign(inds[o.name].extendData, o.extendData);
      writes.push(`${o.name}=${String(o.extendData.emphasis)}`);
      return true;
    },
  } as unknown as Chart;
  const emphasis = (name: string) => inds[name].extendData.emphasis ?? null;
  return { chart, emphasis, writes };
}

describe("emphasizeAutoFibs", () => {
  it("selected wins over hovered, and only AUTO_FIB instances are touched", () => {
    const { chart, emphasis, writes } = fakeChart({ fib: "AUTO_FIB", ema: "EMA" });
    emphasizeAutoFibs(chart, "fib", ["fib", "ema"]);
    expect(emphasis("fib")).toBe("select");
    expect(writes).toEqual(["fib=select"]);
  });

  it("hover from the chart or the legend, cleared when both let go", () => {
    const { chart, emphasis } = fakeChart({ fib: "AUTO_FIB" });
    emphasizeAutoFibs(chart, null, [null, "fib"]);
    expect(emphasis("fib")).toBe("hover");
    emphasizeAutoFibs(chart, null, [null, null]);
    expect(emphasis("fib")).toBeNull();
  });

  it("writes only what changed", () => {
    const { chart, writes } = fakeChart({ fib: "AUTO_FIB" });
    emphasizeAutoFibs(chart, null, ["fib"]);
    emphasizeAutoFibs(chart, null, ["fib"]);
    emphasizeAutoFibs(chart, "fib", ["fib"]);
    expect(writes).toEqual(["fib=hover", "fib=select"]);
  });
});
