import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import {
  barCloseMs,
  revealedCount,
  revealedBars,
  nextCursorMs,
  prevCursorMs,
  cursorForStartTs,
  mergeOlder,
  nominalMsFor,
  needsBuffer,
  bufferWindowSec,
  mergeForward,
  hasLoadedSuccessor,
} from "./replayBars";

const HOUR = 3_600_000;
// Four hourly bars starting 2026-03-02T00:00Z.
const T0 = Date.UTC(2026, 2, 2, 0, 0, 0);
const bar = (ts: number, c: number): KLineData => ({
  timestamp: ts,
  open: c,
  high: c + 1,
  low: c - 1,
  close: c,
});
const hourly: KLineData[] = [0, 1, 2, 3].map((i) => bar(T0 + i * HOUR, 100 + i));

describe("barCloseMs", () => {
  it("uses the NEXT bar's timestamp as the close", () => {
    expect(barCloseMs(hourly, 0, HOUR)).toBe(T0 + HOUR);
    expect(barCloseMs(hourly, 2, HOUR)).toBe(T0 + 3 * HOUR);
  });

  it("falls back to the nominal width for the last loaded bar", () => {
    expect(barCloseMs(hourly, 3, HOUR)).toBe(T0 + 4 * HOUR);
  });

  it("closes a MONTH bucket on the next bucket's start, not 30 days later", () => {
    // The nominal MONTH width (30d) would close July on Jul 31 — wrong.
    const months = [Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1)].map((ts) =>
      bar(ts, 1),
    );
    expect(barCloseMs(months, 1, nominalMsFor("MONTH"))).toBe(Date.UTC(2026, 7, 1));
  });
});

