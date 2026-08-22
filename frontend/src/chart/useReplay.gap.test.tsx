// @vitest-environment jsdom
//
// A market-closure gap WIDER than the refill window (a crude-oil weekend is
// ~49h; MINUTE_5's forward buffer is ~17h) must not end the session. The refill
// re-centres a fixed-width window on the cursor, so inside such a gap it comes
// back empty — which is exactly what the true end of history looks like. The
// probe loop (nextProbeWindowSec) is what tells them apart, and only this
// hook-level test can prove the wiring: stepping into the gap keeps the session
// alive and the next steps come out the other side.
//
// Harness: the resumed-session one from useReplay.lifecycle.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { TradeView } from "../lib/trading";

installMemStorage();

const refreshTrades = vi.hoisted(() => vi.fn());
vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades,
}));

const MIN = 60_000;
// The trading calendar under test: 400 minutes of bars, a 1000-minute closure
// (5x the 200-bar forward buffer at MINUTE), then 600 more minutes of bars.
const GAP_START = vi.hoisted(() => Date.UTC(2021, 4, 14, 21, 0));
const GAP_END = vi.hoisted(() => Date.UTC(2021, 4, 14, 21, 0) + 1000 * 60_000);
const UNIVERSE = vi.hoisted(() => {
  const MIN = 60_000;
  const bar = (ts: number) => ({
    timestamp: ts, open: 100, high: 101, low: 99, close: 100, volume: 1,
  });
  const bars = [];
  for (let t = GAP_START - 400 * MIN; t < GAP_START; t += MIN) bars.push(bar(t));
  for (let t = GAP_END; t < GAP_END + 600 * MIN; t += MIN) bars.push(bar(t));
  return bars;
});

const fetchRangeWithStatus = vi.hoisted(() => vi.fn());
vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feed")>()),
  fetchRangeWithStatus,
}));

const { useReplay } = await import("./useReplay");

const SCOPE = "tab1.cellGap";
const EPIC = "OIL_CRUDE";
const REPLAY_KEY = "auto-trader.replaySessions";
// Three bars shy of the closure, so a couple of steps reach it.
const CURSOR = GAP_START - 3 * MIN;

function seedSession(): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "MINUTE",
    startMs: GAP_START - 400 * MIN,
    cursorMs: CURSOR,
    highWaterMs: CURSOR,
    masked: true,
    showStrategy: false,
    ledger: { orders: [], positions: [], closed: [], seq: 0 },
    savedAt: Date.now(),
  };
  localStorage.setItem(REPLAY_KEY, JSON.stringify({ [SCOPE]: rec }));
}

function fakeHandle(): ChartHandle {
  return {
    chartRef: { current: null },
    dataFacadeRef: { current: null },
    tradesRef: { current: [] as TradeView[] },
    posDrawRef: { current: () => {} },
    redrawRef: { current: () => {} },
    replayRef: { current: null },
  } as unknown as ChartHandle;
}

function mount(handle: ChartHandle) {
  return renderHook(() =>
    useReplay(handle, {
      epic: EPIC,
      resolution: "MINUTE",
      priceSide: "mid",
      brokerId: "capital",
      scope: SCOPE,
    }),
  );
}

beforeEach(() => {
  localStorage.removeItem(REPLAY_KEY);
  fetchRangeWithStatus.mockImplementation(
    async (_epic: string, _res: string, fromSec: number, toSec: number) => ({
      bars: UNIVERSE.filter(
        (b) => b.timestamp >= fromSec * 1000 && b.timestamp <= toSec * 1000,
      ),
      degraded: null,
    }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a closure gap wider than the forward buffer", () => {
  it("does not end the session and the next steps cross the gap", async () => {
    seedSession();
    const handle = fakeHandle();
    const { result } = mount(handle);
    await act(async () => {
      await handle.replayRef.current!.barsFor("MINUTE");
    });

    // Step into the closure and keep stepping; the refill's probe loop should
    // load the far side so the cursor comes out at the first post-gap bars.
    for (let i = 0; i < 20 && result.current.state.cursorMs < GAP_END; i++) {
      await act(async () => result.current.stepForward());
    }

    expect(result.current.state.atEnd).toBe(false);
    expect(result.current.state.cursorMs).toBeGreaterThanOrEqual(GAP_END);
  });

  it("still reports the true end when no bars exist through the live edge", async () => {
    // Same session, but the universe ends at the closure: probes run to `now`
    // and find nothing, which IS "caught up".
    fetchRangeWithStatus.mockImplementation(
      async (_epic: string, _res: string, fromSec: number, toSec: number) => ({
        bars: UNIVERSE.filter(
          (b) =>
            b.timestamp >= fromSec * 1000 &&
            b.timestamp <= toSec * 1000 &&
            b.timestamp < GAP_START,
        ),
        degraded: null,
      }),
    );
    seedSession();
    const handle = fakeHandle();
    const { result } = mount(handle);
    await act(async () => {
      await handle.replayRef.current!.barsFor("MINUTE");
    });

    for (let i = 0; i < 6; i++) {
      await act(async () => result.current.stepForward());
    }

    expect(result.current.state.atEnd).toBe(true);
    expect(result.current.state.cursorMs).toBeLessThan(GAP_START);
  });
});
