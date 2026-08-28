// The diagnostic has to be trustworthy in the one situation it exists for: a
// tab that has gone hot. That means it must flag the real shapes of trouble
// (a slow recalc, a sustained busy share, a fetch that will not settle) and
// stay silent otherwise — a heartbeat in the console would bury the signal it
// is meant to surface.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { recordTick, recordFetch, recordBars, report, hot, reset } from "./perfDiag";

const WINDOW_MS = 15_000;

let clock = 0;
let nowSpy: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** Advance the fake clock; records read performance.now() themselves. */
const at = (ms: number) => {
  clock = ms;
};

beforeEach(() => {
  clock = 1000;
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  reset();
});

afterEach(() => {
  nowSpy.mockRestore();
  warn.mockRestore();
});

describe("perfDiag windows", () => {
  it("accumulates ticks into the open window without closing it early", () => {
    recordTick(5);
    at(1000 + WINDOW_MS - 1);
    recordTick(7);

    const open = report()[0];
    expect(open.ticks).toBe(2);
    expect(open.tickMs).toBe(12);
    expect(open.maxTickMs).toBe(7);
    expect(report()).toHaveLength(1); // still one window: nothing closed yet
  });

  it("closes a window once it is old enough, newest first", () => {
    recordTick(1);
    at(1000 + WINDOW_MS + 1);
    recordTick(2); // closes the first window, opens a second

    const all = report();
    expect(all.length).toBe(2);
    expect(all[0].ticks).toBe(1); // the newly opened window, holding the 2ms tick
    expect(all[1].ticks).toBe(1); // the closed one
    expect(all[1].tickMs).toBe(1);
  });

  it("says nothing about a healthy window", () => {
    // 20 ticks of 1ms across 15s is well under every threshold.
    for (let i = 0; i < 20; i++) {
      at(1000 + i * 100);
      recordTick(1);
    }
    at(1000 + WINDOW_MS + 1);
    recordTick(1);

    expect(warn).not.toHaveBeenCalled();
    expect(hot()).toHaveLength(0);
  });
});

describe("perfDiag thresholds", () => {
  it("flags a single slow recalc", () => {
    recordTick(120);
    at(1000 + WINDOW_MS + 1);
    recordTick(1);

    const closed = report()[1];
    expect(closed.flags.join()).toContain("slow-tick(120ms)");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("[perf]");
  });

  it("flags a sustained busy share even when no single tick is slow", () => {
    // 300 ticks x 20ms = 6s of work inside a 15s window: 40% busy, and every
    // individual tick sits under the slow-tick threshold.
    for (let i = 0; i < 300; i++) {
      at(1000 + i * 40);
      recordTick(20);
    }
    at(1000 + WINDOW_MS + 1);
    recordTick(1);

    const closed = report()[1];
    expect(closed.maxTickMs).toBeLessThan(50); // no single slow tick
    expect(closed.flags.join()).toContain("busy(");
    expect(closed.busy).toBeGreaterThan(0.2);
  });

  it("flags a windowed-fetch storm and keeps range and recent apart", () => {
    for (let i = 0; i < 25; i++) {
      at(1000 + i * 100);
      recordFetch("range", 0);
      recordBars(500);
    }
    recordFetch("recent", 500);
    at(1000 + WINDOW_MS + 1);
    recordTick(1);

    const closed = report()[1];
    expect(closed.rangeFetches).toBe(25);
    expect(closed.recentFetches).toBe(1);
    expect(closed.barsFetched).toBe(25 * 500 + 500);
    expect(closed.flags.join()).toContain("fetch-storm(25)");
  });

  it("does not flag a bounded scroll-back walk", () => {
    // The pager is capped at 16 pages; one full walk must not read as a storm.
    for (let i = 0; i < 16; i++) {
      at(1000 + i * 100);
      recordFetch("range", 0);
      recordBars(500);
    }
    at(1000 + WINDOW_MS + 1);
    recordTick(1);

    expect(report()[1].flags).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("perfDiag bookkeeping", () => {
  it("counts a request once when its rows are recorded separately", () => {
    recordFetch("range", 0);
    recordBars(320);
    const open = report()[0];
    expect(open.rangeFetches).toBe(1);
    expect(open.barsFetched).toBe(320);
  });

  it("reset drops history", () => {
    recordTick(5);
    at(1000 + WINDOW_MS + 1);
    recordTick(5);
    expect(report().length).toBe(2);

    reset();
    const after = report();
    expect(after.length).toBe(1);
    expect(after[0].ticks).toBe(0);
  });
});