describe("revealedCount / revealedBars", () => {
  it("reveals every bar CLOSED at or before the cursor", () => {
    expect(revealedCount(hourly, T0 + 2 * HOUR, HOUR)).toBe(2);
    expect(revealedBars(hourly, T0 + 2 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([
      T0,
      T0 + HOUR,
    ]);
  });

  it("does not reveal a bar that closes one ms after the cursor", () => {
    expect(revealedCount(hourly, T0 + 2 * HOUR - 1, HOUR)).toBe(1);
  });

  it("reveals nothing before the first close", () => {
    expect(revealedCount(hourly, T0, HOUR)).toBe(0);
    expect(revealedBars(hourly, T0, HOUR)).toEqual([]);
  });

  it("hides the forming higher-timeframe bar at a mid-bucket cursor", () => {
    // Cursor known through 14:30; the 14:00 hourly bar has not closed yet.
    const h = [12, 13, 14, 15].map((hr) => bar(Date.UTC(2026, 2, 2, hr), 1));
    const cursor = Date.UTC(2026, 2, 2, 14, 30);
    expect(revealedBars(h, cursor, HOUR).map((b) => b.timestamp)).toEqual([
      Date.UTC(2026, 2, 2, 12),
      Date.UTC(2026, 2, 2, 13),
    ]);
  });
});

describe("nextCursorMs / prevCursorMs", () => {
  it("steps to the close of the first unrevealed bar", () => {
    expect(nextCursorMs(hourly, T0 + HOUR, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null at the end of the loaded bars", () => {
    expect(nextCursorMs(hourly, T0 + 4 * HOUR, HOUR)).toBe(null);
  });

  it("steps back to the previous bar's close", () => {
    expect(prevCursorMs(hourly, T0 + 3 * HOUR, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null when only one bar is revealed (cannot go blank)", () => {
    expect(prevCursorMs(hourly, T0 + HOUR, HOUR)).toBe(null);
  });
});

describe("cursorForStartTs", () => {
  it("snaps a picked timestamp to the close of the bar containing it", () => {
    expect(cursorForStartTs(hourly, T0 + HOUR + 900_000, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null when no bar covers the timestamp", () => {
    expect(cursorForStartTs(hourly, T0 - HOUR, HOUR)).toBe(null);
  });
});

describe("mergeOlder", () => {
  it("keeps scroll-back-paged bars older than the replay slice", () => {
    const paged = [bar(T0 - 2 * HOUR, 90), bar(T0 - HOUR, 91), ...hourly.slice(0, 2)];
    const merged = mergeOlder(paged, hourly.slice(0, 2));
    expect(merged.map((b) => b.timestamp)).toEqual([T0 - 2 * HOUR, T0 - HOUR, T0, T0 + HOUR]);
  });

  it("never lets an existing bar at or after the slice start through", () => {
    const paged = [...hourly]; // includes bars the cursor has not revealed
    const merged = mergeOlder(paged, hourly.slice(0, 2));
    expect(merged.map((b) => b.timestamp)).toEqual([T0, T0 + HOUR]);
  });

  it("returns the slice unchanged when nothing is loaded", () => {
    expect(mergeOlder([], hourly.slice(0, 1))).toEqual(hourly.slice(0, 1));
  });
});

describe("needsBuffer", () => {
  it("asks for more bars when the cursor is within the margin of the end", () => {
    expect(needsBuffer(hourly, T0 + 3 * HOUR, HOUR, 2)).toBe(true);
    expect(needsBuffer(hourly, T0 + HOUR, HOUR, 2)).toBe(false);
  });
});

describe("mergeForward", () => {
  it("GROWS the store when a refill window shifts forward over continuous data", () => {
    // The regression for the stalled forward buffer: bufferWindowSec spans a
    // FIXED duration, so a refill re-centred on the advanced cursor returns the
    // same bar COUNT shifted right. Comparing lengths keeps the old store
    // forever and the session stalls; a merge must keep both ends.
    const store = Array.from({ length: 500 }, (_, i) => bar(T0 + i * HOUR, i));
    const shifted = Array.from({ length: 500 }, (_, i) => bar(T0 + (i + 150) * HOUR, i + 150));
    const merged = mergeForward(store, shifted);
    expect(merged).toHaveLength(650); // 500 + the 150 genuinely new forward bars
    expect(merged[0].timestamp).toBe(T0); // the store's oldest bar survives
    expect(merged[merged.length - 1].timestamp).toBe(T0 + 649 * HOUR); // reaches the fetch's end
    expect(merged.length).toBeGreaterThan(shifted.length); // a length swap would lose history
  });

  it("returns the store unchanged when the fetch came back empty", () => {
    expect(mergeForward(hourly, [])).toEqual(hourly);
  });

  it("does not duplicate overlapping bars", () => {
    const merged = mergeForward(hourly.slice(0, 3), hourly.slice(1));
    expect(merged.map((b) => b.timestamp)).toEqual(hourly.map((b) => b.timestamp));
  });

  it("lets a fetched bar replace a stored one at the same timestamp", () => {
    const restated = [bar(T0 + HOUR, 999)];
    const merged = mergeForward(hourly, restated);
    expect(merged).toHaveLength(4);
    expect(merged[1].close).toBe(999); // the fresher read wins
  });

  it("prepends a fetch that is strictly older than the store", () => {
    const older = [bar(T0 - 2 * HOUR, 1), bar(T0 - HOUR, 2)];
    const merged = mergeForward(hourly, older);
    expect(merged.map((b) => b.timestamp)).toEqual([
      T0 - 2 * HOUR,
      T0 - HOUR,
      ...hourly.map((b) => b.timestamp),
    ]);
  });

  it("returns the fetch when the store is empty", () => {
    expect(mergeForward([], hourly)).toEqual(hourly);
  });
});

describe("hasLoadedSuccessor", () => {
  // The single predicate behind the amendment: a step may only land on a bar
  // whose close is a REAL next-bar timestamp, never barCloseMs's nominal guess.
  it("is true while the cursor sits before the second-to-last bar", () => {
    expect(hasLoadedSuccessor(hourly, T0 + HOUR, HOUR)).toBe(true); // 2 revealed of 4
  });

  it("is true exactly at the boundary (stepping onto the second-to-last bar)", () => {
    // 2 revealed, so the step lands on bars[2], which still has bars[3] behind it.
    expect(revealedCount(hourly, T0 + 2 * HOUR, HOUR)).toBe(hourly.length - 2);
    expect(hasLoadedSuccessor(hourly, T0 + 2 * HOUR, HOUR)).toBe(true);
  });

  it("is false when the step would land on the LAST loaded bar", () => {
    // 3 revealed: the step would land on bars[3], whose close is a nominal guess.
    expect(revealedCount(hourly, T0 + 3 * HOUR, HOUR)).toBe(hourly.length - 1);
    expect(hasLoadedSuccessor(hourly, T0 + 3 * HOUR, HOUR)).toBe(false);
  });

  it("is false once everything loaded is revealed, and on an empty store", () => {
    expect(hasLoadedSuccessor(hourly, T0 + 4 * HOUR, HOUR)).toBe(false);
    expect(hasLoadedSuccessor([], T0, HOUR)).toBe(false);
  });
});

describe("bufferWindowSec", () => {
  const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

  it("spans context bars before the start and buffer bars after it", () => {
    const w = bufferWindowSec({ centerMs: NOW - 10 * 3_600_000, resSec: 3600, contextBars: 300, forwardBars: 200, nowMs: NOW });
    expect(w.fromSec).toBe(Math.floor((NOW - 10 * 3_600_000) / 1000) - 300 * 3600);
    expect(w.toSec).toBe(Math.floor(NOW / 1000)); // clamped: replay never crosses now
  });

  it("never asks for bars past now", () => {
    const w = bufferWindowSec({ centerMs: NOW, resSec: 3600, contextBars: 10, forwardBars: 200, nowMs: NOW });
    expect(w.toSec).toBe(Math.floor(NOW / 1000));
  });
});
