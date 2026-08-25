// @vitest-environment jsdom
//
// The progressive strategy reveal, driven through the HOOK rather than the pure
// filter (lib/replayReveal.test.ts covers that). Three things can only be proven
// here:
//
// 1. RESTORE. `showStrategy` is persisted on the session record, so a reload must
//    come back with the toggle where the user left it AND with the slice redrawn
//    at the restored cursor — not merely with a button in the right state over a
//    chart showing nothing (or, worse, the whole run).
// 2. TEARDOWN. Every way out of a session — the report card's Done, the pill's ⟲,
//    the symbol-change exit — has to leave the cell showing its own real saved
//    backtest. A session ended with the toggle still ON would otherwise strand a
//    truncated trade list and a partial P&L presented as the real result.
// 3. The reveal never publishes anything the cursor has not reached, and the
//    published slice GROWS with the cursor and never shrinks.
//
// The harness is the resumed-session one from useReplay.report.test.tsx (a
// persisted record needs no fetch or clock to become a live session, and the bar
// store is filled through the single seam the load effect uses), plus a chart
// stub and a mocked lib/backtest so the draw calls are observable without
// klinecharts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { StoredBacktestResult } from "../lib/persist";
import type { TradeView } from "../lib/trading";

installMemStorage();

vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades: vi.fn(),
}));

// The draw-side functions the reveal drives. Mocked rather than stubbed on a
// real chart: renderArtifacts wants a live klinecharts instance, and what this
// file is asserting is WHICH result reaches the chart and HOW OFTEN, not how it
// is painted. (lib/backtestShownResult.test.ts drives the real ones.)
//
// teardownArtifacts' mock reproduces the ONE behaviour under test here: the real
// one nulls the shared selection signals, which is why doing a full redraw on
// every cursor step would drop a trade the user clicked to study.
// `updateShownResult` is mocked too, and its RETURN is the contract that matters:
// the real one refuses (false) whenever this chart no longer backs the panel, and
// the reveal must then fall through to a full render instead of believing its
// signature. Default true here = "this chart still owns the panel", which is the
// case the per-step dedup assertions are about; `updateShownResult.mockReturnValue
// (false)` models the ownership having been taken away.
const renderArtifacts = vi.hoisted(() => vi.fn());
const teardownArtifacts = vi.hoisted(() => vi.fn());
const rehydrateBacktest = vi.hoisted(() => vi.fn());
const updateShownResult = vi.hoisted(() => vi.fn(() => true));
// Ditto: with renderArtifacts mocked, nothing ever populates the real artifact
// registry, so the real ownsBacktestPanel would answer false for a chart this
// file is pretending has just drawn. Default true = "this chart owns the panel".
const ownsBacktestPanel = vi.hoisted(() => vi.fn(() => true));
vi.mock("../lib/backtest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backtest")>()),
  renderArtifacts,
  teardownArtifacts,
  rehydrateBacktest,
  updateShownResult,
  ownsBacktestPanel,
}));

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);

