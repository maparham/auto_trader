// ACCEPTANCE: the user's hand-drawn TSLA support line, anchored on the
// 2025-11-14 (380.92, bar 1006) and 2026-04-07 (337.19, bar 1103) LOWS.
// Real Capital.com daily bid candles, captured 2026-09-07.
//
// The original acceptance for this fixture (pre sideless-rewrite) also
// asserted that the 2024-12-18 HIGH (488.36, bar 777), which sits BEFORE
// both anchors, counted as an extra touch via a "mixedTouches" option and
// pulled the drawn segment's start back to it. That option, and the whole
// notion of a touch confirmed before a line's first anchor, do not exist in
// the sideless detector: a line's only touches are its own two anchors plus
// pivots confirmed strictly between or after them (trendlines.ts's retro and
// forward touch passes), never before i1. Bar 777 is asserted below to
// confirm it stays untouched, not to work around a gap.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, isMajor } from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import fixture from "./trendlinesTsla.fixture.json";

const bars = fixture as unknown as KLineData[];

// THE PANE DEFAULT. A line is built once, at its second anchor, so the live
// cap is a one-shot test it can never retake, and this one is born with 2
// touches into a crowd that already has more. compareSurvival (crossings
// first) is what lets it survive; measured by bisection it needs a live cap
// of 128 lines, which used to mean maxLines 8 (the cap was maxLines x 16).
// The live cap is now a fixed MAX_LIVE (256), so it is built at the default.
//
// BUILT IS NOT DRAWN, and that is still a product finding: measured
// 2026-09-24 at the default, with stage 3 nearest first, it sits 4.08 ATR
// under the close and 58 of the 226 lines that pass the per-line filters on
// the last bar are nearer (its merged level is 43rd), so a pane at Max
// Trendlines 3 does not draw it. The lever is distance, not the live cap.
const CFG = TRENDLINES_DEFAULTS;

describe("TRENDLINES on TSLA daily", () => {
  it("holds the fixture it expects", () => {
    expect(bars.length).toBe(1209);
    expect(bars[777].high).toBe(488.36);
  });

  it("builds the 2025-11 to 2026-04 low-to-low support line", () => {
    const { lines } = computeTrendlines(bars, CFG);
    const line = lines.find((l) => l.k1 === "low" && l.i1 === 1006 && l.k2 === "low" && l.i2 === 1103);
    expect(line).toBeDefined();
    expect(line!.p1).toBe(380.92);
    expect(line!.p2).toBe(337.19);
    expect(line!.touches).toBeGreaterThanOrEqual(2);
    expect(isMajor(line!, bars.length - 1, CFG)).toBe(true);
    // The pre-anchor high is never a touch: no touch pass looks before i1.
    expect(line!.touchIdxs).not.toContain(777);
  });
});
