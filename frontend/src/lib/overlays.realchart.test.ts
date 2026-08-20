// @vitest-environment jsdom
//
// The match bands, against a REAL klinecharts v10 instance.
//
// Every other match-band test in this repo drives a FakeChart, so all of them
// pass whether or not klinecharts would actually accept what OverlayManager
// sends it: the create call's argument shape (v10 clobbers defaults with an
// explicit `undefined`, twice over — see the notes in OverlayManager.create),
// the template registration, and the pane the overlay lands on are all stubbed
// away. A smoke test that reported "showMatchBands creates nothing in the
// browser" could therefore not be reproduced OR refuted by the suite.
//
// So: boot a real chart on a real (jsdom) container, feed it bars the way
// chartDataFacade does (setDataLoader -> setSymbol -> setPeriod -> resetData),
// attach a real OverlayManager to it, and assert that showMatchBands puts two
// overlays named "matchBand" on the chart, anchored on the bars asked for and
// laid out where the pixels say they should be. jsdom has no canvas, so the 2d
// context is stubbed to a no-op recorder — klinecharts only needs it to measure
// and paint, and every assertion here reads the overlay store / convertToPixel,
// never a pixel.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import { registerCustomOverlays } from "./customOverlays";
import { createChartDataFacade, type ChartDataFacade } from "../chart/chartDataFacade";
import { scrollTsToCenter } from "./chartSync";
import { OverlayManager } from "./overlays";

// --- jsdom shims klinecharts needs to boot ---------------------------------
// (getContext returns null in jsdom; ResizeObserver does not exist.)
function stubCanvas(): void {
  const ctx = new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      setLineDash: () => {},
      save: () => {},
      restore: () => {},
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Everything else klinecharts calls on the context (fillRect, beginPath,
        // …) is a paint op with no return value we read.
        return () => {};
      },
      set(target, prop, value) {
        target[prop as string] = value;
        return true;
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // klinecharts measures the container; jsdom reports 0x0 for everything.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect;
}

const BAR_MS = 4 * 60 * 60 * 1000; // 4H, the interval the smoke test ran on
const FIRST_TS = Date.UTC(2022, 8, 1); // 01 Sep 2022

function bars(n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: FIRST_TS + i * BAR_MS,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000,
  }));
}

// Feed a real chart through the REAL data facade (setDataLoader -> setSymbol ->
// setPeriod -> setBars/resetData), so the bars land exactly the way ChartCore
// lands them — including the prepend path applyOlderBars drives.
function feed(chart: Chart, data: KLineData[]): ChartDataFacade {
  const facade = createChartDataFacade();
  facade.attach(chart);
  facade.setSymbol("US100", 2, 0);
  facade.setPeriod({ span: 4, type: "hour" });
  facade.setBars(data, true);
  return facade;
}

interface BandView {
  name?: string;
  id: string;
  lock?: boolean;
  points: Array<{ timestamp?: number }>;
  styles?: { polygon?: { color?: string } };
}

