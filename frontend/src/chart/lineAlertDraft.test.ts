import { describe, it, expect } from "vitest";
import { buildLineAlertDraft } from "./lineAlertDraft";

const line = { slope: 0.5, tRef: 9, pRef: 13, t1: 2, p1: 10, t2: 6, p2: 12 };
const seg = (alertLine?: () => typeof line | null) => ({
  key: "2:6", x0: 0, y0: 0, x1: 1, y1: 1, clone: () => null, alertLine,
});
const base = { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", epic: "US100", broker: "b", precision: 2 };

describe("buildLineAlertDraft", () => {
  it("drafts on the chart timeframe with the segment's line", () => {
    const r = buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "HOUR" });
    expect(r && "draft" in r && r.draft).toEqual({
      epic: "US100", broker: "b", precision: 2, timeframe: "HOUR", line,
      link: { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", lineKey: "2:6" },
    });
  });
  it("a pinned pane drafts on its pin", () => {
    const r = buildLineAlertDraft({ ...base, seg: seg(() => line), ext: { mtf: { timeframe: "1D" } }, resolution: "HOUR" });
    expect(r && "draft" in r && r.draft.timeframe).toBe("DAY");
  });
  it("reasons and hiding", () => {
    expect(buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "HOUR_2" }))
      .toEqual({ reason: "Alerts on this timeframe are coming later" });
    expect(buildLineAlertDraft({ ...base, seg: seg(() => null), ext: {}, resolution: "HOUR" }))
      .toEqual({ reason: "This line can't take an alert yet" });
    expect(buildLineAlertDraft({ ...base, seg: seg(), ext: {}, resolution: "HOUR" }))
      .toEqual({ reason: "This line can't take an alert yet" });
    expect(buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "SECOND_5" })).toBeNull();
  });
});
