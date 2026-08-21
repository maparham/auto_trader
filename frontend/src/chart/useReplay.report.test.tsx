// @vitest-environment jsdom
//
// The exit reveal, and the two guarantees that hang off it.
//
// 1. The report card is a ONE-WAY DOOR. It goes up while the session is still
//    `active`, which is the only way its stats can be the session's — but by
//    then the user has been shown the real dates of bars they traded blind. Any
//    control that survives the card (a Play, a step, a fill) is hindsight, and a
//    gate that lives in the pill rather than the hook is one the playback timer
//    walks straight past. So this drives the HOOK's own callbacks.
// 2. "Pick new start" goes through the card too, and what comes out the other
//    side has to be a genuinely FRESH blind session: no ledger, no cursor, no
//    anchor, no mask and no persisted record carried over from the one just
//    ended. Asserting on `mode === "picking"` alone would miss every one of
//    those; this asserts on the state itself.
//
// The harness is the resumed-session one from useReplay.trading.test.tsx: a
// persisted record needs no fetch, no chart and no clock to become a live
// session, and the bar store is filled through the single seam (barsFor) the
// load effect uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { ReplayLedgerState } from "../lib/replayLedger";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { TradeView } from "../lib/trading";

installMemStorage();

// Exiting hands the trade layer back to the account, which fires the global
// trades fetch. Nothing here has a backend; stub the one function rather than
// the module, so the rest of lib/trading (TradeView, the toTradeViews path) is
// the real thing.
// The reveal an untraded blind session gets INSTEAD of the card.
vi.mock("../lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/notify")>()),
  toast: vi.fn(),
}));

vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades: vi.fn(),
}));

const { useReplay } = await import("./useReplay");
const { toast } = await import("../lib/notify");

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);

const BARS = vi.hoisted(() =>
  Array.from({ length: 10 }, (_, i) => ({
    timestamp: Date.UTC(2021, 4, 17, 9, 0) + i * 60_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    volume: 1,
  })),
);

vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feed")>()),
  fetchRangeWithStatus: vi.fn(async () => ({ bars: BARS, degraded: null })),
}));

const CURSOR = BASE + 6 * MIN; // bars 0..5 revealed, mark 105

/** One winner and one loser closed, plus a position still open. */
const TRADED: ReplayLedgerState = {
  orders: [],
  positions: [
    { id: "rp9", side: "buy", quantity: 1, entry: 104, stop: null, takeProfit: null, openedMs: CURSOR },
  ],
  closed: [
    { side: "buy", quantity: 1, entry: 100, exit: 103, pnl: 3, entryMs: BASE, exitMs: BASE + 3 * MIN, reason: "manual" },
    { side: "sell", quantity: 1, entry: 102, exit: 104, pnl: -2, entryMs: BASE + 3 * MIN, exitMs: BASE + 5 * MIN, reason: "stop" },
  ],
  seq: 3,
};

const SCOPE = "tab1.cellReport";
const EPIC = "US100";
const REPLAY_KEY = "auto-trader.replaySessions";

function seedSession(over: Partial<ReplaySessionRecord>): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "1m",
    startMs: BASE,
    cursorMs: CURSOR,
    highWaterMs: CURSOR,
    masked: false,
    showStrategy: false,
    ledger: null,
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

async function mountWithStore(handle: ChartHandle) {
  const rendered = renderHook(() =>
    useReplay(handle, {
      epic: EPIC,
      resolution: "1m",
      priceSide: "mid",
      brokerId: "capital",
      scope: SCOPE,
      formatReal: (ms: number) => `T${ms}`,
    }),
  );
  await act(async () => {
    await handle.replayRef.current!.barsFor("1m");
  });
  return rendered;
}

beforeEach(() => {
  localStorage.removeItem(REPLAY_KEY);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("useReplay exit reveal", () => {
  it("exits straight away when there is nothing to reveal", async () => {
    // No trades, no open positions, no mask: no book to report on and no hidden
    // dates to unhide, so a card would be a click for its own sake.
    seedSession({ masked: false, ledger: null });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());

    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("off");
    expect(savedRecord()).toBeUndefined();
  });

  it("opens the card for a session that traded", async () => {
    seedSession({ masked: false, ledger: TRADED });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());

    // Still active underneath: that is what lets the gates below bite.
    expect(result.current.state.mode).toBe("active");
    expect(result.current.pendingReport).toEqual({
      summary: { trades: 2, wins: 1, winRate: 0.5, netPnl: 1, openPositions: 1 },
      startMs: BASE,
      cursorMs: CURSOR,
      masked: false,
    });
  });

  it("reveals an untraded MASKED session in a toast, not a card", async () => {
    // The dates are still owed (the picker promised them on exit), but a dialog
    // reporting an empty book is a click for its own sake. The reveal goes out
    // as a toast and the session tears down in the same gesture.
    seedSession({ masked: true, ledger: null });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());

    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("off");
    expect(toast).toHaveBeenCalledWith(`Replay was T${BASE} to T${CURSOR}`);
  });

  it("names one instant, not a range, for a session that never stepped", async () => {
    seedSession({ masked: true, ledger: null, cursorMs: BASE, highWaterMs: BASE });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());

    expect(toast).toHaveBeenCalledWith(`Replay was T${BASE}`);
  });

  it("says nothing extra when an untraded UNMASKED session ends", async () => {
    // Nothing was hidden, so there is nothing to reveal either.
    seedSession({ masked: false, ledger: null });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());

    expect(toast).not.toHaveBeenCalled();
  });

  it("drops the persisted record as soon as the card opens", async () => {
    // A tab closed while the reveal is on screen must not resurrect a masked
    // session whose real dates the user has already been shown.
    seedSession({ masked: true, ledger: TRADED });
    const { result } = await mountWithStore(fakeHandle());
    expect(savedRecord()).toBeDefined();

    act(() => result.current.requestExit());

    expect(savedRecord()).toBeUndefined();
  });

  it("dismissReport performs the real exit", async () => {
    seedSession({ masked: true, ledger: TRADED });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());
    act(() => result.current.dismissReport());

    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("off");
    expect(result.current.ledger.closed).toHaveLength(0);
    expect(result.current.ledger.positions).toHaveLength(0);
    expect(savedRecord()).toBeUndefined();
  });
});