const BARS = vi.hoisted(() =>
  Array.from({ length: 20 }, (_, i) => ({
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
  fetchRangeWithStatus: vi.fn(async () => ({ bars: BARS, degraded: null, partial: null })),
}));

const { useReplay } = await import("./useReplay");
const { backtestResultSignal, selectedTradeSignal, highlightTradeSignal } = await import(
  "../lib/signals"
);
teardownArtifacts.mockImplementation(() => {
  selectedTradeSignal.set(null);
  highlightTradeSignal.set(null);
});

// --- frame control ----------------------------------------------------------
//
// The reveal defers its draw to a frame, and two of its guards exist only for
// what can happen BETWEEN the schedule and the fire. Most tests want the frame
// inline (a step and its repaint in one act()); the two that pin those guards
// need it left PENDING so a teardown or a load can land in the gap.
interface PendingFrame {
  cb: FrameRequestCallback;
  cancelled: boolean;
}
let frames: PendingFrame[] = [];
let autoRunFrames = true;
// When false, cancelAnimationFrame does NOT drop the frame — the browser race
// this models: the callback has already been dequeued and is about to run when
// the cancel arrives. It is the only way to reach a late-firing frame.
let cancelWins = true;

function flushFrames(): void {
  const due = frames.filter((f) => !f.cancelled);
  frames = [];
  for (const f of due) f.cb(0);
}

const CURSOR = BASE + 6 * MIN; // bars 0..5 revealed
const SCOPE = "tab1.cellReveal";
const EPIC = "US100";
const REPLAY_KEY = "auto-trader.replaySessions";
const BACKTEST_KEY = `auto-trader.${SCOPE}.backtest.${EPIC}`;

const S = (ms: number) => Math.floor(ms / 1000);

// Fills at minute 2, 4, 9 and 12 of the loaded bars: two inside the resumed
// cursor's revealed window, two beyond it.
const SAVED = {
  epic: EPIC,
  // A REAL RESOLUTION_SECONDS key (60s, matching the 1-minute bars below). Not
  // "1m": that is not a key, so it would silently exercise revealBarMs' unknown
  // fallback and this file would stop noticing if the width lookup broke.
  resolution: "MINUTE",
  markers: [
    { time: S(BASE + 2 * MIN), side: "buy", price: 102, reason: "entry", leg: "long" },
    { time: S(BASE + 4 * MIN), side: "sell", price: 104, reason: "target", leg: "long" },
    { time: S(BASE + 9 * MIN), side: "buy", price: 109, reason: "entry", leg: "long" },
    { time: S(BASE + 12 * MIN), side: "sell", price: 112, reason: "target", leg: "long" },
  ],
  // The fields beyond the times are what the OPEN trade's position lines are
  // built from (leg/quantity/entry price and the initial bracket); the slice
  // itself reads only the times and the P&L.
  trades: [
    { entry_time: S(BASE + 2 * MIN), exit_time: S(BASE + 4 * MIN), pnl: 2,
      leg: "long", quantity: 1, entry_price: 102, stop_initial: 100, stop_final: 103, target: 106 },
    { entry_time: S(BASE + 9 * MIN), exit_time: S(BASE + 12 * MIN), pnl: 3,
      leg: "long", quantity: 2, entry_price: 109, stop_initial: 107, stop_final: 111, target: 113 },
  ],
  equity: Array.from({ length: 20 }, (_, i) => ({ time: S(BASE + i * MIN), value: 1000 + i })),
  summary: { net_pnl: 5, n_trades: 2, win_rate: 1, max_drawdown: 0 },
  metrics: { profit_factor: null, expectancy: 2.5 },
  period: { fromMs: BASE, toMs: BASE + 19 * MIN },
} as unknown as StoredBacktestResult;

function seedSession(over: Partial<ReplaySessionRecord>): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "1m",
    startMs: BASE,
    cursorMs: CURSOR,
    highWaterMs: CURSOR,
    masked: true,
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
    // getDataList is the reveal's "is anything painted yet?" probe; the bars
    // themselves are never read by the mocked draw path. getIndicators is for
    // the MTF-refresh effect, which shares this chart and asks what is pinned.
    chartRef: { current: { getDataList: () => BARS, getIndicators: () => [] } },
    dataFacadeRef: { current: null },
    tradesRef: { current: [] as TradeView[] },
    posDrawRef: { current: () => {} },
    redrawRef: { current: () => {} },
    replayRef: { current: null },
  } as unknown as ChartHandle;
}

function mount(handle: ChartHandle, epic = EPIC) {
  return renderHook(
    ({ e }: { e: string }) =>
      useReplay(handle, {
        epic: e,
        resolution: "1m",
        priceSide: "mid",
        brokerId: "capital",
        scope: SCOPE,
      }),
    { initialProps: { e: epic } },
  );
}

/** Mount a resumed session and fill its bar store through the load effect's seam. */
async function mountWithStore(handle: ChartHandle) {
  const rendered = mount(handle);
  await act(async () => {
    await handle.replayRef.current!.barsFor("1m");
  });
  return rendered;
}

/** The result the last reveal drew (renderArtifacts and the signal agree by
 * construction — the hook publishes the object it rendered). */
const drawn = (): StoredBacktestResult => renderArtifacts.mock.calls.at(-1)![1];

