// @vitest-environment jsdom
//
// The strategy reveal against the REAL drawing stack.
//
// `useReplay.reveal.test.tsx` mocks lib/backtest and runs frames inline, which
// is the right harness for "which slice reaches the chart". It is the wrong
// harness for "does anything reach the chart at all": it cannot see a publish
// that gets overwritten, an artifact set that never gets built, or a frame that
// never fires. A browser pass found the reveal completely inoperative while that
// file was green, so this one keeps the real renderArtifacts / teardownArtifacts
// / rehydrateBacktest, a real klinecharts instance with real bars, and a REAL
// requestAnimationFrame that the test waits for.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { init, dispose, type Chart } from "klinecharts";
import { installMemStorage } from "../lib/testMemStorage";
import { createChartDataFacade, periodFromTf, type ChartDataFacade } from "./chartDataFacade";
import type { ChartHandle } from "./chartHandle";
import type { ReplaySessionRecord } from "../lib/replaySession";
import type { StoredBacktestResult } from "../lib/persist";
import type { TradeView } from "../lib/trading";

installMemStorage();

vi.mock("../lib/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trading")>()),
  refreshTrades: vi.fn(),
}));

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);
const BAR_COUNT = 20;

const BARS = vi.hoisted(() =>
  Array.from({ length: 20 }, (_, i) => ({
    timestamp: Date.UTC(2021, 4, 17, 9, 0) + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1,
  })),
);

vi.mock("../lib/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feed")>()),
  fetchRangeWithStatus: vi.fn(async () => ({ bars: BARS, degraded: null })),
}));

const { useReplay } = await import("./useReplay");
const { backtestResultSignal } = await import("../lib/signals");
const {
  registerBacktestIndicators,
  ownsBacktestPanel,
  teardownArtifacts,
  rehydrateBacktest,
  backtestPanelActionForReplay,
} = await import("../lib/backtest");

const SCOPE = "tab1.cellLive";
const EPIC = "US100";
const REPLAY_KEY = "auto-trader.replaySessions";
const BACKTEST_KEY = `auto-trader.${SCOPE}.backtest.${EPIC}`;
const CURSOR = BASE + 6 * MIN; // bars 0..5 revealed

const S = (ms: number) => Math.floor(ms / 1000);

/** Four fills, two of them inside the resumed cursor's window. */
const SAVED = {
  epic: EPIC,
  resolution: "MINUTE",
  markers: [
    { time: S(BASE + 2 * MIN), side: "buy", price: 102, reason: "entry", leg: "long" },
    { time: S(BASE + 4 * MIN), side: "sell", price: 104, reason: "target", leg: "long" },
    { time: S(BASE + 9 * MIN), side: "buy", price: 109, reason: "entry", leg: "long" },
    { time: S(BASE + 12 * MIN), side: "sell", price: 112, reason: "target", leg: "long" },
  ],
  trades: [
    {
      side: "buy", quantity: 1, entry_time: S(BASE + 2 * MIN), entry_price: 102,
      exit_time: S(BASE + 4 * MIN), exit_price: 104, pnl: 2, leg: "long", reason: "target",
      stop_initial: null, stop_final: null, target: null, mae: 0, mfe: 2, mae_r: null, mfe_r: null,
    },
    {
      side: "buy", quantity: 1, entry_time: S(BASE + 9 * MIN), entry_price: 109,
      exit_time: S(BASE + 12 * MIN), exit_price: 112, pnl: 3, leg: "long", reason: "target",
      // A real bracket on the SECOND trade: it is the one that is open mid-window,
      // and its lines are what the open-trade case below asserts get drawn.
      stop_initial: 107, stop_final: 111, target: 113, mae: 0, mfe: 3, mae_r: null, mfe_r: null,
    },
  ],
  equity: Array.from({ length: BAR_COUNT }, (_, i) => ({ time: S(BASE + i * MIN), value: 1000 + i })),
  summary: { net_pnl: 5, n_trades: 2, win_rate: 1, max_drawdown: 0 },
  metrics: {
    return_pct: 0.5, profit_factor: null, expectancy: 2.5, avg_win: 2.5, avg_loss: 0,
    avg_win_loss_ratio: null, largest_win: 3, largest_loss: 0, max_drawdown_pct: 0,
    avg_duration_bars: 2, max_consec_wins: 2, max_consec_losses: 0,
  },
  period: { fromMs: BASE, toMs: BASE + 19 * MIN },
} as unknown as StoredBacktestResult;