describe("match bands on a real klinecharts instance", () => {
  let container: HTMLDivElement;
  let chart: Chart;
  let m: OverlayManager;
  const data = bars(200);
  // A 10-bar match well inside the loaded window, with a 5-bar aftermath
  // starting on the very next bar (what PatternMatchesPanel hands the jump).
  const matchFrom = data[100].timestamp;
  const matchTo = data[109].timestamp;
  const fwd = { fromTs: data[110].timestamp, toTs: data[114].timestamp };

  beforeAll(() => {
    stubCanvas();
    registerCustomOverlays(); // the real registration path, matchBand included
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    chart = init(container)!;
    expect(chart).toBeTruthy();
    const facade = feed(chart, data);
    m = new OverlayManager();
    m.setScope("tab.A");
    m.attach(chart, facade);
  });

  afterEach(() => {
    m.detach();
    dispose(container);
    container.remove();
  });

  const bandsOn = (): BandView[] =>
    (chart.getOverlays() as unknown as BandView[]).filter((o) => o.name === "matchBand");

  it("puts the whole dataset on the chart (harness sanity: bars really landed)", () => {
    expect(chart.getDataList()).toHaveLength(data.length);
  });

  it("creates two overlays named matchBand, anchored on the bars it was given", () => {
    m.showMatchBands(matchFrom, matchTo, fwd);
    const got = bandsOn();
    expect(got).toHaveLength(2);
    expect(got.map((o) => o.points.map((p) => p.timestamp))).toEqual([
      [matchFrom, matchTo],
      [fwd.fromTs, fwd.toTs],
    ]);
    // Non-interactive, and the aftermath is the dimmer of the two.
    expect(got.every((o) => o.lock === true)).toBe(true);
    expect(got[1].styles?.polygon?.color).not.toBe(got[0].styles?.polygon?.color);
  });

  it("lands the two bands adjacent in PIXEL space, enclosing their own bars", () => {
    m.showMatchBands(matchFrom, matchTo, fwd);
    // Land the viewport on the match the way the jump does, so the pixels below
    // are the ones a user would be looking at (on screen, not off to the left).
    scrollTsToCenter(chart, Math.round((matchFrom + fwd.toTs) / 2));
    // Read the geometry off the OVERLAYS the manager created, not off the
    // constants passed in — a band that was never created has no pixels.
    const got = bandsOn();
    expect(got).toHaveLength(2);
    const matched = got[0]!;
    const aftermath = got[1]!;
    const bar = chart.getBarSpace().bar;
    const px = (ts: number): number => {
      const c = chart.convertToPixel({ timestamp: ts, value: 0 }, { paneId: "candle_pane" });
      const at = Array.isArray(c) ? c[0] : c;
      expect(typeof at?.x).toBe("number");
      return at!.x as number;
    };
    // Anchor timestamps off the created overlays (they exist: asserted above).
    const anchor = (o: BandView, i: number): number => {
      const ts = o.points[i]?.timestamp;
      expect(typeof ts).toBe("number");
      return ts as number;
    };
    const left = (o: BandView) => px(anchor(o, 0)) - bar / 2;
    const right = (o: BandView) => px(anchor(o, 1)) + bar / 2;
    // The template pushes each edge out by half a bar (bar centres -> bar
    // boundaries), so the matched band's right edge IS the aftermath band's
    // left edge: one shared divider, no gap and no overlap.
    expect(right(matched)).toBeCloseTo(left(aftermath), 6);
    // The matched band really encloses its ten candles (not nine gaps between
    // their centres), and the aftermath its five.
    expect(right(matched) - left(matched)).toBeCloseTo(10 * bar, 6);
    expect(right(aftermath) - left(aftermath)).toBeCloseTo(5 * bar, 6);
    // On screen, not paged off the left edge: the whole pair sits inside the
    // 800px pane the harness gives the chart.
    expect(left(matched)).toBeGreaterThan(0);
    expect(right(aftermath)).toBeLessThan(800);
  });

  it("coexists with a range band rather than replacing it (the query band stays up)", () => {
    m.startRangePick(data[10].timestamp);
    m.updateRangePick(data[30].timestamp);
    m.showMatchBands(matchFrom, matchTo, fwd);
    const names = (chart.getOverlays() as unknown as BandView[]).map((o) => o.name);
    expect(names.filter((n) => n === "matchBand")).toHaveLength(2);
    expect(names).toContain("rangeBand");
  });

  it("replaces the previous pair on the next jump, and clears both on dismiss", () => {
    m.showMatchBands(matchFrom, matchTo, fwd);
    const second = { from: data[20].timestamp, to: data[29].timestamp };
    m.showMatchBands(second.from, second.to, null);
    expect(bandsOn()).toHaveLength(1);
    expect(bandsOn()[0].points.map((p) => p.timestamp)).toEqual([second.from, second.to]);
    m.clearMatchBands();
    expect(bandsOn()).toHaveLength(0);
  });

  it("keeps the bands after older history is prepended (a jump pages first, paints after)", () => {
    m.showMatchBands(matchFrom, matchTo, fwd);
    const older = Array.from({ length: 50 }, (_, i) => ({
      timestamp: FIRST_TS - (50 - i) * BAR_MS,
      open: 50, high: 51, low: 49, close: 50.5, volume: 10,
    }));
    m.applyOlderBars([...older, ...data]);
    // Timestamp-anchored, so the bands re-resolve onto the same bars.
    expect(bandsOn()).toHaveLength(2);
    expect(bandsOn()[0].points.map((p) => p.timestamp)).toEqual([matchFrom, matchTo]);
  });
});