beforeEach(() => {
  localStorage.removeItem(REPLAY_KEY);
  localStorage.setItem(BACKTEST_KEY, JSON.stringify(SAVED));
  backtestResultSignal.set(null);
  selectedTradeSignal.set(null);
  highlightTradeSignal.set(null);
  frames = [];
  autoRunFrames = true;
  cancelWins = true;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    if (autoRunFrames) {
      cb(0);
      return 0;
    }
    frames.push({ cb, cancelled: false });
    return frames.length; // 1-based, so the id doubles as an index+1
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    const f = frames[id - 1];
    if (f && cancelWins) f.cancelled = true;
  });
});
afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks drops implementations, so restore both defaults.
  updateShownResult.mockReturnValue(true);
  ownsBacktestPanel.mockReturnValue(true);
  vi.unstubAllGlobals();
  localStorage.removeItem(BACKTEST_KEY);
});

describe("the reveal at the cursor", () => {
  it("draws nothing until the toggle is on", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    expect(result.current.showStrategy).toBe(false);
    expect(renderArtifacts).not.toHaveBeenCalled();
    expect(backtestResultSignal.value).toBeNull();
  });

  it("publishes only the fills the cursor has passed", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    // Cursor at BASE+6m: the minute-2 and minute-4 fills have printed; the
    // minute-9 and minute-12 ones have not.
    expect(drawn().markers).toHaveLength(2);
    expect(drawn().trades).toHaveLength(1);
    expect(drawn().summary.net_pnl).toBe(2); // NOT the run's 5
    expect(backtestResultSignal.value).toBe(drawn());
  });

  it("never publishes the run's whole-run fields", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    // `period` in particular: BacktestPanel prints it as a real calendar range,
    // straight through the mask this session is running under.
    expect(drawn().period).toBeUndefined();
    expect(drawn().by_leg).toBeUndefined();
  });

  it("grows the slice as the cursor steps forward and never shrinks it", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    let prev = drawn().markers.length;
    const seen: number[] = [prev];
    for (let i = 0; i < 8; i++) {
      await act(async () => result.current.stepForward());
      const now = drawn().markers.length;
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
      seen.push(now);
      // ASSERTED PER STEP, not once at the end. Checking only the final cursor
      // is what let this file pass against the `time <= cursor` predicate that
      // reveals a fill one bar early: by the last step everything has legitimately
      // printed, so the leak has nowhere left to show.
      const cursorMs = result.current.state.cursorMs;
      for (const m of drawn().markers) {
        expect(m.time * 1000 + MIN).toBeLessThanOrEqual(cursorMs);
      }
      for (const t of drawn().trades) {
        expect(t.exit_time * 1000 + MIN).toBeLessThanOrEqual(cursorMs);
      }
      for (const p of drawn().equity) {
        expect(p.time * 1000 + MIN).toBeLessThanOrEqual(cursorMs);
      }
    }
    // The minute-9 marker is five bars past the resumed cursor: absent at the
    // start, present by the time the cursor reaches it.
    expect(seen[0]).toBe(2);
    expect(prev).toBeGreaterThanOrEqual(3);
  });

  // --- the redraw is SPLIT: overlays vs the curve ---------------------------
  //
  // The equity series grows by a point on every bar, so anything keyed on it
  // fires every step. A full teardown + render there rebuilds every marker
  // overlay ten times a second at 10x, and teardownArtifacts nulls the shared
  // selection — so a trade row the user clicked to study vanishes within a tenth
  // of a second, permanently, in the exact mode where they are watching it play
  // out. Only the OVERLAY-bearing parts may trigger a full render.
  describe("stepping without a new fill", () => {
    it("does not rebuild the overlays on every step", async () => {
      seedSession({});
      const handle = fakeHandle();
      const { result } = await mountWithStore(handle);
      await act(async () => result.current.toggleStrategy());
      expect(renderArtifacts).toHaveBeenCalledTimes(1);

      // Cursor 6m -> 14m. Only two steps reveal anything new: the minute-9
      // marker (at cursor 10m) and the minute-12 marker + trade (at 13m).
      for (let i = 0; i < 8; i++) {
        await act(async () => result.current.stepForward());
      }
      expect(result.current.state.cursorMs).toBe(BASE + 14 * MIN);
      expect(renderArtifacts).toHaveBeenCalledTimes(3); // 1 toggle + 2 fills
      expect(teardownArtifacts).toHaveBeenCalledTimes(3);
    });

    it("keeps the user's selected trade across the steps in between", async () => {
      seedSession({});
      const handle = fakeHandle();
      const { result } = await mountWithStore(handle);
      await act(async () => result.current.toggleStrategy());
      // The user clicks a revealed trade to study it.
      selectedTradeSignal.set(0);
      // Two steps that reveal nothing (cursor 6m -> 8m, next fill lands at 10m).
      await act(async () => result.current.stepForward());
      await act(async () => result.current.stepForward());
      expect(selectedTradeSignal.value).toBe(0);
    });
  });

  it("takes the slice DOWN on toggle-off, and never paints the run behind it", async () => {
    // Toggling off used to rehydrate the cell's saved backtest — the whole run,
    // every marker including the ones in the session's own future, on a blind
    // chart, one click from the user. While the session is LIVE the toggle must
    // only clear.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    await act(async () => result.current.toggleStrategy());
    expect(result.current.state.mode).toBe("active"); // session still running
    expect(rehydrateBacktest).not.toHaveBeenCalled();
    expect(teardownArtifacts).toHaveBeenCalled();
    expect(backtestResultSignal.value).toBeNull();
  });

  it("redraws after a toggle off and back on at the same cursor", async () => {
    // The dedup signature is what makes 10x playback affordable, and it is also
    // what would silently strand a stale reveal: toggling back on at the same
    // cursor must not match the signature the last reveal recorded and skip the
    // redraw.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);
    await act(async () => result.current.toggleStrategy());
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(2);
    expect(drawn().markers).toHaveLength(2);
  });

  it("falls through to a full render when the in-place update is refused", async () => {
    // updateShownResult returns false whenever this chart no longer backs the
    // panel — routine, because the load effect clears the panel underneath the
    // reveal on every replayEpoch bump. Discarding that `false` is what made the
    // feature inoperative in the browser: the reveal believed its signature was
    // still on screen when nothing was, and never drew again all session.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    updateShownResult.mockReturnValue(false); // the panel was taken away
    await act(async () => result.current.stepForward()); // reveals nothing new
    expect(renderArtifacts).toHaveBeenCalledTimes(2); // rebuilt anyway
    expect(drawn().markers).toHaveLength(2);
  });
});