describe("useReplay report card is a one-way door", () => {
  it("refuses to step, play or trade while the report is pending", async () => {
    seedSession({ masked: true, ledger: TRADED });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestExit());
    expect(result.current.state.playing).toBe(false);

    // Stepping FORWARD is the one that reveals another bar the user is no longer
    // blind to; assert the cursor itself did not move, not merely that nothing threw.
    act(() => result.current.stepForward());
    expect(result.current.state.cursorMs).toBe(CURSOR);
    expect(result.current.state.highWaterMs).toBe(CURSOR);

    // Stepping BACK repaints the series out from under the card's own numbers.
    act(() => result.current.stepBack());
    expect(result.current.state.cursorMs).toBe(CURSOR);

    // Play would be a way back INTO the session, not merely a no-op step.
    act(() => result.current.togglePlay());
    expect(result.current.state.playing).toBe(false);

    // And no fill may be booked after the reveal.
    expect(result.current.canTrade).toBe(false);
    act(() =>
      result.current.place({
        side: "buy",
        quantity: 1,
        type: "market",
        price: null,
        stop: null,
        takeProfit: null,
      }),
    );
    act(() => result.current.closeTrade("rp9"));
    expect(result.current.ledger.positions.map((p) => p.id)).toEqual(["rp9"]);
    expect(result.current.ledger.closed).toHaveLength(2);

    // The card is still the only way out: none of the above dismissed it.
    expect(result.current.pendingReport).not.toBeNull();
    expect(result.current.state.mode).toBe("active");
  });

  it("keeps the playback timer from running the session on behind the card", async () => {
    // `requestExit` setting `playing: false` is not on its own enough to pin
    // this: a Play pressed AFTER the card is up is what would restart the
    // interval, and an interval that restarts steps bars the user is no longer
    // blind to, ten times a second, with no visible control to stop it.
    vi.useFakeTimers();
    try {
      seedSession({ masked: true, ledger: TRADED });
      const { result } = await mountWithStore(fakeHandle());

      // Playing when the user hits ✕: the card must stop the interval it finds.
      act(() => result.current.togglePlay());
      expect(result.current.state.playing).toBe(true);
      act(() => result.current.requestExit());
      expect(result.current.state.playing).toBe(false);

      // ...and Play must not be able to start it again from behind the card.
      act(() => result.current.togglePlay());
      act(() => void vi.advanceTimersByTime(5000));
      expect(result.current.state.playing).toBe(false);
      expect(result.current.state.cursorMs).toBe(CURSOR);
      expect(result.current.state.mode).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useReplay pick-new-start through the card", () => {
  it("lands in picking with nothing inherited from the session just ended", async () => {
    seedSession({ masked: true, startMs: BASE, ledger: TRADED });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestNewStart());
    // The reveal is owed on this path too: the user has seen the real dates, so
    // the next session cannot be a continuation of this one.
    expect(result.current.pendingReport).toMatchObject({ masked: true, startMs: BASE });

    act(() => result.current.dismissReport());

    expect(result.current.state.mode).toBe("picking");
    expect(result.current.pendingReport).toBeNull();
    // The anchor a masked session formats "Day N" against, the cursor, the
    // high-water gate and the mask flag: all reset, so the next startAt arms its
    // own. A leftover startMs would date the NEXT session's axis from the LAST
    // one's anchor.
    expect(result.current.state.startMs).toBe(0);
    expect(result.current.state.cursorMs).toBe(0);
    expect(result.current.state.highWaterMs).toBe(0);
    expect(result.current.state.masked).toBe(false);
    // The book dies with the session (state AND the ref the callbacks read).
    expect(result.current.ledger.closed).toHaveLength(0);
    expect(result.current.ledger.positions).toHaveLength(0);
    expect(result.current.ledger.orders).toHaveLength(0);
    // And nothing is left on disk for a reload to resume.
    expect(savedRecord()).toBeUndefined();
  });

  it("takes the card down with the session when the symbol changes under it", async () => {
    // The symbol-change guard calls `exit` OUTRIGHT — it cannot wait on a card,
    // since the user has already navigated away. So the card has to go with it,
    // or it floats over a live chart describing a session that no longer exists.
    seedSession({ masked: true, ledger: TRADED });
    const handle = fakeHandle();
    const { result, rerender } = renderHook(
      ({ epic }: { epic: string }) =>
        useReplay(handle, { epic, resolution: "1m", priceSide: "mid", brokerId: "capital", scope: SCOPE }),
      { initialProps: { epic: EPIC } },
    );
    await act(async () => {
      await handle.replayRef.current!.barsFor("1m");
    });

    act(() => result.current.requestExit());
    expect(result.current.pendingReport).not.toBeNull();

    rerender({ epic: "DE40" });

    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("off");
  });

  it("skips the card and goes straight to picking when there is nothing to reveal", async () => {
    seedSession({ masked: false, ledger: null });
    const { result } = await mountWithStore(fakeHandle());

    act(() => result.current.requestNewStart());

    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("picking");
  });
});
