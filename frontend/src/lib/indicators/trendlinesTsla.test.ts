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

// maxLines 6, NOT the pane default of 3, and that is a product finding rather
// than a fixture detail: AT THE PANE DEFAULT THIS FLAGSHIP HAND-DRAWN TSLA
// SUPPORT IS NOT SURFACED AT ALL. A line is built once, at its second anchor,
// so the live cap is a one-shot test it can never retake, and this one is born
// with 2 touches into a crowd that already has more. compareSurvival
// (crossings first) is what lets it survive at any setting; measured by
// bisection it still needs a live cap of 128 lines, which is maxLines 8 at
// MAX_LIVE_MULT 16 (7 and below all fail). It was 96 (maxLines 6) while one
// symmetric 0.75 ATR band counted every near miss as a full touch; splitting
// the tolerance into Max Touch Gap (0 by default) and Max Pierce reshuffles
// which lines the survival order carries, and this one needs a little more
// room. Widening Max Touch Gap back to 0.75 does NOT bring it back at 6 (it
// was measured), so the cap is the lever. A user on the default 3 does not see
// this line. See the "Survival vs rank" section of
// docs/superpowers/specs/2026-09-16-sideless-trendlines-design.md for the
// measured cap numbers behind this.
const CFG = { ...TRENDLINES_DEFAULTS, maxLines: 8 };

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
