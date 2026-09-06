import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// sessions.ts reads IndicatorSeries + registerYAxis at module load; stub
// klinecharts' runtime surface like rsiDivergence.test.ts / overlays.test.ts do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import {
  DEFAULT_SESSIONS,
  localTimeToUtc,
  sessionActiveAt,
  computeSessions,
  buildSegments,
  SESSIONS_TEMPLATE,
  type SessionDef,
} from "./sessions";

const bar = (iso: string): KLineData =>
  ({ timestamp: Date.parse(iso), open: 1, high: 1, low: 1, close: 1, volume: 1 }) as KLineData;

const s = (over: Partial<SessionDef>): SessionDef => ({
  id: "x",
  name: "X",
  color: "#000",
  timezone: "UTC",
  open: "08:00",
  close: "16:00",
  enabled: true,
  ...over,
});

describe("localTimeToUtc", () => {
  it("resolves a UTC local time to the same instant", () => {
    expect(localTimeToUtc(Date.parse("2026-07-06T12:00:00Z"), "UTC", "08:00")).toBe(
      Date.parse("2026-07-06T08:00:00Z"),
    );
  });
  it("is DST-aware for New York (EDT, UTC-4 in July)", () => {
    // 08:00 America/New_York on 2026-07-06 == 12:00 UTC
    expect(localTimeToUtc(Date.parse("2026-07-06T15:00:00Z"), "America/New_York", "08:00")).toBe(
      Date.parse("2026-07-06T12:00:00Z"),
    );
  });
  it("is DST-aware for New York (EST, UTC-5 in January)", () => {
    // 08:00 America/New_York on 2026-01-06 == 13:00 UTC
    expect(localTimeToUtc(Date.parse("2026-01-06T15:00:00Z"), "America/New_York", "08:00")).toBe(
      Date.parse("2026-01-06T13:00:00Z"),
    );
  });
});

describe("sessionActiveAt", () => {
  const london = s({ id: "london", timezone: "Europe/London", open: "08:00", close: "16:00" });
  it("is active inside the window", () => {
    // 12:00 BST == 11:00 UTC, inside 08:00-16:00 BST (07:00-15:00 UTC)
    expect(sessionActiveAt(Date.parse("2026-07-06T11:00:00Z"), london)).toBe(true);
  });
  it("is inactive outside the window", () => {
    expect(sessionActiveAt(Date.parse("2026-07-06T20:00:00Z"), london)).toBe(false);
  });
  it("respects a session that crosses local midnight", () => {
    const cross = s({ id: "c", timezone: "UTC", open: "22:00", close: "06:00" });
    expect(sessionActiveAt(Date.parse("2026-07-06T23:00:00Z"), cross)).toBe(true); // evening tail
    expect(sessionActiveAt(Date.parse("2026-07-06T03:00:00Z"), cross)).toBe(true); // early-morning tail
    expect(sessionActiveAt(Date.parse("2026-07-06T12:00:00Z"), cross)).toBe(false); // midday gap
  });
  it("is never active when disabled", () => {
    expect(sessionActiveAt(Date.parse("2026-07-06T11:00:00Z"), s({ ...london, enabled: false }))).toBe(
      false,
    );
  });
});

describe("computeSessions + buildSegments", () => {
  it("marks overlap bars with both session ids (London + New York)", () => {
    // 14:00 UTC: London (07:00-15:00 UTC) AND New York (12:00-21:00 UTC in July) both active
    const ext = {
      sessions: [
        s({ id: "london", name: "London", timezone: "Europe/London", open: "08:00", close: "16:00" }),
        s({ id: "newyork", name: "New York", timezone: "America/New_York", open: "08:00", close: "17:00" }),
      ],
    };
    const pts = computeSessions([bar("2026-07-06T14:00:00Z")], ext);
    expect(pts[0].ids?.slice().sort()).toEqual(["london", "newyork"]);
  });
  it("collapses equal-membership runs into contiguous segments", () => {
    const ext = { sessions: [s({ id: "london", timezone: "UTC", open: "08:00", close: "16:00" })] };
    const bars = [
      bar("2026-07-06T07:00:00Z"),
      bar("2026-07-06T09:00:00Z"),
      bar("2026-07-06T10:00:00Z"),
      bar("2026-07-06T18:00:00Z"),
    ];
    const segs = buildSegments(computeSessions(bars, ext));
    // bars 1-2 in-session (one segment), bars 0 and 3 out (no segment)
    expect(segs).toEqual([{ start: 1, end: 2, ids: ["london"] }]);
  });
  it("uses DEFAULT_SESSIONS when ext has none", () => {
    const pts = computeSessions([bar("2026-07-06T14:00:00Z")], {});
    expect(Array.isArray(pts[0].ids)).toBe(true);
    expect(DEFAULT_SESSIONS.length).toBe(4);
  });
});

describe("SESSIONS_TEMPLATE.draw visible-range cull", () => {
  // The draw must skip segments wholly outside the pane: the segment list
  // covers the ENTIRE loaded series, and on a long 1m load the off-pane
  // conversions put fills (and shadowed labels) hundreds of thousands of
  // pixels off-canvas, every frame, for bands no one can see.
  const draw = SESSIONS_TEMPLATE.draw as (params: unknown) => boolean;

  function paint(viewCenterIdx: number) {
    const points = Array.from({ length: 3000 }, (_, i) =>
      (i >= 100 && i <= 200) || (i >= 2500 && i <= 2600) ? { ids: ["x"] } : {},
    );
    const rects: number[][] = [];
    const texts: number[][] = [];
    const ctx = new Proxy(
      {
        fillRect: (...a: number[]) => rects.push(a),
        fillText: (_t: string, x: number, y: number) => texts.push([x, y]),
        measureText: () => ({ width: 10 }),
      },
      { get: (t, p) => (p in t ? t[p as keyof typeof t] : () => {}), set: () => true },
    );
    const barPx = 6;
    draw({
      ctx,
      indicator: { result: points, extendData: { sessions: [s({})] } },
      xAxis: { convertToPixel: (i: number) => (i - viewCenterIdx) * barPx + 450 },
      bounding: { width: 900, height: 20 },
    });
    return { rects, texts };
  }

  it("paints the on-screen segment and skips the far-off-pane one", () => {
    const { rects } = paint(2550); // viewing bars ~2475..2625
    expect(rects.length).toBeGreaterThan(0);
    // Every painted rect intersects the pane; nothing lands at bar 150's
    // ~-14,000px conversion.
    for (const [x, , w] of rects) {
      expect(x + w).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(900);
    }
  });

  it("draws no label for a segment whose span sits off-pane", () => {
    const { texts } = paint(2550);
    for (const [x] of texts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(900);
    }
  });
});
