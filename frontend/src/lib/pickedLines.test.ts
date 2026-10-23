import { describe, expect, it } from "vitest";
import { lineGeoKey, mintLineId, pickedLineFromSeg, referencedLineIds, trimLines, type PickedLine } from "./pickedLines";

const L: PickedLine = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };

describe("pickedLines", () => {
  it("finds bare ids, not dotted pane refs or calls", () => {
    expect([...referencedLineIds(["candle.close > L1", "L2.tl_1 > 0", "L3(1)", "xL4 > L12"])].sort()).toEqual(["L1", "L12"]);
  });
  it("mints the lowest free id", () => {
    expect(mintLineId(undefined)).toBe("L1");
    expect(mintLineId({ L1: L, L3: L })).toBe("L2");
  });
  it("trims to referenced ids", () => {
    expect(trimLines({ L1: L, L2: L }, ["close > L2"])).toEqual({ L2: L });
    expect(trimLines({ L1: L }, ["close > 1"])).toBeUndefined();
  });
  it("geo key ignores the moving reference", () => {
    expect(lineGeoKey(L)).toBe(lineGeoKey({ ...L, tRef: 99, pRef: 99 }));
  });
  it("refuses seconds and lines without geometry", () => {
    const seg = { key: "k", x0: 0, y0: 0, x1: 0, y1: 0, clone: () => null, alertLine: () => ({ slope: 1, tRef: 3, pRef: 3, t1: 1, p1: 1, t2: 2, p2: 2 }) };
    expect(pickedLineFromSeg({ seg, ext: undefined, resolution: "SECOND_30", epic: "US100", broker: "capital" })).toHaveProperty("reason");
    expect(pickedLineFromSeg({ seg: { ...seg, alertLine: () => null }, ext: undefined, resolution: "HOUR", epic: "US100", broker: "capital" })).toHaveProperty("reason");
    expect(pickedLineFromSeg({ seg, ext: undefined, resolution: "HOUR", epic: "US100", broker: "capital" })).toEqual({ line: L });
  });
});