describe("persisting and restoring the toggle", () => {
  it("writes showStrategy onto the session record", async () => {
    vi.useFakeTimers();
    try {
      seedSession({});
      const handle = fakeHandle();
      const rendered = mount(handle);
      await act(async () => {
        await handle.replayRef.current!.barsFor("1m");
      });
      await act(async () => rendered.result.current.toggleStrategy());
      // The save is debounced 400ms behind the last change.
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(savedRecord()?.showStrategy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes back ON after a reload, with the slice redrawn at the restored cursor", async () => {
    seedSession({ showStrategy: true });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    expect(result.current.showStrategy).toBe(true);
    // Not merely the button: the reveal itself has run, at the RESTORED cursor.
    expect(renderArtifacts).toHaveBeenCalled();
    expect(drawn().markers).toHaveLength(2);
    expect(drawn().trades).toHaveLength(1);
    expect(backtestResultSignal.value).toBe(drawn());
  });

  it("ignores a record belonging to another instrument", async () => {
    seedSession({ showStrategy: true, epic: "GOLD" });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    expect(result.current.showStrategy).toBe(false);
  });
});

describe("ending a session restores the cell's own saved result", () => {
  // Every teardown funnels through endSession, but they arrive by three
  // different routes and each one is a way to strand the truncated slice.
  async function revealing() {
    const handle = fakeHandle();
    const rendered = await mountWithStore(handle);
    await act(async () => rendered.result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalled();
    rehydrateBacktest.mockClear();
    return { handle, ...rendered };
  }

  // These sessions never trade, so they take finishSession's skip path: the
  // teardown happens in the gesture itself and there is no card to dismiss (the
  // blind ones get their reveal as a toast instead — useReplay.report.test.tsx).
  it("restores on the ✕ path", async () => {
    seedSession({});
    const { result } = await revealing();
    await act(async () => result.current.requestExit());
    expect(result.current.pendingReport).toBeNull();
    expect(result.current.state.mode).toBe("off");
    expect(rehydrateBacktest).toHaveBeenCalledWith(expect.anything(), SCOPE, EPIC, "1m");
  });

  it("restores on 'pick new start' (the ⟲ path)", async () => {
    seedSession({});
    const { result } = await revealing();
    await act(async () => result.current.requestNewStart());
    expect(result.current.state.mode).toBe("picking");
    expect(rehydrateBacktest).toHaveBeenCalledWith(expect.anything(), SCOPE, EPIC, "1m");
  });

  it("restores on the immediate exit (the symbol-change path)", async () => {
    // exit() outright, which is what the symbol-change guard calls: no card
    // stands between the user and a chart they navigated away from.
    seedSession({});
    const { result } = await revealing();
    await act(async () => result.current.exit());
    expect(result.current.state.mode).toBe("off");
    expect(rehydrateBacktest).toHaveBeenCalled();
  });

  it("leaves a session that never revealed anything alone", async () => {
    // No reveal, no restore: the cell's backtest is already whatever the load
    // effect drew, and a needless rehydrate blinks the panel.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.exit());
    expect(rehydrateBacktest).not.toHaveBeenCalled();
  });
});

// --- what can happen between scheduling a frame and firing it ---------------
//
// Both guards below are invisible while frames run inline, which is how they
// shipped untested. These leave the frame PENDING and land something in the gap.
describe("a frame that outlives what scheduled it", () => {
  it("is ignored once the session has ended (the symbol-change race)", async () => {
    // The reveal effect is declared BEFORE the symbol-change guard, so on the
    // epic's commit it runs first (mode still active) and schedules a frame; only
    // then does the guard exit() and restore the real result. If that frame lands
    // afterwards it republishes a truncated slice ON TOP of the restore —
    // filtered at the old cursor, for the new instrument.
    //
    // Seeded one bar before the minute-9 fill, so a single step is enough to
    // change the reveal's signature and make the late frame a FULL render (the
    // observable one).
    seedSession({ cursorMs: BASE + 9 * MIN, highWaterMs: BASE + 9 * MIN });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    autoRunFrames = false;
    await act(async () => result.current.stepForward());
    expect(frames.length).toBeGreaterThan(0); // a draw really is pending

    // The cancel loses the race: the browser had already dequeued the callback.
    cancelWins = false;
    await act(async () => result.current.exit());
    expect(result.current.state.mode).toBe("off");

    await act(async () => flushFrames());
    // The gate held: nothing drew after the teardown.
    expect(renderArtifacts).toHaveBeenCalledTimes(1);
  });

  it("...but that same pending frame DOES draw when the session is still live", async () => {
    // The positive control for the test above: without it, a gate that simply
    // never fires would look identical to a gate that works.
    seedSession({ cursorMs: BASE + 9 * MIN, highWaterMs: BASE + 9 * MIN });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    autoRunFrames = false;
    cancelWins = false;
    await act(async () => result.current.stepForward());
    await act(async () => flushFrames());
    expect(renderArtifacts).toHaveBeenCalledTimes(2);
    expect(drawn().markers).toHaveLength(3); // the minute-9 fill is out
  });

  it("does not draw against bars a load is about to replace", async () => {
    // A series (re)load — session start, timeframe switch, a resumed session's
    // first store read — tears this cell's artifacts down and swaps the bars
    // under them. Drawing in that window anchors markers to candles that are
    // about to be discarded, and (the half that actually bites) records a
    // signature, so the redraw that SHOULD follow the settled load is dismissed
    // as "unchanged" and the reveal silently stops updating.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await act(async () => result.current.toggleStrategy());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    // Hold the next fetch open so `state.loading` is observably true.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const feed = await import("../lib/feed");
    vi.mocked(feed.fetchRangeWithStatus).mockImplementationOnce(async () => {
      await gate;
      return { bars: BARS, degraded: null, partial: null };
    });

    autoRunFrames = false;
    let loading!: Promise<unknown>;
    await act(async () => {
      loading = handle.replayRef.current!.barsFor("1m");
    });
    expect(result.current.state.loading).toBe(true);
    // Whatever was scheduled mid-load must draw nothing.
    await act(async () => flushFrames());
    expect(renderArtifacts).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await loading;
    });
    expect(result.current.state.loading).toBe(false);
    // ...and the settled load redraws, even though the revealed slice is
    // identical to the one already on screen.
    await act(async () => flushFrames());
    expect(renderArtifacts).toHaveBeenCalledTimes(2);
  });
});
