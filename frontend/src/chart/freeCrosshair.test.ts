import { describe, it, expect } from "vitest";
import { applyFreeCrosshairX } from "./freeCrosshair";

// Minimal stand-in for klinecharts' StoreImp: setCrosshair computes a
// bar-snapped realX (here: bar centers every 10px) into the internal crosshair
// object that getCrosshair returns.
function makeStore() {
  const internal: { x?: number; realX?: number } = {};
  return {
    internal,
    setCrosshair(crosshair?: { x?: number }, _options?: unknown) {
      internal.x = crosshair?.x;
      internal.realX = crosshair?.x != null ? Math.round(crosshair.x / 10) * 10 : 995;
    },
    getCrosshair: () => internal,
  };
}

function makeChart(store: ReturnType<typeof makeStore>) {
  return { getChartStore: () => store };
}

describe("applyFreeCrosshairX", () => {
  it("pins realX to the raw cursor x instead of the bar-snapped coordinate", () => {
    const store = makeStore();
    applyFreeCrosshairX(makeChart(store));
    store.setCrosshair({ x: 123 });
    expect(store.getCrosshair().realX).toBe(123);
  });

  it("re-pins on the scroll re-snap path (setCrosshair fed the stored crosshair)", () => {
    const store = makeStore();
    applyFreeCrosshairX(makeChart(store));
    store.setCrosshair({ x: 123 });
    // StoreImp's scroll calls setCrosshair(this._crosshair, {notInvalidate:true}).
    store.setCrosshair(store.getCrosshair(), { notInvalidate: true });
    expect(store.getCrosshair().realX).toBe(123);
  });

  it("leaves realX alone when the crosshair has no cursor x (cleared/programmatic)", () => {
    const store = makeStore();
    applyFreeCrosshairX(makeChart(store));
    store.setCrosshair({});
    expect(store.getCrosshair().realX).toBe(995);
  });

  it("is a no-op on charts without getChartStore", () => {
    expect(() => applyFreeCrosshairX({})).not.toThrow();
    expect(() => applyFreeCrosshairX(null)).not.toThrow();
  });
});
