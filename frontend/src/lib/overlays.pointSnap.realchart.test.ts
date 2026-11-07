// @vitest-environment jsdom
//
// Magnet-snapped drawing points across timeframes (overlays/pointSnap.ts),
// against a REAL klinecharts v10 instance: a segment drawn through two DAILY
// candles' low and high, rehydrated on a 4H chart, must show its ends on the
// 4H candles that traded them, and a save there must still write the daily
// bar opens.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import { registerCustomOverlays } from "./customOverlays";
import { createChartDataFacade } from "../chart/chartDataFacade";
import { OverlayManager } from "./overlays";
import { loadDrawings, saveDrawings } from "./persist";

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

// jsdom's own localStorage is unusable under this runner; persist.ts reads
// the global at call time, so an in-memory one is enough.
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const H4 = 4 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 9, 12); // Mon 12 Oct 2026

// Three days of 4H bars (6 a day). Day 0's low (90) trades on its 4th bar,
// day 2's high (130) on its 2nd; every other bar sits at 100..110.
function bars4h(): KLineData[] {
  return Array.from({ length: 18 }, (_, i) => {
    const t = D0 + i * H4;
    return {
      timestamp: t,
      open: 105,
      high: i === 13 ? 130 : 110,
      low: i === 3 ? 90 : 100,
      close: 106,
      volume: 1,
    };
  });
}

describe("magnet-snapped drawing points on a finer chart", () => {
  let container: HTMLDivElement;
  let chart: Chart;
  let m: OverlayManager;

  beforeAll(() => {
    stubCanvas();
    vi.stubGlobal("localStorage", new MemStorage());
    registerCustomOverlays();
  });

  afterEach(() => {
    m.detach();
    dispose(container);
    container.remove();
    localStorage.clear();
  });

  function boot(snaps: unknown, loaded: KLineData[] = bars4h()) {
    saveDrawings("tab.S", "US100", [
      {
        id: "seg1",
        name: "segment",
        points: [
          { timestamp: D0, value: 90 },
          { timestamp: D0 + 2 * DAY, value: 130 },
        ],
        extendData: { snaps },
      } as never,
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    chart = init(container)!;
    const facade = createChartDataFacade();
    facade.attach(chart);
    facade.setSymbol("US100", 2, 0);
    facade.setPeriod({ span: 4, type: "hour" });
    facade.setBars(loaded, true);
    m = new OverlayManager();
    m.attach(chart, facade);
    m.setScope("tab.S");
    m.setEpic("US100");
    m.rehydrate("HOUR_4");
  }
  const seg = () =>
    (chart.getOverlays() as unknown as Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number }> }>).find(
      (o) => o.name === "segment",
    )!;
  const daySnaps = [
    { k: "low", tf: "DAY", t: D0, v: 90 },
    { k: "high", tf: "DAY", t: D0 + 2 * DAY, v: 130 },
  ];
  const save = () => (m as unknown as { persist(): void }).persist();

  it("shows each snapped end on the 4H candle that traded its level", () => {
    boot(daySnaps);
    expect(seg().points.map((p) => p.timestamp)).toEqual([D0 + 3 * H4, D0 + 13 * H4]);
  });

  it("leaves unsnapped points on their stored time", () => {
    boot(undefined);
    expect(seg().points.map((p) => p.timestamp)).toEqual([D0, D0 + 2 * DAY]);
  });

  it("saves an untouched snapped point back at its daily bar open", () => {
    boot(daySnaps);
    save();
    const d = loadDrawings("tab.S", "US100")[0];
    expect(d.points.map((p) => p.timestamp)).toEqual([D0, D0 + 2 * DAY]);
    expect((d.extendData as { snaps: unknown }).snaps).toEqual(daySnaps);
  });

  it("re-places a snapped point once older bars bring its day into view", () => {
    // Only from day 0's 3rd bar onward is loaded: its low bar is, but the
    // day's start is not, so the point waits on the day open.
    boot(daySnaps, bars4h().slice(2));
    expect(seg().points[0].timestamp).toBe(D0);
    m.applyOlderBars(bars4h());
    expect(seg().points[0].timestamp).toBe(D0 + 3 * H4);
    save();
    expect(loadDrawings("tab.S", "US100")[0].points[0].timestamp).toBe(D0);
  });

  it("snaps only the point the user moved", () => {
    boot(undefined);
    const p = seg().points;
    chart.overrideOverlay({ id: seg().id, points: [{ timestamp: D0 + 3 * H4, value: 90 }, p[1]] as never });
    save(); // the user moved point 0 onto the low: that one snaps
    const moved = loadDrawings("tab.S", "US100")[0].extendData as { snaps?: unknown[] };
    expect(moved.snaps?.[0]).toEqual({ k: "low", tf: "HOUR_4", t: D0 + 3 * H4, v: 90 });
    expect(moved.snaps?.[1] ?? null).toBeNull();
  });

  it("leaves a loaded drawing's untouched points unsnapped on save", () => {
    // Stored unsnapped exactly on bar 3's low and bar 13's high: a save (any
    // edit elsewhere) must not snap them.
    container = document.createElement("div");
    document.body.appendChild(container);
    chart = init(container)!;
    const facade = createChartDataFacade();
    facade.attach(chart);
    facade.setSymbol("US100", 2, 0);
    facade.setPeriod({ span: 4, type: "hour" });
    facade.setBars(bars4h(), true);
    saveDrawings("tab.S", "US100", [
      { id: "seg2", name: "segment", points: [{ timestamp: D0 + 3 * H4, value: 90 }, { timestamp: D0 + 13 * H4, value: 130 }] } as never,
    ]);
    m = new OverlayManager();
    m.attach(chart, facade);
    m.setScope("tab.S");
    m.setEpic("US100");
    m.rehydrate("HOUR_4");
    save();
    expect((loadDrawings("tab.S", "US100")[0].extendData as { snaps?: unknown } | undefined)?.snaps).toBeUndefined();
  });

  it("Cancel in the settings keeps a snapped point's snap", () => {
    boot(daySnaps);
    const shown = seg().points.map((p) => ({ timestamp: p.timestamp, value: p.value }));
    // The Coordinates tab moves point 0's price (snap dropped on save) …
    m.updatePoints(seg().id, [{ timestamp: shown[0].timestamp, value: 95 }, shown[1]]);
    // … then Cancel restores the snaps and the points shown at open.
    m.restoreSnaps(seg().id, daySnaps as never, shown);
    m.updatePoints(seg().id, shown);
    const d = loadDrawings("tab.S", "US100")[0];
    expect(d.points.map((p) => p.timestamp)).toEqual([D0, D0 + 2 * DAY]);
    expect((d.extendData as { snaps: unknown }).snaps).toEqual(daySnaps);
  });

  it("re-snaps a point dragged on the 4H chart at 4H", () => {
    boot(daySnaps);
    // The user drags the second end onto bar 7's high (110), magnet on.
    const p = seg().points;
    chart.overrideOverlay({ id: seg().id, points: [p[0], { timestamp: D0 + 7 * H4, value: 110 }] as never });
    save();
    const d = loadDrawings("tab.S", "US100")[0];
    expect(d.points.map((q) => q.timestamp)).toEqual([D0, D0 + 7 * H4]);
    expect((d.extendData as { snaps: unknown }).snaps).toEqual([
      daySnaps[0],
      { k: "high", tf: "HOUR_4", t: D0 + 7 * H4, v: 110 },
    ]);
  });
});
