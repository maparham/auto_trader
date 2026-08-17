// @vitest-environment jsdom
//
// The high-water trading gate, exercised through the real hook rather than the
// pure ledger seam underneath it. The bug this file exists for was NOT in
// lib/replayLedger (canPlaceAt and closeAt are both correct and unit-tested):
// it was an action in useReplay that simply never asked. Only a test that drives
// the hook's own callbacks can catch that, so the harness resumes a REWOUND
// session out of persisted state — which needs no fetch, no chart and no clock —
// and then loads a bar store through the one seam that fills it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { ReplayLedgerState } from "../lib/replayLedger";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { TradeView } from "../lib/trading";

// jsdom's own localStorage is an inert stub in this suite (no getItem, no
// clear), and the resumed-session harness below is built entirely out of the
// persisted record — so install the same in-memory stand-in the other
// storage-backed tests use, before the hook module is pulled in.
installMemStorage();

const { useReplay } = await import("./useReplay");

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);

// Ten 1m bars, close = 100 + i. barCloseMs is the NEXT bar's timestamp, so the
// cursor "BASE + n*MIN" reveals bars 0..n-1 and marks at close 100 + (n - 1).
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

const HIGH_WATER = BASE + 6 * MIN; // bars 0..5 revealed, mark 105
const REWOUND = BASE + 3 * MIN; //    bars 0..2 revealed, mark 102

// One open long, bought at the high-water bar. Closing it at the rewound cursor
// would book an exit at 102 against an entry of 105 — a price the user has
// already watched print, which is the whole loophole.
const OPEN_LONG: ReplayLedgerState = {
  orders: [],
  positions: [
    {
      id: "rp1",
      side: "buy",
      quantity: 1,
      entry: 105,
      stop: null,
      takeProfit: null,
      openedMs: HIGH_WATER,
    },
  ],
  closed: [],
  seq: 1,
};

const RESTING_ORDER: ReplayLedgerState = {
  orders: [
    {
      id: "ro1",
      side: "buy",
      quantity: 1,
      limit: 90,
      stop: null,
      takeProfit: null,
      placedMs: HIGH_WATER,
    },
  ],
  positions: [],
  closed: [],
  seq: 1,
};

const SCOPE = "tab1.cellA";
const EPIC = "US100";
// The one key lib/replaySession keeps every scope's record under. Addressed
// directly (rather than through localStorage.clear) because the node-env
// storage stand-in this suite runs against does not implement clear().
const REPLAY_KEY = "auto-trader.replaySessions";

function seedSession(over: Partial<ReplaySessionRecord>): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "1m",
    startMs: BASE,
    cursorMs: HIGH_WATER,
    highWaterMs: HIGH_WATER,
    masked: false,
    showStrategy: false,
    ledger: null,
    savedAt: Date.now(),
    ...over,
  };
  localStorage.setItem(REPLAY_KEY, JSON.stringify({ [SCOPE]: rec }));
}

// Only the handful of handle members useReplay actually touches. chartRef and
// dataFacadeRef stay null on purpose: that short-circuits applySlice and both
// MTF effects, leaving the ledger path as the only thing under test.
function fakeHandle(): { handle: ChartHandle; trades: { current: TradeView[] } } {
  const trades = { current: [] as TradeView[] };
  const handle = {
    chartRef: { current: null },
    dataFacadeRef: { current: null },
    tradesRef: trades,
    posDrawRef: { current: () => {} },
    redrawRef: { current: () => {} },
    replayRef: { current: null },
  } as unknown as ChartHandle;
  return { handle, trades };
}

/** Mount a resumed session and fill its bar store, the way the load effect does. */
async function mountWithStore(handle: ChartHandle) {
  const rendered = renderHook(() =>
    useReplay(handle, {
      epic: EPIC,
      resolution: "1m",
      priceSide: "mid",
      brokerId: "capital",
      scope: SCOPE,
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

describe("useReplay high-water trading gate", () => {
  it("refuses to close a position while the cursor is rewound", async () => {
    seedSession({ cursorMs: REWOUND, highWaterMs: HIGH_WATER, ledger: OPEN_LONG });
    const { handle, trades } = fakeHandle();
    const { result } = await mountWithStore(handle);

    expect(result.current.canTrade).toBe(false); // the ticket's buttons are off
    act(() => result.current.closeTrade("rp1"));

    // Untouched: the position is still open and nothing was booked at 102.
    expect(result.current.ledger.positions).toHaveLength(1);
    expect(result.current.ledger.closed).toHaveLength(0);
    expect(trades.current.map((t) => t.id)).toEqual(["rp1"]);
  });

  it("closes at the cursor bar's close once the cursor is back at the high-water mark", async () => {
    seedSession({ cursorMs: HIGH_WATER, highWaterMs: HIGH_WATER, ledger: OPEN_LONG });
    const { handle } = fakeHandle();
    const { result } = await mountWithStore(handle);

    expect(result.current.canTrade).toBe(true);
    act(() => result.current.closeTrade("rp1"));

    expect(result.current.ledger.positions).toHaveLength(0);
    expect(result.current.ledger.closed).toHaveLength(1);
    const [closed] = result.current.ledger.closed;
    expect(closed.exit).toBe(105); // bar 5's close, not the rewound 102
    expect(closed.exitMs).toBe(HIGH_WATER); // exit times stay monotonic
    expect(closed.reason).toBe("manual");
  });

  it("refuses to open a position while the cursor is rewound", async () => {
    seedSession({ cursorMs: REWOUND, highWaterMs: HIGH_WATER, ledger: null });
    const { handle } = fakeHandle();
    const { result } = await mountWithStore(handle);

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
    expect(result.current.ledger.positions).toHaveLength(0);
  });

  it("still cancels a resting order while rewound (deliberately ungated)", async () => {
    // Cancelling transacts no price, so hindsight buys the user nothing, and a
    // rewind that stranded an order the user wants gone would be worse. Pinned
    // by a test so it reads as a decision rather than an oversight.
    seedSession({ cursorMs: REWOUND, highWaterMs: HIGH_WATER, ledger: RESTING_ORDER });
    const { handle } = fakeHandle();
    const { result } = await mountWithStore(handle);

    expect(result.current.canTrade).toBe(false);
    act(() => result.current.cancel("ro1"));
    expect(result.current.ledger.orders).toHaveLength(0);
  });
});
