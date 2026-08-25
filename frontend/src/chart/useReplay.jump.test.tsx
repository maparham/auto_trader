// @vitest-environment jsdom
//
// What a random jump does when the window it was given runs past the end of the
// broker's history. That is the dead end that actually stops a jump: a broker
// keeps minute candles for weeks and hourly ones for years, so "past year" on a
// minute chart is mostly empty space. The earlier version re-rolled WIDER on
// each miss, walking further from the only data there was, and then told the
// user to try a wider window still.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { TradeView } from "../lib/trading";

installMemStorage();

vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades: vi.fn(),
}));

vi.mock("../lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/notify")>()),
  toast: vi.fn(),
}));

const fetchRangeWithStatus = vi.hoisted(() => vi.fn());
vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feed")>()),
  fetchRangeWithStatus,
}));

const { useReplay } = await import("./useReplay");
const { toast } = await import("../lib/notify");

const MIN = 60_000;
const DAY = 86_400_000;
const YEAR = 365 * DAY;

/** Bars every minute inside the requested range, but never older than `floorMs`:
 * an instrument whose minute history simply stops there, which is what the real
 * feed does (an empty page, or a broker timeout on the way to one). */
function historyFrom(floorMs: number, degradedFor: (fromMs: number) => string | null = () => null) {
  return async (_epic: string, _res: string, fromSec: number, toSec: number) => {
    const fromMs = fromSec * 1000;
    const degraded = degradedFor(fromMs);
    if (degraded) return { bars: [], degraded, partial: null };
    const start = Math.max(fromMs, floorMs);
    if (start > toSec * 1000) return { bars: [], degraded: null, partial: null };
    const bars = [];
    for (let t = start; t <= toSec * 1000; t += MIN) {
      bars.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    }
    return { bars, degraded: null, partial: null };
  };
}

