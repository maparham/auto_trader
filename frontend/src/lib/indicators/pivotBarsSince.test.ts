import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// customIndicators reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { computePivotBarsSince } = await import("./pivotBarsSince");
const { computePivotBands } = await import("./pivotBands");

// Same fixture shape as pivotBands.test.ts: highs 90 / lows 80 everywhere except
// the bars named here, so no other bar can be an extreme.
function bars(highs: Record<number, number>, lows: Record<number, number>, n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const high = highs[i] ?? 90;
    const low = lows[i] ?? 80;
    return { timestamp: i, open: high, high, low, close: high, volume: 0 };
  });
}

describe("computePivotBarsSince", () => {
  const N = 2;

  it("is blank until the first pivot of that side confirms", () => {
    // Pivot high at bar 5, confirms at bar 7. Pivot low at bar 8, confirms at 10.
    const pts = computePivotBarsSince(bars({ 5: 100 }, { 8: 70 }, 12), N, {});
    for (let i = 0; i <= 6; i++) expect(pts[i].barsSinceHigh).toBeUndefined();
    for (let i = 0; i <= 9; i++) expect(pts[i].barsSinceLow).toBeUndefined();
    expect(pts[7].barsSinceHigh).toBe(2);
    expect(pts[10].barsSinceLow).toBe(2);
  });

  it("counts from the PIVOT bar, so it never reads below N", () => {
    // Two pivot highs: bar 5 (confirms 7) and bar 9 (confirms 11).
    const pts = computePivotBarsSince(bars({ 5: 100, 9: 105 }, {}, 14), N, {});
    // First pivot: steps in at N and climbs one per bar.
    expect(pts[7].barsSinceHigh).toBe(2);
    expect(pts[8].barsSinceHigh).toBe(3);
    expect(pts[9].barsSinceHigh).toBe(4);
    expect(pts[10].barsSinceHigh).toBe(5);
    // Second pivot confirms at 11: back down to N (bar 11 minus pivot bar 9),
    // NOT to 0 — the swing itself is already N bars old when it is confirmed.
    expect(pts[11].barsSinceHigh).toBe(2);
    expect(pts[12].barsSinceHigh).toBe(3);
    // The invariant across the whole series.
    for (const p of pts) if (p.barsSinceHigh !== undefined) expect(p.barsSinceHigh).toBeGreaterThanOrEqual(N);
  });

  it("rises by exactly one per bar between confirmations", () => {
    const pts = computePivotBarsSince(bars({ 5: 100 }, { 8: 70 }, 20), N, {});
    for (let i = 8; i < pts.length; i++) expect(pts[i].barsSinceHigh! - pts[i - 1].barsSinceHigh!).toBe(1);
  });

  it("tracks the two sides independently", () => {
    // High at bar 4 (confirms 6), low at bar 9 (confirms 11).
    const pts = computePivotBarsSince(bars({ 4: 100 }, { 9: 70 }, 14), N, {});
    expect(pts[11].barsSinceHigh).toBe(7); // 11 - 4
    expect(pts[11].barsSinceLow).toBe(2); // 11 - 9
  });

  it("detects both sides on a single series when source is not hl", () => {
    // close === high in the fixture, so a `close` source finds the high pivot on
    // BOTH sides and never sees the low-only bar 8.
    const data = bars({ 5: 100 }, { 8: 70 }, 12);
    const pts = computePivotBarsSince(data, N, { source: "close" });
    expect(pts[7].barsSinceHigh).toBe(2);
    expect(pts[11].barsSinceLow).toBeUndefined(); // no swing low on the close series
  });

  it("falls back to chart bars exactly when the parent's bands do", () => {
    // The coordinator writes mtf as ONE object: either all four HTF series are
    // there or none is (a failed fetch with no prior stash leaves {timeframe}
    // alone). So a stash without the count arrays is also a stash without the
    // price arrays, and both modules must take their local branch together —
    // otherwise the pane would count chart bars under HTF bands.
    const data = bars({ 5: 100 }, { 8: 70 }, 12);
    const ext = { mtf: { timeframe: "1h" } };
    expect(computePivotBarsSince(data, 2, ext)[7].barsSinceHigh).toBe(2);
    expect(computePivotBands(data, 2, 3, ext)[7].pivotHigh).toBe(100);
  });

  it("aligns the higher-timeframe counts onto chart bars (no lookahead)", () => {
    // Two HTF bars of 10ms each; ages counted in HTF bars by the coordinator.
    const chart = Array.from({ length: 30 }, (_, i) => ({
      timestamp: i,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
    })) as KLineData[];
    const pts = computePivotBarsSince(chart, N, {
      mtf: {
        timeframe: "1h",
        htfStarts: [0, 10, 20],
        htfBarsSinceHigh: [undefined, 3, 4],
        htfBarsSinceLow: [undefined, undefined, 2],
        htfMs: 10,
      },
    });
    // A chart bar only ever sees a CLOSED HTF bar: bars 0..19 predate the close of
    // the HTF bar that first carries a value.
    expect(pts[19].barsSinceHigh).toBeUndefined();
    expect(pts[20].barsSinceHigh).toBe(3); // HTF bar 1, closed at t=20
    expect(pts[29].barsSinceHigh).toBe(3); // holds flat inside the HTF bar
    expect(pts[29].barsSinceLow).toBeUndefined();
  });
});
