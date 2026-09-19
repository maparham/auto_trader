import { describe, it, expect, vi } from "vitest";
import { subscribeCrosshairWrites } from "./crosshairWrites";

function makeStore() {
  const calls: unknown[][] = [];
  return {
    calls,
    setCrosshair(crosshair?: unknown, options?: unknown) {
      calls.push([crosshair, options]);
    },
  };
}

function makeChart(store: ReturnType<typeof makeStore>) {
  return { getChartStore: () => store };
}

describe("subscribeCrosshairWrites", () => {
  it("reports a set crosshair with its pixel and pane", () => {
    const store = makeStore();
    const seen = vi.fn();
    subscribeCrosshairWrites(makeChart(store), seen);
    store.setCrosshair({ x: 10, y: 20, paneId: "candle_pane" });
    expect(seen).toHaveBeenCalledWith({ x: 10, y: 20, paneId: "candle_pane" });
  });

  it("reports a clear as null (setCrosshair() and setCrosshair({}))", () => {
    const store = makeStore();
    const seen = vi.fn();
    subscribeCrosshairWrites(makeChart(store), seen);
    store.setCrosshair();
    store.setCrosshair({});
    expect(seen).toHaveBeenNthCalledWith(1, null);
    expect(seen).toHaveBeenNthCalledWith(2, null);
  });

  it("still forwards every write to the original setter with its options", () => {
    const store = makeStore();
    subscribeCrosshairWrites(makeChart(store), () => {});
    store.setCrosshair({ x: 1, y: 2, paneId: "p" }, { notInvalidate: true });
    store.setCrosshair();
    expect(store.calls).toEqual([
      [{ x: 1, y: 2, paneId: "p" }, { notInvalidate: true }],
      [undefined, undefined],
    ]);
  });

  it("stops notifying after cleanup but keeps forwarding writes", () => {
    const store = makeStore();
    const seen = vi.fn();
    const off = subscribeCrosshairWrites(makeChart(store), seen);
    off();
    store.setCrosshair({ x: 1, y: 2, paneId: "p" });
    expect(seen).not.toHaveBeenCalled();
    expect(store.calls).toHaveLength(1);
  });

  it("chains over an earlier wrapper (freeCrosshair-style) rather than replacing it", () => {
    const store = makeStore();
    const inner = vi.fn();
    const orig = store.setCrosshair.bind(store);
    store.setCrosshair = (c?: unknown, o?: unknown) => { orig(c, o); inner(c); };
    const seen = vi.fn();
    subscribeCrosshairWrites(makeChart(store), seen);
    store.setCrosshair({ x: 5, y: 6, paneId: "p" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on charts without getChartStore", () => {
    expect(() => subscribeCrosshairWrites({}, () => {})()).not.toThrow();
    expect(() => subscribeCrosshairWrites(null, () => {})()).not.toThrow();
  });
});