function mount() {
  const handle = {
    chartRef: { current: null },
    dataFacadeRef: { current: null },
    tradesRef: { current: [] as TradeView[] },
    posDrawRef: { current: () => {} },
    redrawRef: { current: () => {} },
    replayRef: { current: null },
  } as unknown as ChartHandle;
  return renderHook(() =>
    useReplay(handle, {
      epic: "US100",
      resolution: "MINUTE",
      priceSide: "mid",
      brokerId: "capital",
      scope: "tab1.cellJump",
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  // Every draw lands at the far edge of the attempt's window, so which attempt
  // succeeded is exactly where the session starts.
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("a random jump into a market closure", () => {
  // A target inside a weekend/holiday gap WIDER than the fetch window used to
  // read as a dead zone: the window's forward side (200 MINUTE bars = 3.3h)
  // never reached the far side, cursorForStartTs saw no loaded successor, and
  // the loop halved toward now — silently shrinking a 200-day ask to weeks.
  // The probe walk (nextProbeWindowSec) crosses the gap instead, so the jump
  // snaps to the first bar after the closure exactly as it already does for
  // gaps narrower than the window.
  function historyWithGap(gapStartMs: number, gapEndMs: number) {
    return async (_epic: string, _res: string, fromSec: number, toSec: number) => {
      const bars = [];
      for (let t = fromSec * 1000; t <= toSec * 1000; t += MIN) {
        if (t >= gapStartMs && t < gapEndMs) continue;
        bars.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
      }
      return { bars, degraded: null, partial: null };
    };
  }

  it("crosses the gap and starts at the first bar after it, without re-rolling", async () => {
    const now = Date.now();
    // Math.random = 0 puts the attempt-0 target at the window's far edge; the
    // gap is 1000 minutes wide (5x the forward buffer) and the target lands
    // 500 minutes INTO it — far enough from the last pre-gap bar that its
    // nominal-width close cannot cover the target.
    const windowMs = 30 * DAY;
    const gapStart = now - windowMs - 500 * MIN;
    const gapEnd = gapStart + 1000 * MIN;
    fetchRangeWithStatus.mockImplementation(historyWithGap(gapStart, gapEnd));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(windowMs, true));

    expect(result.current.state.mode).toBe("active");
    // Snapped to the first bar past the closure (the mock's grid is per-fetch,
    // so allow one bar of slack), never a shallower re-roll.
    expect(result.current.state.startMs).toBeGreaterThanOrEqual(gapEnd);
    expect(result.current.state.startMs).toBeLessThanOrEqual(gapEnd + 2 * MIN);
    expect(result.current.state.error).toBeNull();
    // Attempt 0 landed where it was asked to; nothing to apologise for.
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a random jump past the end of the broker's history", () => {
  it("re-rolls closer to now until it finds candles, and says that it did", async () => {
    const now = Date.now();
    fetchRangeWithStatus.mockImplementation(historyFrom(now - 20 * DAY));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    // A year halved five times is about eleven days: the first draw that clears
    // the floor. Widening would have spent all six attempts in empty space.
    expect(result.current.state.mode).toBe("active");
    expect(result.current.state.startMs).toBeGreaterThan(now - 20 * DAY);
    expect(result.current.state.error).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("stayed closer to now"));
  });

  it("says nothing when the first draw lands", async () => {
    fetchRangeWithStatus.mockImplementation(historyFrom(Date.now() - 2 * YEAR));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.mode).toBe("active");
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not blame the timeframe while the backend is still downloading", async () => {
    // An empty page under the still-loading marker means the download has not
    // reached that far back yet, not that the history is absent. Telling the user
    // to change timeframe would be advice for a problem they do not have.
    fetchRangeWithStatus.mockImplementation(async () => ({
      bars: [],
      degraded: null,
      partial: "still loading history (2/175 chunks)",
    }));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.error).toBe(
      "Still loading history for that range. Try again in a moment.",
    );
  });

  it("gives up with advice that can actually help", async () => {
    // Nothing at this timeframe at all. "Try a wider one" was the old copy, and
    // it pointed at the one thing that cannot work.
    fetchRangeWithStatus.mockImplementation(historyFrom(Number.POSITIVE_INFINITY));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.mode).toBe("picking");
    expect(result.current.state.loading).toBe(false);
    expect(result.current.state.error).toBe("No candles at this timeframe. Try a higher one.");
  });
});

// A read that never arrives at all. Asking a broker for year-old MINUTE candles
// can hang for minutes, which left the picker on "Finding candles..." with no way
// forward: the jump now gives each read a deadline and spends the time elsewhere.
describe("a random jump whose read never comes back", () => {
  it("moves on instead of hanging, and lands where the history is", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      fetchRangeWithStatus.mockImplementation(
        async (_e: string, _r: string, fromSec: number, toSec: number, _p: string, _b: string, signal: AbortSignal) => {
          // The deep ask never answers (it hangs until the deadline aborts it,
          // which is what the real fetch does); the near one answers at once.
          if (fromSec * 1000 < now - 100 * DAY) {
            return new Promise((_res, rej) =>
              signal.addEventListener("abort", () => rej(new Error("aborted"))),
            );
          }
          return historyFrom(now - 2 * YEAR)(_e, _r, fromSec, toSec);
        },
      );
      const { result } = mount();
      act(() => result.current.enterPicking());

      let jumped: Promise<unknown>;
      act(() => { jumped = Promise.resolve(result.current.randomJump(YEAR, true)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(11_000); await jumped; });

      expect(result.current.state.mode).toBe("active");
      expect(result.current.state.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// A broker that times out fetching year-old minute candles is not a broker that
// is down, and telling the user it is unreachable sends them to check their
// connection over a window they could simply have narrowed.
describe("a random jump that reads degraded", () => {
  it("asks again much nearer to now before believing the outage", async () => {
    const now = Date.now();
    // The deep asks time out; the near ones are cached and answer.
    fetchRangeWithStatus.mockImplementation(
      historyFrom(now - 2 * YEAR, (fromMs) => (fromMs < now - 100 * DAY ? "broker timed out" : null)),
    );
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.mode).toBe("active");
    expect(result.current.state.error).toBeNull();
    // Two reads, not seven: a timeout is evidence about the DEPTH, so the search
    // collapses several halvings at once instead of creeping down one at a time
    // with a slow broker call for each. A real outage costs the same two.
    expect(fetchRangeWithStatus).toHaveBeenCalledTimes(2);
  });

  it("lets a read that arrived have the last word over one that did not", async () => {
    // Deep asks time out, near ones answer and are simply empty. The timeframe is
    // the real answer here, and a single deep timeout must not speak for the run.
    const now = Date.now();
    fetchRangeWithStatus.mockImplementation(
      historyFrom(Number.POSITIVE_INFINITY, (fromMs) =>
        fromMs < now - 100 * DAY ? "broker timed out" : null,
      ),
    );
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.error).toBe("No candles at this timeframe. Try a higher one.");
  });

  it("reports the backend's own reason once they keep coming", async () => {
    fetchRangeWithStatus.mockImplementation(historyFrom(0, () => "broker unreachable (503)"));
    const { result } = mount();
    act(() => result.current.enterPicking());

    await act(async () => result.current.randomJump(YEAR, true));

    expect(result.current.state.error).toBe("broker unreachable (503)");
    expect(result.current.state.mode).toBe("picking");
    expect(fetchRangeWithStatus).toHaveBeenCalledTimes(2);
  });
});

// The reveal is ARMED by a start, not by the toggle: a session that begins on a
// cell with a saved backtest shows the run it is replaying without the user
// having to find the pill first. Asserted here rather than in reveal.test.tsx
// because that file's harness is resume-only by design, and resuming is the one
// path that must NOT arm (it restores the toggle the user left).
describe("the strategy reveal at session start", () => {
  const BACKTEST_KEY = "auto-trader.tab1.cellJump.backtest.US100";

  it("arms itself when the cell has a saved backtest", async () => {
    localStorage.setItem(
      BACKTEST_KEY,
      JSON.stringify({ epic: "US100", resolution: "MINUTE", markers: [], trades: [], equity: [] }),
    );
    fetchRangeWithStatus.mockImplementation(historyFrom(0));
    const { result } = mount();
    expect(result.current.showStrategy).toBe(false); // nothing started yet

    act(() => result.current.enterPicking());
    await act(async () => result.current.randomJump(30 * DAY, true));

    expect(result.current.state.mode).toBe("active");
    expect(result.current.showStrategy).toBe(true);
    expect(result.current.hasStrategy).toBe(true);
  });

  it("stays off when there is nothing to reveal", async () => {
    fetchRangeWithStatus.mockImplementation(historyFrom(0));
    const { result } = mount();

    act(() => result.current.enterPicking());
    await act(async () => result.current.randomJump(30 * DAY, true));

    expect(result.current.state.mode).toBe("active");
    expect(result.current.showStrategy).toBe(false);
  });

  it("arms a dated start too, not just a jump", async () => {
    localStorage.setItem(
      BACKTEST_KEY,
      JSON.stringify({ epic: "US100", resolution: "MINUTE", markers: [], trades: [], equity: [] }),
    );
    fetchRangeWithStatus.mockImplementation(historyFrom(0));
    const { result } = mount();

    act(() => result.current.enterPicking());
    await act(async () => result.current.startAt(Date.now() - 5 * DAY, { masked: false }));

    expect(result.current.state.mode).toBe("active");
    expect(result.current.showStrategy).toBe(true);
  });
});
