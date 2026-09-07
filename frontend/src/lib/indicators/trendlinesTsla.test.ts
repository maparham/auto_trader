// ACCEPTANCE: the user's hand-drawn TSLA support line, which crosses sides —
// it starts on the 2024-12-18 HIGH (488.36, bar 777) and runs through the
// 2025-11-14 (380.92, bar 1006) and 2026-04-07 (337.19, bar 1103) LOWS. The
// detector anchors it on the two lows; Mixed touches is what lets the
// December high count as its third touch and start the drawn segment there.
// Real Capital.com daily bid candles, captured 2026-09-07.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, lineExtent } from "./trendlines";
import { parseTrendlinesConfig } from "./trendlinesOutputs";
import fixture from "./trendlinesTsla.fixture.json";

const bars = fixture as unknown as KLineData[];
// The chart config this line was found under (Max Pierce 0.3, Max Break Hold
// 45, Min Back Clearance 40), with Max Touch Gap at its 0 default. The high
// sits 4.2 ABOVE the line (~0.21 ATR at that bar) — it CROSSES the line, so
// the mirrored mixed-touch band judges it by Max Pierce, and Max Touch Gap 0
// deliberately stays: this test only passes while that mirroring holds.
const CFG = parseTrendlinesConfig([5, 0.3, 0, 2, 20, 250, 45, 4, 1, 0, 20, 0, 0, 0, 0, 40, 1]);

describe("TRENDLINES on TSLA daily (mixed-pivot acceptance)", () => {
  it("holds the fixture it expects", () => {
    expect(bars.length).toBe(1209);
    expect(bars[777].high).toBe(488.36);
  });
  it("the descending support collects the 2024-12-18 high and draws from it", () => {
    const { lines } = computeTrendlines(bars, CFG);
    const line = lines.find((l) => l.side === "support" && l.i1 === 1006 && l.i2 === 1103);
    expect(line).toBeDefined();
    expect(line!.touchIdxs).toContain(777);
    expect(line!.touches).toBeGreaterThanOrEqual(3);
    expect(line!.firstTouchIdx).toBeLessThanOrEqual(777);
    // Geometry untouched: still anchored on the lows, broken where it was.
    expect(line!.p1).toBe(380.92);
    expect(line!.p2).toBe(337.19);
    // And it DRAWS from the high without "Extended both ways".
    expect(lineExtent(line!, "lastbar", CFG, [], bars.length - 1, null).jLeft).toBe(line!.firstTouchIdx);
  });
  it("with the option off the same line exists but starts at its first anchor", () => {
    const off = { ...CFG, mixedTouches: 0 };
    const { lines } = computeTrendlines(bars, off);
    const line = lines.find((l) => l.side === "support" && l.i1 === 1006 && l.i2 === 1103);
    expect(line).toBeDefined();
    expect(line!.firstTouchIdx).toBe(1006);
    expect(line!.touchIdxs).not.toContain(777);
  });
});
