// @vitest-environment jsdom
//
// The ENTRY MARKER of a trade that is still open at the replay cursor.
//
// The reveal keeps that marker (the fill happened) but keeps the TRADE out of
// `trades` (it has no P&L yet), so drawMarkers' fill -> trade-index map has no
// entry for it. Before `openTrades`, that made the newest marker on a replaying
// chart completely inert — no hover, no click, no selection — in the exact spot
// the user is watching the strategy play out. It has no index for
// selectedTradeSignal, so its click draws the windowed R/R ZONE directly — the
// same overlay a selected closed trade gets — clamped to the cursor.
//
// A fake chart rather than a real klinecharts instance: what is under test is
// WHICH handlers are attached to WHICH marker overlay, and createOverlay's
// argument is exactly that. (backtestShownResult.test.ts drives the real one.)
import { describe, it, expect, beforeEach } from "vitest";
import type { Chart } from "klinecharts";
import {
  openTradeZoneKey,
  renderArtifacts,
  restoreOpenTradeZone,
  teardownArtifacts,
  updateShownResult,
} from "./backtest";
import { backtestResultSignal, selectedTradeSignal, tradeMarkerHoverSignal } from "./signals";
import type { StoredBacktestResult } from "./persist/artifacts";
import type { OpenStrategyTrade } from "./replayReveal";

const MIN = 60_000;
const BASE = Date.UTC(2021, 4, 17, 9, 0);
const S = (ms: number) => Math.floor(ms / 1000);

const BARS = Array.from({ length: 20 }, (_, i) => ({
  timestamp: BASE + i * MIN,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1,
}));
// What the fake chart's getDataList serves — reassigned by the growth test to
// model the replay revealing more bars between steps.
let liveBars = BARS;

type OverlayArg = {
  name: string;
  points: { timestamp: number }[];
  onClick?: () => boolean;
  onMouseEnter?: (e: { pageX?: number; pageY?: number }) => boolean;
  onMouseLeave?: () => boolean;
};

let created: OverlayArg[] = [];
let removed: string[] = [];
let overridden: {
  id: string;
  points?: { timestamp: number; value: number }[];
  extendData?: { win: boolean };
}[] = [];

function fakeChart(): Chart {
  return {
    getDataList: () => liveBars,
    getVisibleRange: () => ({ from: 0, to: BARS.length - 1, realFrom: 0, realTo: BARS.length - 1 }),
    createOverlay: (o: OverlayArg) => {
      created.push(o);
      return `ov-${created.length}`;
    },
    removeOverlay: (o: { id?: string }) => {
      if (o?.id) removed.push(o.id);
    },
    overrideOverlay: (o: {
      id: string;
      points?: { timestamp: number; value: number }[];
      extendData?: { win: boolean };
    }) => {
      overridden.push(o);
      return true;
    },
    createIndicator: () => null,
    removeIndicator: () => {},
    setStyles: () => {},
    getStyles: () => ({ crosshair: {} }),
    // setMarkerHoverCursor reaches for the pane element to swap the cursor.
    getDom: () => document.createElement("div"),
  } as unknown as Chart;
}

/** One closed trade (minute 2 -> 4) and one still open (entered minute 9), as
 * the reveal publishes them at a cursor between minute 10 and the open trade's
 * exit: four markers' worth of run, three of which have printed. */
const OPEN: OpenStrategyTrade = {
  index: 1, // its position in the RUN's trade list — what the position id is keyed by
  leg: "long",
  quantity: 2,
  entryTime: S(BASE + 9 * MIN),
  entryPrice: 109,
  stop: 107,
  target: 113,
};

const SLICE = {
  epic: "US100",
  resolution: "MINUTE",
  markers: [
    { time: S(BASE + 2 * MIN), side: "buy", price: 102, reason: "entry", leg: "long" },
    { time: S(BASE + 4 * MIN), side: "sell", price: 104, reason: "target", leg: "long" },
    { time: S(BASE + 9 * MIN), side: "buy", price: 109, reason: "entry", leg: "long" },
  ],
  trades: [
    { entry_time: S(BASE + 2 * MIN), exit_time: S(BASE + 4 * MIN), pnl: 2, leg: "long", quantity: 1 },
  ],
  equity: [],
  openTrades: [OPEN],
  summary: { net_pnl: 2, n_trades: 1, win_rate: 1, max_drawdown: 0 },
  metrics: { profit_factor: null, expectancy: 2 },
} as unknown as StoredBacktestResult;

const markerAt = (ms: number) =>
  created.filter((o) => o.name === "backtestMarker").find((o) => o.points[0].timestamp === ms);

function render(result: StoredBacktestResult): Chart {
  const chart = fakeChart();
  renderArtifacts(chart, result, { markerMode: "native", canEquity: false });
  backtestResultSignal.set(result); // the identity every handler gates on
  return chart;
}

