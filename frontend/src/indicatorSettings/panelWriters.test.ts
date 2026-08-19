// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fakeChart } from "../lib/testFakeChart";
import { makeWriteSessions } from "./SessionsPanels";
import { makeWriteWindows } from "./TimeHighlightPanels";
import type { SessionDef } from "../lib/customIndicators";
import type { TimeWindowDef } from "../lib/indicators/timeHighlight";

// THE REMOVAL CASE, which is the only one that can fail. klinecharts merges
// extendData index by index, so a shorter array leaves the old tail in the live
// indicator: the row vanishes from the modal, is saved correctly, and keeps
// painting until the next page load. The fake chart merges the same way, so a
// writer that sends one override still fails here.
function sessionAt(n: number): SessionDef {
  return { name: `S${n}`, start: "00:00", end: "01:00", tz: "UTC", color: "#111" } as SessionDef;
}
function windowAt(n: number): TimeWindowDef {
  return { name: `W${n}`, start: "00:00", end: "01:00" } as unknown as TimeWindowDef;
}

describe("panel writers shrink the live list", () => {
  it("drops a deleted session from the live indicator", () => {
    const { chart, live } = fakeChart();
    const three = [sessionAt(1), sessionAt(2), sessionAt(3)];
    chart.createIndicator({ name: "SESSIONS", extendData: { sessions: three, tz: "UTC" } } as never);
    const write = makeWriteSessions(chart, live[0].paneId, "SESSIONS", () => {});
    write(three.filter((_, i) => i !== 1));
    const ext = live[0].extendData as { sessions: SessionDef[]; tz: string };
    expect(ext.sessions).toHaveLength(2);
    expect(ext.sessions.map((s) => s.name)).toEqual(["S1", "S3"]);
    // Neighbouring keys survive: this is a patch, not a replacement.
    expect(ext.tz).toBe("UTC");
  });

  it("drops a deleted time window from the live indicator", () => {
    const { chart, live } = fakeChart();
    const three = [windowAt(1), windowAt(2), windowAt(3)];
    chart.createIndicator({ name: "TIME_HIGHLIGHT", extendData: { windows: three } } as never);
    const write = makeWriteWindows(chart, live[0].paneId, "TIME_HIGHLIGHT", () => {});
    write(three.slice(0, 1));
    const ext = live[0].extendData as { windows: TimeWindowDef[] };
    expect(ext.windows).toHaveLength(1);
  });
});
