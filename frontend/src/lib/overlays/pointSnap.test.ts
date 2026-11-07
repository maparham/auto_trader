import { describe, it, expect } from "vitest";
import { canonicalize, captureSnap, resolveDisplay, snapDisplayTs, snapsDiffer, type PointSnap } from "./pointSnap";

const H4 = 4 * 3600_000;
const D0 = Date.UTC(2026, 9, 12);
// One day of 4H bars: open on bar 0 (105), low 90 on bar 3, high 130 on bar 4.
const bars = Array.from({ length: 6 }, (_, i) => ({
  timestamp: D0 + i * H4,
  open: 105,
  high: i === 4 ? 130 : 110,
  low: i === 3 ? 90 : 100,
  close: i === 5 ? 107 : 106,
}));
const snap = (k: PointSnap["k"], v: number): PointSnap => ({ k, tf: "DAY", t: D0, v });

describe("snapDisplayTs", () => {
  it("finds the candle that traded each level on a finer chart", () => {
    expect(snapDisplayTs(snap("low", 90), bars, H4)).toBe(D0 + 3 * H4);
    expect(snapDisplayTs(snap("high", 130), bars, H4)).toBe(D0 + 4 * H4);
    expect(snapDisplayTs(snap("open", 105), bars, H4)).toBe(D0);
    expect(snapDisplayTs(snap("close", 107), bars, H4)).toBe(D0 + 5 * H4);
  });
  it("keeps the bar open on the same or a coarser chart, or when its start is not loaded", () => {
    expect(snapDisplayTs(snap("low", 90), bars, 24 * 3600_000)).toBe(D0);
    expect(snapDisplayTs(snap("low", 90), bars.slice(1), H4)).toBe(D0);
  });
});

describe("captureSnap", () => {
  it("records the level a point sits exactly on, extremes first", () => {
    expect(captureSnap({ timestamp: D0 + 3 * H4, value: 90 }, bars, "HOUR_4")).toEqual({
      k: "low", tf: "HOUR_4", t: D0 + 3 * H4, v: 90,
    });
    expect(captureSnap({ timestamp: D0 + 3 * H4, value: 95 }, bars, "HOUR_4")).toBeNull();
    expect(captureSnap({ dataIndex: 40, value: 90 }, bars, "HOUR_4")).toBeNull();
  });
});

describe("resolveDisplay", () => {
  it("moves only points that still match their snap", () => {
    const r = resolveDisplay(
      "segment",
      [{ timestamp: D0, value: 90 }, { timestamp: D0, value: 99 }],
      [snap("low", 90), snap("low", 90)],
      bars,
      H4,
    );
    expect(r.points.map((p) => p.timestamp)).toEqual([D0 + 3 * H4, D0]);
    expect(r.display).toEqual([D0 + 3 * H4, null]);
  });
  it("ignores tools outside the list", () => {
    const r = resolveDisplay("verticalStraightLine", [{ timestamp: D0, value: 90 }], [snap("low", 90)], bars, H4);
    expect(r.points[0].timestamp).toBe(D0);
  });
  it("keeps a trade box's stop on its target's time", () => {
    const r = resolveDisplay(
      "tradeBox",
      [{ timestamp: D0 - H4, value: 95 }, { timestamp: D0, value: 130 }, { timestamp: D0, value: 80 }],
      [null, snap("high", 130), null],
      bars,
      H4,
    );
    expect(r.points.map((p) => p.timestamp)).toEqual([D0 - H4, D0 + 4 * H4, D0 + 4 * H4]);
  });
});

describe("canonicalize", () => {
  it("writes an untouched point at its bar open and recaptures a moved one", () => {
    const live = [{ timestamp: D0 + 3 * H4, value: 90 }, { timestamp: D0 + 4 * H4, value: 130 }];
    const c = canonicalize("segment", live, live, [snap("low", 90), null], [D0 + 3 * H4, null], bars, "HOUR_4");
    expect(c.points.map((p) => p.timestamp)).toEqual([D0, D0 + 4 * H4]);
    expect(c.snaps).toEqual([snap("low", 90), { k: "high", tf: "HOUR_4", t: D0 + 4 * H4, v: 130 }]);
  });
  it("never captures a point unchanged since load", () => {
    const live = [{ timestamp: D0 + 3 * H4, value: 90 }];
    const c = canonicalize("segment", live, live, undefined, undefined, bars, "HOUR_4", live);
    expect(c.snaps).toEqual([null]);
  });
  it("drops the snap of a point dragged off any level", () => {
    const live = [{ timestamp: D0 + 2 * H4, value: 95 }];
    const c = canonicalize("segment", live, live, [snap("low", 90)], [D0 + 3 * H4], bars, "HOUR_4");
    expect(c.snaps).toEqual([null]);
    expect(c.points[0].timestamp).toBe(D0 + 2 * H4);
  });
});

describe("snapsDiffer", () => {
  it("treats absent and all-null as equal", () => {
    expect(snapsDiffer(undefined, [null, null])).toBe(false);
    expect(snapsDiffer([snap("low", 90)], [snap("low", 90)])).toBe(false);
    expect(snapsDiffer([snap("low", 90)], [null])).toBe(true);
  });
});