beforeEach(() => {
  created = [];
  removed = [];
  overridden = [];
  liveBars = BARS;
  backtestResultSignal.set(null);
  selectedTradeSignal.set(null);
  tradeMarkerHoverSignal.set(null);
});

describe("the open trade's entry marker", () => {
  it("draws the R/R zone a selected trade gets, clamped to the cursor", () => {
    const chart = render(SLICE);
    const m = markerAt(BASE + 9 * MIN);
    expect(m?.onClick).toBeTypeOf("function");

    m!.onClick!();
    const zone = created.find((o) => o.name === "tradeZone") as OverlayArg & {
      extendData: { hasRisk: boolean; hasReward: boolean; stopMoved: boolean };
      points: { timestamp: number; value: number }[];
    };
    expect(zone).toBeDefined();
    // Entry anchored at the fill; the exit point is the LAST LOADED BAR at its
    // close — "the trade so far", never a bar the cursor has not revealed.
    expect(zone.points[0]).toMatchObject({ timestamp: BASE + 9 * MIN, value: 109 });
    expect(zone.points[5].timestamp).toBe(BASE + 19 * MIN);
    expect(zone.points[5].value).toBe(BARS[19].close);
    // Risk/reward bands from the INITIAL bracket; the trail's end is the
    // future's knowledge, so the moved-stop line never draws.
    expect(zone.extendData).toMatchObject({ hasRisk: true, hasReward: true, stopMoved: false });
    // It does NOT go through selectedTradeSignal — there is no index to carry.
    expect(selectedTradeSignal.value).toBeNull();

    m!.onClick!(); // clicking the marker again takes the zone back off
    expect(removed.length).toBeGreaterThan(0);
    expect(created.filter((o) => o.name === "tradeZone")).toHaveLength(1); // no re-draw
    teardownArtifacts(chart);
  });

  it("marks the hover for ChartCore's over-a-marker click guard", () => {
    const chart = render(SLICE);
    const m = markerAt(BASE + 9 * MIN)!;

    m.onMouseEnter!({ pageX: 10, pageY: 20 });
    // The load-bearing half: ChartCore's DOM click handler reads this signal to
    // know the click landed on a marker and skip its empty-space deselect and
    // line hit-test — without it the DOM click that follows the overlay's
    // onClick fights the zone it just drew (the browser bug this file exists
    // for). No tradeId: there is no trade-line selection behind this marker.
    expect(tradeMarkerHoverSignal.value).not.toBeNull();
    expect(tradeMarkerHoverSignal.value?.tradeId).toBeUndefined();
    // Empty on purpose: the marker paints its own pill; the DOM hover popover
    // skips empty labels, so nothing renders twice.
    expect(tradeMarkerHoverSignal.value?.label).toBe("");

    m.onMouseLeave!();
    expect(tradeMarkerHoverSignal.value).toBeNull();
    teardownArtifacts(chart);
  });

  it("leaves a CLOSED trade's markers on the trade-index path", () => {
    const chart = render(SLICE);
    // Entry and exit of the closed trade both still select the TRADE (index 0),
    // not a position: they are handled before openTrades is consulted at all.
    markerAt(BASE + 2 * MIN)!.onClick!();
    expect(selectedTradeSignal.value).toBe(0);
    markerAt(BASE + 4 * MIN)!.onClick!(); // the exit marker of the same trade toggles it off
    expect(selectedTradeSignal.value).toBeNull();
    teardownArtifacts(chart);
  });

  // A strategy that pyramids opens two trades on the same bar, so their entry
  // markers share a time|leg|side key. Each must reach its OWN position.
  it("gives two same-bar entries a marker each", () => {
    const second = { ...OPEN, index: 2 };
    const chart = render({
      ...SLICE,
      markers: [...SLICE.markers, { ...SLICE.markers[2] }],
      openTrades: [OPEN, second],
    } as StoredBacktestResult);
    const both = created.filter(
      (o) => o.name === "backtestMarker" && o.points[0].timestamp === BASE + 9 * MIN,
    );
    expect(both).toHaveLength(2);
    // Each marker owns ITS trade's zone: the second click replaces the first
    // (one selection at a time) rather than toggling it off, because the first
    // zone belongs to the other trade.
    both[0].onClick!();
    expect(created.filter((o) => o.name === "tradeZone")).toHaveLength(1);
    both[1].onClick!();
    expect(created.filter((o) => o.name === "tradeZone")).toHaveLength(2);
    expect(removed.length).toBeGreaterThan(0); // the first zone came off
    teardownArtifacts(chart);
  });

  it("stays inert when the run has no open trade (a finished backtest)", () => {
    const chart = render({ ...SLICE, openTrades: undefined } as StoredBacktestResult);
    expect(markerAt(BASE + 9 * MIN)?.onClick).toBeUndefined();
    teardownArtifacts(chart);
  });

  // The zone follows the session. Its right edge is "now", and now moves: every
  // replay step lands in updateShownResult (the reveal's in-place path), which
  // must re-clamp the zone — or it freezes at the bar it was clicked on while
  // the session plays on (the browser regression this pins).
  it("grows with the cursor on every in-place step while the trade stays open", () => {
    const chart = render(SLICE);
    markerAt(BASE + 9 * MIN)!.onClick!();
    const first = created.filter((o) => o.name === "tradeZone").at(-1)!;
    expect(first.points[5].timestamp).toBe(BASE + 19 * MIN);

    // Two more bars reveal; the reveal hands the (equity-grown) slice to the
    // in-place path.
    liveBars = [
      ...BARS,
      { timestamp: BASE + 20 * MIN, open: 120, high: 121, low: 119, close: 120, volume: 1 },
      { timestamp: BASE + 21 * MIN, open: 121, high: 122, low: 120, close: 121, volume: 1 },
    ];
    expect(updateShownResult(chart, { ...SLICE } as StoredBacktestResult)).toBe(true);

    // Moved IN PLACE, not rebuilt: a remove + create per revealed bar is the
    // churn updateShownResult exists to avoid, and this runs on its cadence.
    expect(created.filter((o) => o.name === "tradeZone")).toHaveLength(1);
    expect(removed).toHaveLength(0);
    const moved = overridden.at(-1)!;
    expect(moved.points![1].timestamp).toBe(BASE + 21 * MIN); // right edge at the cursor
    expect(moved.points![5].timestamp).toBe(BASE + 21 * MIN);
    expect(moved.points![5].value).toBe(121); // marked at the new close
    // The entry end is untouched — only "now" moves.
    expect(moved.points![0]).toMatchObject({ timestamp: BASE + 9 * MIN, value: 109 });
    teardownArtifacts(chart);
  });

  // `win` is the MARK-to-market sign for an open trade — it colours the
  // entry→mark segment and the exit dot. Updating only the points would strand
  // that colour at whatever it was when the marker was clicked, so a trade that
  // went from up to down would keep reading green for the rest of the session.
  it("flips the zone's win colour when the mark crosses back through the entry", () => {
    const chart = render(SLICE);
    markerAt(BASE + 9 * MIN)!.onClick!();
    // Entry 109; last bar closes at 119, so the trade is UP at the click.
    expect((created.filter((o) => o.name === "tradeZone").at(-1) as unknown as {
      extendData: { win: boolean };
    }).extendData.win).toBe(true);

    // Price falls back below the entry.
    liveBars = [
      ...BARS,
      { timestamp: BASE + 20 * MIN, open: 110, high: 111, low: 100, close: 101, volume: 1 },
    ];
    expect(updateShownResult(chart, { ...SLICE } as StoredBacktestResult)).toBe(true);

    expect(overridden.at(-1)!.extendData?.win).toBe(false);
    teardownArtifacts(chart);
  });

  it("survives a full redraw, and hands over to the closed trade when the exit prints", () => {
    const chart = render(SLICE);
    markerAt(BASE + 9 * MIN)!.onClick!();
    const key = openTradeZoneKey(chart)!;
    expect(key).toMatchObject({
      index: 1,
      entryTime: S(BASE + 9 * MIN),
      leg: "long",
      entryPrice: 109,
    });

    // A full reveal redraw while the trade is STILL open (some other count
    // changed): teardown wipes the zone; the restore puts it back.
    teardownArtifacts(chart);
    renderArtifacts(chart, SLICE, { markerMode: "native", canEquity: false });
    backtestResultSignal.set(SLICE);
    const before = created.filter((o) => o.name === "tradeZone").length;
    restoreOpenTradeZone(chart, key);
    expect(created.filter((o) => o.name === "tradeZone").length).toBe(before + 1);

    // The exit bar prints: the trade leaves openTrades and joins `trades`. The
    // zone hands over to the CLOSED trade's normal selection — found by
    // entry_time+leg, because the slice is filtered and the run index no
    // longer addresses it (a still-open earlier trade shifts everything).
    const closedSlice = {
      ...SLICE,
      openTrades: [],
      trades: [
        ...SLICE.trades,
        // A same-bar, same-direction sibling: only the entry PRICE tells them
        // apart, so the handover must not grab this one.
        { entry_time: S(BASE + 9 * MIN), exit_time: S(BASE + 11 * MIN), pnl: 1, leg: "long", quantity: 1, entry_price: 108 },
        { entry_time: S(BASE + 9 * MIN), exit_time: S(BASE + 12 * MIN), pnl: 3, leg: "long", quantity: 2, entry_price: 109 },
      ],
    } as unknown as StoredBacktestResult;
    teardownArtifacts(chart);
    renderArtifacts(chart, closedSlice, { markerMode: "native", canEquity: false });
    backtestResultSignal.set(closedSlice);
    restoreOpenTradeZone(chart, key);
    expect(selectedTradeSignal.value).toBe(2); // the 109 entry, not its 108 sibling
    teardownArtifacts(chart);
  });
});
