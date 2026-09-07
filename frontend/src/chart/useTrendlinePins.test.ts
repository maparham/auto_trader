import { describe, it, expect } from "vitest";
import type { Chart } from "klinecharts";
import { overridePinned, togglePin } from "./useTrendlinePins";

// klinecharts' own merge(), reproduced faithfully enough to catch the bug this
// helper exists for: isObject() is true for arrays, so merge RECURSES into them
// index by index and never shrinks the target. A test that just replaced
// extendData would pass with the bug in place.
function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    const t = target[key];
    const s = source[key];
    if (
      typeof s === "object" &&
      s !== null &&
      typeof t === "object" &&
      t !== null
    )
      merge(t as Record<string, unknown>, s as Record<string, unknown>);
    else target[key] = s;
  }
}

function makeChart(extendData: Record<string, unknown>) {
  const ind = { paneId: "candle_pane", name: "TRENDLINES", extendData };
  const calls: unknown[] = [];
  const chart = {
    overrideIndicator(override: {
      paneId: string;
      name: string;
      extendData: object;
    }) {
      calls.push(override.extendData);
      if (override.paneId !== ind.paneId || override.name !== ind.name)
        return false;
      merge(ind.extendData, override.extendData as Record<string, unknown>);
      return true;
    },
  };
  return { chart: chart as unknown as Chart, ind, calls };
}

describe("overridePinned", () => {
  it("shrinks the live list, which a single override cannot do", () => {
    const { chart, ind } = makeChart({
      pinned: ["a", "b", "c"],
      extend: "lastbar",
    });
    overridePinned(chart, "candle_pane", "TRENDLINES", ["a", "b"]);
    expect(ind.extendData.pinned).toEqual(["a", "b"]);
  });

  it("empties the live list", () => {
    const { chart, ind } = makeChart({ pinned: ["a"] });
    overridePinned(chart, "candle_pane", "TRENDLINES", []);
    expect(ind.extendData.pinned).toEqual([]);
  });

  it("grows the live list", () => {
    const { chart, ind } = makeChart({ pinned: ["a"] });
    overridePinned(chart, "candle_pane", "TRENDLINES", ["a", "b"]);
    expect(ind.extendData.pinned).toEqual(["a", "b"]);
  });

  it("leaves the neighbouring render options alone", () => {
    const { chart, ind } = makeChart({
      pinned: ["a"],
      extend: "lastbar",
      dedupe: true,
    });
    overridePinned(chart, "candle_pane", "TRENDLINES", []);
    expect(ind.extendData).toEqual({
      pinned: [],
      extend: "lastbar",
      dedupe: true,
    });
  });

  it("clears the key before writing, or the merge cannot shrink it", () => {
    // The mechanism, asserted directly: the first call must null the key out.
    // Without it the second call merges into the old array and a removal is
    // silently lost, which is invisible until a reload.
    const { chart, calls } = makeChart({ pinned: ["a", "b"] });
    overridePinned(chart, "candle_pane", "TRENDLINES", ["a"]);
    expect(calls).toEqual([{ pinned: null }, { pinned: ["a"] }]);
  });
});

describe("togglePin", () => {
  /** getIndicators answering in either of klinecharts' two shapes. */
  function withGetIndicators(
    extendData: Record<string, unknown>,
    shape: "array" | "map",
  ) {
    const { chart, ind } = makeChart(extendData);
    (chart as unknown as Record<string, unknown>).getIndicators = () =>
      shape === "array" ? [ind] : new Map([[ind.paneId, [ind]]]);
    return { chart, ind };
  }

  it("adds a key, keeping the existing pins", () => {
    const { chart, ind } = withGetIndicators({ pinned: ["a"] }, "array");
    togglePin(chart, "candle_pane", "TRENDLINES", "b");
    expect(ind.extendData.pinned).toEqual(["a", "b"]);
  });

  it("removes a key already pinned", () => {
    const { chart, ind } = withGetIndicators({ pinned: ["a", "b"] }, "array");
    togglePin(chart, "candle_pane", "TRENDLINES", "a");
    expect(ind.extendData.pinned).toEqual(["b"]);
  });

  it("reads the live pins through the Map shape too, never wiping them", () => {
    // getIndicators has answered with a Map in other klinecharts builds, and
    // the instance walk already tolerates that. A toggle that only understood
    // the array shape would read `pinned` as empty there and its write would
    // silently drop every other pin.
    const { chart, ind } = withGetIndicators({ pinned: ["a"] }, "map");
    togglePin(chart, "candle_pane", "TRENDLINES", "b");
    expect(ind.extendData.pinned).toEqual(["a", "b"]);
  });
});
