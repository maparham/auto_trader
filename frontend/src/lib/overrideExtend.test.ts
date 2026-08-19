import { describe, expect, it } from "vitest";
import type { Chart } from "klinecharts";
import { overrideExtend } from "./overrideExtend";
import { klineMerge } from "./testFakeChart";

// A chart whose overrideIndicator MERGES extendData the way klinecharts does.
// A fake that assigned instead would pass with the bug in place, which is the
// whole reason this file exists.
function makeChart(extendData: Record<string, unknown>) {
  const ind = { paneId: "p", name: "N", extendData };
  const calls: Array<Record<string, unknown>> = [];
  const chart = {
    overrideIndicator(o: { paneId: string; name: string; extendData: object }) {
      calls.push(o as unknown as Record<string, unknown>);
      if (o.paneId !== ind.paneId || o.name !== ind.name) return false;
      klineMerge(ind.extendData, o.extendData as Record<string, unknown>);
      return true;
    },
  };
  return { chart: chart as unknown as Chart, ind, calls };
}

describe("overrideExtend", () => {
  it("shrinks an array, which a single override cannot do", () => {
    const { chart, ind } = makeChart({ values: [1, 2, 3], on: true });
    overrideExtend(chart, "p", "N", { values: [9] });
    expect(ind.extendData.values).toEqual([9]);
    // Untouched keys survive: this is a patch, not a replacement.
    expect(ind.extendData.on).toBe(true);
  });

  it("empties an array, the case a plain override cannot express at all", () => {
    // merge([1,2,3], []) walks zero keys, so the old array is left intact and
    // "paint nothing" paints everything it painted last time.
    const { chart, ind } = makeChart({ values: [1, 2, 3] });
    overrideExtend(chart, "p", "N", { values: [] });
    expect(ind.extendData.values).toEqual([]);
  });

  it("replaces a nested object wholesale, dropping the keys it no longer has", () => {
    const { chart, ind } = makeChart({
      mtf: { timeframe: "H4", htfStarts: [1, 2, 3], htfSeries: [4, 5, 6] },
    });
    overrideExtend(chart, "p", "N", { mtf: { timeframe: null } });
    expect(ind.extendData.mtf).toEqual({ timeframe: null });
  });

  it("clears first and writes second, and only clears object-valued keys", () => {
    const { chart, calls } = makeChart({ values: [1], depth: 3 });
    overrideExtend(chart, "p", "N", { values: [2], depth: 4 });
    expect(calls).toHaveLength(2);
    expect(calls[0].extendData).toEqual({ values: null });
    expect(calls[1].extendData).toEqual({ values: [2], depth: 4 });
  });

  it("sends one call when nothing needs clearing", () => {
    const { chart, calls, ind } = makeChart({ depth: 3 });
    overrideExtend(chart, "p", "N", { depth: 4 });
    expect(calls).toHaveLength(1);
    expect(ind.extendData.depth).toBe(4);
  });

  it("passes calcParams through on the writing call only", () => {
    const { chart, calls } = makeChart({ values: [1] });
    overrideExtend(chart, "p", "N", { values: [2] }, [7, 8]);
    expect(calls[0].calcParams).toBeUndefined();
    expect(calls[1].calcParams).toEqual([7, 8]);
  });
});
