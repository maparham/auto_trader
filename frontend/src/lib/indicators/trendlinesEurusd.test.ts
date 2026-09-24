// ACCEPTANCE: the line a trader drew on EURUSD weekly, from the 2021-01-04 high
// (1.23495) down through the Nov-2025 low. Its two anchors are a HIGH and a
// LOW, and price sat 2-3 ATR above it for most of 2025: the sided detector
// could never build it. If this stops passing, the feature does not do the
// one thing it was rewritten for.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, isMajor, projectAt } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesEurusd.fixture.json";

const bars = fixture as unknown as KLineData[];
const month = (t: number): string => new Date(t).toISOString().slice(0, 7);

// The user's live 1W settings on chartkar.app (2026-09-16): pivot length 4,
// pivot size 3 ATR, 9 lines. One override, measured on this fixture:
// minSwingAtr 2.6 (down from 3), because the 2025-11-03 low's leg against the
// prior 2025-09 high is 0.04499, only 2.62x atr[k] (0.01716); at 3 it never
// enters the pivot pool at all.
// Merge off: the pins below name a slot, and the shipped quarter-ATR merge
// (added later) folds neighbours and renumbers the slots.
const CFG = { ...TRENDLINES_DEFAULTS, pivotLen: 4, minSwingAtr: 2.6, maxLines: 9, mergeAtr: 0 };

describe("TRENDLINES on EURUSD weekly", () => {
  it("has the fixture it expects", () => {
    expect(bars.length).toBeGreaterThan(280);
    expect(bars.some((b) => month(b.timestamp) === "2021-01" && b.high === 1.23495)).toBe(true);
  });

  it("builds the 2021-01 high to 2025-11 low line and reads it at the last bar", () => {
    const { lines, points } = computeTrendlines(bars, CFG);
    const found = lines.filter(
      (l) => l.k1 === "high" && month(bars[l.i1].timestamp) === "2021-01" &&
             l.k2 === "low" && month(bars[l.i2].timestamp) === "2025-11",
    );
    // Diagnostic on failure: which pivots the pool holds around the anchors.
    if (!found.length) {
      const { pivots } = computeTrendlines(bars, CFG);
      const near = pivots.idxs
        .map((idx, q) => `${month(bars[idx].timestamp)}:${pivots.kinds[q]}`)
        .filter((s) => s.startsWith("2021-01") || s.startsWith("2025-1"));
      console.log("pool near the anchors:", near, "pool size:", pivots.idxs.length);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].p1).toBe(1.23495);
    expect(isMajor(found[0], bars.length - 1, CFG)).toBe(true);
    // A descending line from the 2021-01 high to the 2025-11 low sits BELOW
    // price for years (e.g. ~1.20 projected vs an EURUSD close near 0.96 in
    // Sept 2022) and only crosses to sit above it once, then stays there
    // through 2025 (lastSign 1): exactly one non-baseline sign flip.
    expect(found[0].crossings).toBe(1);
    // Four at the shipped tolerances (Max Touch Gap 0, Max Pierce 0.25), down
    // from eight when one symmetric 0.75 ATR band counted every near miss as a
    // full touch. The line is the same line; the count is now what pierced it.
    expect(found[0].touches).toBe(4);

    // AND A RULE CAN READ IT, given the slots. The emitted number IS
    // projectAt's result on the same bar, so the match is exact rather than
    // toleranced. Measured 2026-09-24, after stage 3 became nearest first: at
    // 1.1312 against a close of 1.1539 (1.86 ATR under it) 48 gate-passing
    // lines sit nearer, so the user's nine-line pane no longer draws it (on
    // 2026-09-23, in rank order, it was tl_9). At Max Trendlines 49 it is the
    // 49th nearest and reads as tl_49. With the shipped quarter-ATR merge on
    // it folds into a nearer member's level and is not a leader at all.
    const lastIdx = bars.length - 1;
    const at = projectAt(found[0], lastIdx);
    const row = points[lastIdx] as Record<string, number | undefined>;
    expect(Object.values(row)).not.toContain(at);
    const wide = computeTrendlines(bars, { ...CFG, maxLines: 49 }).points;
    expect((wide[lastIdx] as Record<string, number | undefined>).tl_49).toBe(at);
  });
});
