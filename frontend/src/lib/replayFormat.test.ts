// @vitest-environment jsdom
//
// jsdom for a module with no DOM in it: replayFormat imports `browserTimezone`
// from chart/chartPainters, whose module graph reaches klinecharts, which
// touches `window` at import time. The alternative was a second copy of that
// four-line fallback inside lib/ — which is exactly the duplication this module
// was extracted to end, so the cheaper env wins. (Moving browserTimezone down
// into lib/timeFormat.ts would fix it properly; that is a file outside this
// task's scope, so it is noted in the report rather than done here.)
//
// The seam that decides whether the report card's reveal is a reveal at all.
//
// The bug this file exists for is a ONE-WORD one: hand the card the masked
// formatter instead of the real one and it renders "Day 4 09:00 to Day 4 15:30".
// The card still appears, the stats are still right, the `masked` gate still
// works, and every other test in the repo stays green — the only thing lost is
// the entire payoff of the feature. So the two formatters are built together
// from one input, and pinned together here: `real` must be a real date even when
// the session is masked, and `cursor` must be masked whenever the session is.
import { describe, expect, it } from "vitest";
import { makeReplayFormatters, type ReplayFormatterOpts } from "./replayFormat";

const ANCHOR = Date.UTC(2021, 4, 17, 9, 0); // Mon 17 May 2021, 09:00 UTC
const DAY = 86_400_000;

// UTC so the assertions are about the formatters, not about the test machine's
// zone. (The zone path itself is exercised by the invalid-timezone case below.)
const OPTS: ReplayFormatterOpts = {
  clock: "24h",
  dateFormat: "ymd",
  showWeekday: false,
  timezone: "UTC",
  maskAnchorMs: null,
};

describe("makeReplayFormatters", () => {
  it("gives the report card a REAL date even when the session is masked", () => {
    const f = makeReplayFormatters({ ...OPTS, maskAnchorMs: ANCHOR });
    expect(f.real(ANCHOR)).toBe("2021-05-17 09:00");
    expect(f.real(ANCHOR + 3 * DAY + 6.5 * 3_600_000)).toBe("2021-05-20 15:30");
    // The thing that must never be true of the reveal.
    expect(f.real(ANCHOR)).not.toContain("Day");
  });

  it("masks the in-session cursor label for a masked session", () => {
    const f = makeReplayFormatters({ ...OPTS, maskAnchorMs: ANCHOR });
    // Day 1 is the calendar day the session started; see makeMaskedFormatDate.
    expect(f.cursor(ANCHOR)).toBe("Day 1 09:00");
    expect(f.cursor(ANCHOR + 3 * DAY + 6.5 * 3_600_000)).toBe("Day 4 15:30");
    expect(f.cursor(ANCHOR)).not.toContain("2021");
    expect(f.cursor(ANCHOR)).not.toContain("05");
  });

  it("leaves the cursor label unmasked when the session is not masked", () => {
    const f = makeReplayFormatters(OPTS); // maskAnchorMs: null
    expect(f.cursor(ANCHOR)).toBe("2021-05-17 09:00");
    expect(f.cursor(ANCHOR)).toBe(f.real(ANCHOR));
  });

  it("runs both labels through the same zone and the same clock/date preferences", () => {
    // The pairing this module exists for: whatever the user has set, the masked
    // label and the real date it unmasks into must describe the same instant in
    // the same zone, or the reveal reconciles nothing.
    const f = makeReplayFormatters({
      ...OPTS,
      clock: "12h",
      dateFormat: "dmy",
      timezone: "Asia/Tokyo",
      maskAnchorMs: ANCHOR,
    });
    // 09:00 UTC on the 17th is 18:00 on the 17th in Tokyo.
    expect(f.real(ANCHOR)).toBe("17/05/2021 6:00 PM");
    expect(f.cursor(ANCHOR)).toBe("Day 1 6:00 PM");
    // Same wall time either side of the mask: only the DATE half is hidden.
    expect(f.cursor(ANCHOR).endsWith("6:00 PM")).toBe(true);
  });

  it("degrades to empty labels rather than throwing on an invalid saved timezone", () => {
    // Empty is the safe direction: it can only ever say LESS about when a
    // session is. A throw here would take the whole cell down.
    const f = makeReplayFormatters({ ...OPTS, timezone: "Not/AZone", maskAnchorMs: ANCHOR });
    expect(f.real(ANCHOR)).toBe("");
    expect(f.cursor(ANCHOR)).toBe("");
  });
});
