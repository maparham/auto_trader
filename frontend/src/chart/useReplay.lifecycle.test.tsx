// @vitest-environment jsdom
//
// Two failures a browser pass found that no unit test could see, both about
// TIMING rather than logic:
//
//  - A load that outlives its session. The symbol-change guard is the only path
//    that flips `mode` from inside an effect, so for one flush the load effect
//    for the NEW epic is still running against the OLD session. A `barsFor` that
//    lands after `endSession` publishes an EMPTIED ledger into the shared trade
//    layer, on top of the real positions endSession had just restored — and the
//    user's own open trades lose their lines until the next trade event.
//
//  - A session never persisted during playback. The save is a 400ms trailing
//    debounce whose effect re-runs on every step, so at 5x (200ms) and 10x
//    (100ms) the timer is re-armed before it can fire and NOTHING is written for
//    the whole run.
//
// Harness: the resumed-session one from useReplay.trading.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { ReplayLedgerState } from "../lib/replayLedger";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { TradeView } from "../lib/trading";

installMemStorage();

const refreshTrades = vi.hoisted(() => vi.fn());
vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades,
}));

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);

const BARS = vi.hoisted(() =>
  Array.from({ length: 40 }, (_, i) => ({
    timestamp: Date.UTC(2021, 4, 17, 9, 0) + i * 60_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    volume: 1,
  })),
);

// A fetch we can hold open, so a read really is in flight across a teardown.
let gate: { promise: Promise<void>; release: () => void } | null = null;
const fetchRangeWithStatus = vi.hoisted(() => vi.fn());
vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feed")>()),
  fetchRangeWithStatus,
}));

const { useReplay } = await import("./useReplay");

const SCOPE = "tab1.cellLifecycle";
const EPIC = "US100";
const REPLAY_KEY = "auto-trader.replaySessions";
const CURSOR = BASE + 6 * MIN;

const LEDGER: ReplayLedgerState = {
  orders: [],
  positions: [
    { id: "rp1", side: "buy", quantity: 1, entry: 101, stop: null, takeProfit: null, openedMs: BASE + 2 * MIN },
  ],
  closed: [],
  seq: 2,
};

function seedSession(over: Partial<ReplaySessionRecord> = {}): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "MINUTE",
    startMs: BASE,
    cursorMs: CURSOR,
    highWaterMs: CURSOR,
    masked: true,
    showStrategy: false,
    ledger: LEDGER,
    savedAt: Date.now(),
    ...over,
  };
  localStorage.setItem(REPLAY_KEY, JSON.stringify({ [SCOPE]: rec }));
}

const savedRecord = (): ReplaySessionRecord | undefined =>
  JSON.parse(localStorage.getItem(REPLAY_KEY) || "{}")[SCOPE];

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
  gate = null;
  fetchRangeWithStatus.mockImplementation(async () => {
    if (gate) await gate.promise;
    return { bars: BARS, degraded: null };
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("a series load that outlives its session", () => {
  it("does not publish an emptied ledger over the restored real positions", async () => {
    seedSession();
    const handle = fakeHandle();
    const { result } = mount(handle);

    // The ORDER is the whole point, and it is the order the browser hits. The
    // epic-guard effect runs FIRST and calls exit(), which bumps reqSeq to N.
    // The load effect for the NEW epic runs in the same flush and still reads
    // `mode === "active"` off `latest` (assigned during render, so exit's
    // setState has not landed there yet), so it calls barsFor AFTERWARDS — which
    // takes seq N+1. Nothing bumps after that, so the seq guard passes and the
    // call runs to completion against a session that no longer exists.
    await act(async () => result.current.exit());
    expect(result.current.state.mode).toBe("off");
    expect(refreshTrades).toHaveBeenCalled();
    // endSession handed the layer back to the account. Stand in for the refill
    // the real trades feed performs, so a later overwrite is visible.
    handle.tradesRef.current = [{ id: "real-1" } as unknown as TradeView];

    let release!: () => void;
    gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = handle.replayRef.current!.barsFor("MINUTE");
    });
    await act(async () => {
      gate!.release();
      await pending;
    });

    // The late read must not have written the emptied book over it.
    expect(handle.tradesRef.current).toHaveLength(1);
    expect(handle.tradesRef.current[0].id).toBe("real-1");
  });

});

describe("persisting the session during playback", () => {
  // 400ms is the debounce; a 10x step is 100ms. The effect re-runs on every step
  // (cursorMs AND a fresh ledger object), and its cleanup clears the timer.
  it("writes at least once during a fast run, not only after it stops", async () => {
    vi.useFakeTimers();
    seedSession();
    const handle = fakeHandle();
    const { result } = mount(handle);
    await act(async () => {
      await handle.replayRef.current!.barsFor("MINUTE");
    });
    // Let the initial write land, then clear the record so only writes made
    // DURING the run can bring it back.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    localStorage.removeItem(REPLAY_KEY);
    expect(savedRecord()).toBeUndefined();

    // Twenty steps at 10x: 100ms of replay clock between each, never a 400ms gap.
    const startCursor = result.current.state.cursorMs;
    for (let i = 0; i < 20; i++) {
      await act(async () => result.current.stepForward());
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(result.current.state.cursorMs).toBeGreaterThan(startCursor);

    // Reload/close the tab HERE, mid-run, with no idle gap afterwards.
    const rec = savedRecord();
    expect(rec).toBeDefined();
    expect(rec!.cursorMs).toBeGreaterThan(startCursor);
  });

  it("still coalesces a burst rather than writing per step", async () => {
    vi.useFakeTimers();
    seedSession();
    const handle = fakeHandle();
    const { result } = mount(handle);
    await act(async () => {
      await handle.replayRef.current!.barsFor("MINUTE");
    });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    // Count DISTINCT writes by watching `savedAt`, rather than spying on
    // setItem: installMemStorage swaps localStorage for a plain object, so
    // Storage.prototype is never touched and a prototype spy sees nothing.
    const stamps = new Set<number>();
    const sample = () => {
      const at = savedRecord()?.savedAt;
      if (at != null) stamps.add(at);
    };
    // Ten steps 20ms apart: well inside one 400ms debounce window, and the whole
    // burst is inside the 1000ms ceiling.
    for (let i = 0; i < 10; i++) {
      await act(async () => result.current.stepForward());
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      sample();
    }
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    sample();
    // The burst coalesced: far fewer writes than steps. The ceiling bounds
    // staleness, it does not turn the debounce off.
    expect(stamps.size).toBeGreaterThan(0);
    expect(stamps.size).toBeLessThan(10);
  });
});
