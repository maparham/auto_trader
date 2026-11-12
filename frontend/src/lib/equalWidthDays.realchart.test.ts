// @vitest-environment jsdom
//
// Equal-width days against a REAL (patched) klinecharts store: while the user
// is scrolled back, data arriving at either end must not slide the candles
// they are reading, even when it widens the slot grid.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import { relayoutSlots, setEqualWidthDays, setSlotAnchors, setSlotSource, slotGridFor } from "./equalWidthDays";
import { utcAnchors } from "./equalWidthDays.testUtil";

function stubCanvas(): void {
  const ctx = new Proxy({ measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
    get: (t, p) => (p in t ? t[p as string] : () => {}),
    set: (t, p, v) => ((t[p as string] = v), true),
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const k of ["clientWidth", "offsetWidth"]) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, value: 800 });
  for (const k of ["clientHeight", "offsetHeight"]) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, value: 600 });
}

const DAY = 86_400_000;
const H = 3_600_000;
const D0 = Date.UTC(2026, 10, 2);
const bar = (t: number): KLineData => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
/** Hourly candles 14:00..19:00 UTC on days from..to-1. */
const days = (from: number, to: number, first = 14): KLineData[] => {
  const out: KLineData[] = [];
  for (let d = from; d < to; d++) for (let h = first; h <= 19; h++) out.push(bar(D0 + d * DAY + h * H));
  return out;
};

type Store = {
  _addData(data: KLineData | KLineData[], type: string, more?: boolean): void;
  dataIndexToCoordinate(i: number): number;
  setLastBarRightSideDiffBarCount(n: number): void;
  getDataList(): KLineData[];
};

describe("equal-width days on a real klinecharts store", () => {
  let container: HTMLDivElement;
  let chart: Chart;
  let store: Store;
  beforeAll(stubCanvas);
  beforeEach(() => {
    setEqualWidthDays(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    chart = init(container)!;
    store = (chart as unknown as { _chartStore: Store })._chartStore;
    // The broker's bars: UTC days (every day, so every weekday is a column)
    // and Monday weeks, over all the days these tests load.
    setSlotAnchors(chart, "broker", utcAnchors(Array.from({ length: 40 }, (_, d) => D0 - 7 * DAY + d * DAY)));
    store._addData(days(10, 20), "init", true);
    chart.setBarSpace(20); // about 40 slots wide, so the centre is mid-data
    store.setLastBarRightSideDiffBarCount(-30); // scrolled back
  });
  afterEach(() => {
    setEqualWidthDays(false);
    dispose(container);
    container.remove();
  });
  // The candle at the middle of the view: when a day widens, it is the one
  // that stays put (the rest spread out around it).
  const centreTs = () => {
    const s = store as unknown as { coordinateToFloatIndex(x: number): number; _totalBarSpace: number };
    return store.getDataList()[Math.round(s.coordinateToFloatIndex(s._totalBarSpace / 2))].timestamp;
  };
  const xOfTs = (ts: number) => store.dataIndexToCoordinate(store.getDataList().findIndex((b) => b.timestamp === ts));

  it("a live candle after a missing hour does not slide the view", () => {
    const ts = centreTs();
    const x = xOfTs(ts);
    // Day 20 opens at 15:00: the 14:00 slot is empty.
    store._addData(bar(D0 + 20 * DAY + 15 * H), "update");
    expect(xOfTs(ts)).toBe(x);
  });

  it("older history that widens the day does not slide the view", () => {
    const ts = centreTs();
    const x = xOfTs(ts);
    // Older days open at 13:00, one slot earlier than any loaded day.
    store._addData(days(5, 10, 13), "forward", true);
    expect(xOfTs(ts)).toBe(x);
  });

  it("registering day starts keeps the centre candle in place", () => {
    // FX-like: hourly round the clock except the 22:00 pause, two weeks.
    const fx: KLineData[] = [];
    for (let t = D0 - DAY + 23 * H; t <= D0 + 11 * DAY + 21 * H; t += H) {
      const start = Math.floor((t - 22 * H) / DAY) * DAY + 22 * H; // broker day start
      const wd = new Date(start + 12 * H).getUTCDay();
      if (new Date(t).getUTCHours() !== 22 && wd !== 0 && wd !== 6) fx.push(bar(t));
    }
    store._addData(fx, "init", true);
    store.setLastBarRightSideDiffBarCount(-30);
    const before = slotGridFor(store.getDataList())!.perDay;
    const ts = centreTs();
    const x = xOfTs(ts);
    // The broker's bars arrive saying its days start at 22:00.
    const utc = utcAnchors(Array.from({ length: 40 }, (_, d) => D0 - 7 * DAY + d * DAY));
    const dayStarts = Array.from({ length: 13 }, (_, d) => D0 - 2 * DAY + d * DAY + 22 * H);
    setSlotAnchors(chart, "broker", { dayStarts, weekStarts: utc.weekStarts });
    expect(slotGridFor(store.getDataList())!.perDay).not.toBe(before);
    expect(xOfTs(ts)).toBe(x);
    // And back, again without sliding the view.
    setSlotAnchors(chart, "broker", utc);
    expect(slotGridFor(store.getDataList())!.perDay).toBe(before);
    expect(xOfTs(ts)).toBe(x);
  });

  it("the broker's starts arriving from the source keep the centre candle in place", async () => {
    // Day 18 opens late, after the centre: the grid adds an empty slot there.
    store._addData([...days(10, 18), ...days(18, 19, 15), ...days(19, 20)], "init", true);
    const utc = utcAnchors(Array.from({ length: 40 }, (_, d) => D0 - 7 * DAY + d * DAY));
    let answer!: (a: typeof utc) => void;
    setSlotSource(chart, () => new Promise((r) => (answer = r))); // drops the starts: no grid
    store.setLastBarRightSideDiffBarCount(-30);
    expect(slotGridFor(store.getDataList())).toBeNull();
    const ts = centreTs();
    const x = xOfTs(ts);
    answer(utc);
    await new Promise((r) => setTimeout(r, 0));
    expect(slotGridFor(store.getDataList())).not.toBeNull();
    expect(xOfTs(ts)).toBe(x);
  });

  it("turning Time gaps on keeps the centre candle in place", () => {
    setEqualWidthDays(false);
    // Day 18 opens late, after the centre: turning on adds an empty slot there.
    store._addData([...days(10, 18), ...days(18, 19, 15), ...days(19, 20)], "init", true);
    store.setLastBarRightSideDiffBarCount(-30);
    const ts = centreTs();
    const x = xOfTs(ts);
    relayoutSlots(chart, () => setEqualWidthDays(true));
    expect(slotGridFor(store.getDataList())).not.toBeNull();
    expect(xOfTs(ts)).toBe(x);
  });

  it("newer history appended at the right does not slide the view", () => {
    const ts = centreTs();
    const x = xOfTs(ts);
    store._addData(days(20, 22, 13), "backward", false);
    expect(xOfTs(ts)).toBe(x);
  });
});
