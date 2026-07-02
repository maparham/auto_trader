import { describe, it, expect } from "vitest";
import { indicatorSignature, drawingSignature } from "./templateSignatures";
import type { SavedOverlay } from "./persist";

describe("indicatorSignature", () => {
  it("matches same type + same calcParams", () => {
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).toBe(
      indicatorSignature({ type: "EMA", calcParams: [20] }),
    );
  });

  it("differs on type and on calcParams", () => {
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).not.toBe(
      indicatorSignature({ type: "MA", calcParams: [20] }),
    );
    expect(indicatorSignature({ type: "EMA", calcParams: [20] })).not.toBe(
      indicatorSignature({ type: "EMA", calcParams: [9] }),
    );
  });

  it("ignores the non-identifying extendData keys (userVisible/visibility/indType)", () => {
    const a = indicatorSignature({
      type: "EMA",
      calcParams: [20],
      extendData: { userVisible: false, indType: "EMA", visibility: { mode: "all" } },
    });
    const b = indicatorSignature({ type: "EMA", calcParams: [20], extendData: {} });
    expect(a).toBe(b);
  });

  it("treats identifying extendData (e.g. MTF timeframe, source) as identity", () => {
    const a = indicatorSignature({ type: "EMA", calcParams: [20], extendData: { timeframe: "1h" } });
    const b = indicatorSignature({ type: "EMA", calcParams: [20], extendData: { timeframe: "4h" } });
    expect(a).not.toBe(b);
  });

  it("extendData key order does not matter", () => {
    const a = indicatorSignature({ type: "LR", extendData: { source: "close", mult: 2 } });
    const b = indicatorSignature({ type: "LR", extendData: { mult: 2, source: "close" } });
    expect(a).toBe(b);
  });

  it("AVWAP anchor is identity", () => {
    const a = indicatorSignature({ type: "AVWAP", anchor: 1700000000000 });
    const b = indicatorSignature({ type: "AVWAP", anchor: 1800000000000 });
    const c = indicatorSignature({ type: "AVWAP", anchor: 1700000000000 });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it("two unplaced AVWAPs (no anchor) match", () => {
    expect(indicatorSignature({ type: "AVWAP" })).toBe(indicatorSignature({ type: "AVWAP" }));
  });
});

describe("drawingSignature", () => {
  const line = (over?: Partial<SavedOverlay>): SavedOverlay => ({
    name: "horizontalStraightLine",
    points: [{ timestamp: 1700000000000, value: 18000 }],
    ...over,
  });

  it("matches same type + same points regardless of style/lock/zLevel/visible", () => {
    const plain = drawingSignature(line());
    const styled = drawingSignature(
      line({ styles: { line: { color: "#f00" } }, lock: true, zLevel: 5, visible: false }),
    );
    expect(styled).toBe(plain);
  });

  it("differs on tool type and on points", () => {
    expect(drawingSignature(line({ name: "priceLine" }))).not.toBe(drawingSignature(line()));
    expect(
      drawingSignature(line({ points: [{ timestamp: 1700000000000, value: 18001 }] })),
    ).not.toBe(drawingSignature(line()));
  });

  it("absorbs float noise in point values", () => {
    const noisy = drawingSignature(line({ points: [{ timestamp: 1700000000000, value: 18000.000000000004 }] }));
    expect(noisy).toBe(drawingSignature(line()));
  });

  it("distinguishes point count and dataIndex-anchored points", () => {
    const twoPoint = drawingSignature(
      line({
        name: "straightLine",
        points: [
          { timestamp: 1700000000000, value: 18000 },
          { timestamp: 1700003600000, value: 18100 },
        ],
      }),
    );
    const oneMoved = drawingSignature(
      line({
        name: "straightLine",
        points: [
          { timestamp: 1700000000000, value: 18000 },
          { timestamp: 1700003600000, value: 18200 },
        ],
      }),
    );
    expect(twoPoint).not.toBe(oneMoved);
    expect(drawingSignature(line({ points: [{ dataIndex: 250, value: 18000 }] }))).not.toBe(
      drawingSignature(line()),
    );
  });
});