beforeAll(() => {
  const ctx = new Proxy(
    { measureText: () => ({ width: 0 }), canvas: { width: 0, height: 0 } },
    {
      get: (target, prop) =>
        prop in target
          ? (target as Record<string, unknown>)[prop as string]
          : typeof prop === "string"
            ? () => {}
            : undefined,
    },
  );
  // @ts-expect-error jsdom canvas stub
  HTMLCanvasElement.prototype.getContext = () => ctx;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  registerBacktestIndicators();
});

function seedSession(over: Partial<ReplaySessionRecord>): void {
  const rec: ReplaySessionRecord = {
    epic: EPIC,
    resolution: "MINUTE",
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

let chart: Chart;
let el: HTMLDivElement;
let facade: ChartDataFacade;

function fakeHandle(): ChartHandle {
  return {
    chartRef: { current: chart },
    dataFacadeRef: { current: facade },
    tradesRef: { current: [] as TradeView[] },
    posDrawRef: { current: () => {} },
    redrawRef: { current: () => {} },
    replayRef: { current: null },
  } as unknown as ChartHandle;
}

/** What chart/useLiveMarketData's load effect does around `barsFor`, in its real
 * order. Re-runs on every `replayEpoch` bump: session start, timeframe switch,
 * exit, and a resumed session's first store read — so a live session goes
 * through this repeatedly, and the reveal has to survive it. The three things
 * that matter to the reveal are all here: ownership captured BEFORE the
 * teardown, the synchronous teardown itself, and the panel action at the tail
 * (which lands AFTER the awaited bars). */
async function runLoadEffect(handle: ChartHandle): Promise<void> {
  await act(async () => {
    const ownedBefore = ownsBacktestPanel(chart);
    teardownArtifacts(chart);
    const bars = await handle.replayRef.current!.barsFor("MINUTE");
    facade.setBars(bars, false);
    const action = backtestPanelActionForReplay({
      replaying: handle.replayRef.current!.isActive(),
      stalePanelOwner: ownedBefore,
    });
    if (action === "clear") backtestResultSignal.set(null);
    else if (action === "rehydrate") rehydrateBacktest(chart, SCOPE, EPIC, "MINUTE");
  });
}

async function mountWithStore(handle: ChartHandle) {
  const rendered = renderHook(() =>
    useReplay(handle, {
      epic: EPIC,
      resolution: "MINUTE",
      priceSide: "mid",
      brokerId: "capital",
      scope: SCOPE,
    }),
  );
  await act(async () => {
    await handle.replayRef.current!.barsFor("MINUTE");
  });
  return rendered;
}

/** Wait for a real animation frame (plus a macrotask, so anything the frame
 * scheduled has settled). This is the whole point of the file: nothing here
 * stubs rAF, so a frame that never fires shows up as a failure rather than as a
 * synchronous pass. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

beforeEach(() => {
  localStorage.removeItem(REPLAY_KEY);
  localStorage.setItem(BACKTEST_KEY, JSON.stringify(SAVED));
  backtestResultSignal.set(null);
  el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 800 });
  Object.defineProperty(el, "clientHeight", { value: 600 });
  document.body.appendChild(el);
  chart = init(el)!;
  // The REAL data facade, wired the way ChartCore wires it, so `getDataList()`
  // answers what a replaying chart actually shows: the revealed slice.
  facade = createChartDataFacade();
  facade.attach(chart);
  facade.setSymbol(EPIC, 2, 0);
  facade.setPeriod(periodFromTf("1m"));
  facade.setBars(BARS.slice(0, 6), false);
});

afterEach(() => {
  dispose(el);
  el.remove();
  localStorage.removeItem(BACKTEST_KEY);
  vi.clearAllMocks();
});

describe("the reveal against the real drawing stack", () => {
  it("publishes the revealed slice when the toggle goes ON mid-session", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    expect(result.current.state.mode).toBe("active");
    expect(chart.getDataList().length).toBeGreaterThan(0);
    expect(backtestResultSignal.value).toBeNull();

    await act(async () => result.current.toggleStrategy());
    await nextFrame();

    // The observable the browser pass measured as never changing.
    expect(backtestResultSignal.value).not.toBeNull();
    expect(backtestResultSignal.value!.markers).toHaveLength(2);
    expect(backtestResultSignal.value!.trades).toHaveLength(1);
    // ...and this chart really does back the panel afterwards.
    expect(ownsBacktestPanel(chart)).toBe(true);
  });

  it("publishes on a session RESUMED with the toggle already on", async () => {
    seedSession({ showStrategy: true });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    expect(result.current.showStrategy).toBe(true);
    await nextFrame();

    expect(backtestResultSignal.value).not.toBeNull();
    expect(backtestResultSignal.value!.markers).toHaveLength(2);
    expect(ownsBacktestPanel(chart)).toBe(true);
  });

  it("never paints the whole run while the session is still LIVE", async () => {
    // The blindness Critical: toggling OFF mid-session used to rehydrate the
    // full saved backtest onto the blind chart — every marker of the run,
    // including the ones in the session's own future, plus the run's final P&L.
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);

    await act(async () => result.current.toggleStrategy());
    await nextFrame();
    await act(async () => result.current.toggleStrategy());
    await nextFrame();

    expect(result.current.showStrategy).toBe(false);
    expect(result.current.state.mode).toBe("active"); // still replaying
    const shown = backtestResultSignal.value;
    // Nothing, or at most the revealed slice — never the run's 4 markers.
    expect(shown?.markers.length ?? 0).toBeLessThan(SAVED.markers.length);
    expect(shown?.summary.net_pnl ?? 0).not.toBe(SAVED.summary.net_pnl);
  });

  it("survives the load effect that a session start / timeframe switch re-runs", async () => {
    // The browser pass measured the reveal publishing NOTHING while the unit
    // suite was green. The gap is this: the load effect tears the artifacts down
    // and then, at its tail (after the awaited bars), clears the panel — so a
    // reveal that already published is left owning nothing. If its signature
    // survives that, the next fire matches, takes the in-place branch, and
    // updateShownResult silently refuses because the chart no longer backs the
    // panel. The reveal is then dead for the rest of the session.
    seedSession({ showStrategy: true });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await nextFrame();
    expect(ownsBacktestPanel(chart)).toBe(true);

    await runLoadEffect(handle);
    await nextFrame();

    expect(backtestResultSignal.value).not.toBeNull();
    expect(backtestResultSignal.value!.markers).toHaveLength(2);
    expect(ownsBacktestPanel(chart)).toBe(true);

    // ...and it keeps working afterwards: a step must still advance the slice.
    await act(async () => result.current.stepForward());
    await act(async () => result.current.stepForward());
    await act(async () => result.current.stepForward());
    await act(async () => result.current.stepForward());
    await nextFrame();
    expect(backtestResultSignal.value!.markers).toHaveLength(3);
  });

  it("re-reveals correctly after an off/on cycle", async () => {
    seedSession({});
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);

    await act(async () => result.current.toggleStrategy());
    await nextFrame();
    await act(async () => result.current.toggleStrategy());
    await nextFrame();
    await act(async () => result.current.toggleStrategy());
    await nextFrame();

    expect(backtestResultSignal.value?.markers).toHaveLength(2);
    expect(ownsBacktestPanel(chart)).toBe(true);
  });
});

// The open trade's R/R zone against a REAL klinecharts instance. The mocked
// chart in lib/backtestOpenTradeMarker.test.ts proves WHICH call the per-step
// path makes; only this proves klinecharts actually accepts it — an
// overrideOverlay with a stale id, or points in a shape it rejects, is a silent
// no-op there and a zone frozen at the click bar here.
describe("the open trade's zone, on a real chart", () => {
  const zoneOf = () => chart.getOverlays().filter((o) => o.name === "tradeZone");

  it("keeps ONE overlay and moves its right edge as the cursor advances", async () => {
    seedSession({ showStrategy: true });
    const handle = fakeHandle();
    const { result } = await mountWithStore(handle);
    await nextFrame();

    // Step from the resumed cursor (bar 6) into the second trade, which enters
    // at minute 9 and exits at 12 — open for the rest of this test.
    for (let i = 0; i < 4; i++) await act(async () => result.current.stepForward());
    await nextFrame();
    expect(backtestResultSignal.value!.openTrades).toHaveLength(1);

    // Click the open trade's entry marker the way the chart does.
    const marker = chart
      .getOverlays()
      .find((o) => o.name === "backtestMarker" && o.points[0].timestamp === BASE + 9 * MIN)!;
    expect(marker).toBeDefined();
    act(() => {
      (marker as unknown as { onClick: () => void }).onClick();
    });

    const drawn = zoneOf();
    expect(drawn).toHaveLength(1);
    const id = drawn[0].id;
    const edgeBefore = drawn[0].points[1].timestamp!;

    // Step on; the trade is still open (its exit is at minute 12). TWO steps:
    // the zone floors at one bar wide, so the first bar after the entry leaves
    // the right edge exactly where the floor already put it.
    await act(async () => result.current.stepForward());
    await act(async () => result.current.stepForward());
    await nextFrame();

    const after = zoneOf();
    expect(after).toHaveLength(1); // never stacked, never dropped
    expect(after[0].id).toBe(id); // the SAME overlay, moved in place
    expect(after[0].points[1].timestamp!).toBeGreaterThan(edgeBefore);
    expect(backtestResultSignal.value!.openTrades).toHaveLength(1);
  });
});
