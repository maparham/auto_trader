import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("klinecharts", () => ({ registerOverlay: () => {}, registerIndicator: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));
const src: { bt: unknown; armed: unknown; account: string | null } = { bt: null, armed: null, account: null };
vi.mock("../persist/defaults", () => ({ loadBacktestLastUsed: vi.fn(() => src.bt) }));
vi.mock("../liveEngine", () => ({ loadArmed: vi.fn(() => src.armed), loadArmedAccount: vi.fn(() => src.account) }));
import { PickedLineClones, pickedLineCloneTemplate, wantedClones } from "./pickedLineClones";
import { loadBacktestLastUsed } from "../persist/defaults";

const L = { epic: "US100", broker: "capital", timeframe: "HOUR", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };
// A holder whose rule text names each of its lines, as a real holder would.
const refs = (lines: Record<string, unknown>) => Object.keys(lines).map((id) => `candle.close > ${id}`);
const holds = (lines: Record<string, unknown>) => ({
  lines, longEntry: { combine: "AND", rules: refs(lines).map((expr) => ({ expr, enabled: true })) },
});

it("dedupes the same line across holders and joins labels", () => {
  const w = wantedClones("US100", "capital", [{ lines: { L1: L } }, { lines: { L2: { ...L, tRef: 9, pRef: 9 } } }]);
  expect([...w.values()].map((x) => x.label)).toEqual(["L1 · L2"]);
});
it("skips other symbols and brokers", () => {
  expect(wantedClones("GOLD", "capital", [{ lines: { L1: L } }]).size).toBe(0);
  expect(wantedClones("US100", "ig", [{ lines: { L1: L } }]).size).toBe(0);
});
it("does not repeat an id two holders share for one line", () => {
  const w = wantedClones("US100", "capital", [{ lines: { L1: L } }, { lines: { L1: L } }, {}]);
  expect([...w.values()].map((x) => x.label)).toEqual(["L1"]);
});

// Pixel space is (timestamp, -value), as in indicatorAlerts.test.ts.
function fakeChart(bars = [1, 2, 3, 4, 5]) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    chart: {
      convertToPixel: (pts: Array<{ timestamp: number; value: number }>) => pts.map((q) => ({ x: q.timestamp, y: -q.value })),
      convertFromPixel: (pts: Array<{ x: number; y: number }>) => pts.map((q) => ({ timestamp: q.x, value: -q.y })),
      getDataList: () => bars.map((timestamp) => ({ timestamp })),
      createOverlay: vi.fn((o: Record<string, unknown>) => { created.push(o); return o.id as string; }),
      removeOverlay: vi.fn(),
      overrideOverlay: vi.fn(),
    },
  };
}

describe("PickedLineClones", () => {
  beforeEach(() => {
    src.bt = null; src.armed = null; src.account = null;
    vi.mocked(loadBacktestLastUsed).mockClear();
  });

  it("draws one locked dashed clone per held line on the line's own timeframe, cut at the last bar", () => {
    src.bt = holds({ L1: L });
    src.account = "capital:demo";
    src.armed = { cfg: holds({ L3: L }) };
    const { chart, created } = fakeChart();
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "pickedLineClone", lock: true, extendData: "L1 · L3" });
    // Through tRef (3,3) with slope 1 per bar, from anchor1 to the last bar.
    expect(created[0].points).toEqual([{ timestamp: 1, value: 1 }, { timestamp: 5, value: 5 }]);
    const pd = vi.fn();
    (created[0].onRightClick as (e: { preventDefault: () => void }) => boolean)({ preventDefault: pd });
    expect(pd).toHaveBeenCalled();
  });

  it("draws a line held on another timeframe through its time-anchored points", () => {
    // Slope 5 per H4 bar: counted in H1 bars it would be wrong, so the anchors
    // (1,1)-(2,2) carry it to the last bar instead.
    src.bt = holds({ L1: { ...L, timeframe: "HOUR_4", slope: 5 } });
    const { chart, created } = fakeChart();
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0].points).toEqual([{ timestamp: 1, value: 1 }, { timestamp: 5, value: 5 }]);
  });

  it("refresh does not touch an unchanged clone or re-read the holders", () => {
    src.bt = holds({ L1: L });
    const { chart } = fakeChart();
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    const reads = vi.mocked(loadBacktestLastUsed).mock.calls.length;
    c.refresh();
    c.refresh();
    expect(chart.createOverlay).toHaveBeenCalledTimes(1);
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
    expect(vi.mocked(loadBacktestLastUsed).mock.calls.length).toBe(reads);
  });

  it("follows a new last bar, relabels, and drops a clone no holder keeps", () => {
    src.bt = holds({ L1: L });
    const bars = [1, 2, 3, 4, 5];
    const { chart } = fakeChart(bars);
    chart.getDataList = () => bars.map((timestamp) => ({ timestamp }));
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    bars.push(6);
    c.refresh();
    expect(chart.overrideOverlay).toHaveBeenLastCalledWith({
      id: expect.stringMatching(/^pickline:/), points: [{ timestamp: 1, value: 1 }, { timestamp: 6, value: 6 }], extendData: "L1",
    });
    src.account = "capital:demo";
    src.armed = { cfg: holds({ L2: L }) };
    c.reconcile();
    expect(chart.overrideOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ extendData: "L1 · L2" }));
    src.bt = null; src.armed = null;
    c.reconcile();
    expect(chart.removeOverlay).toHaveBeenCalledTimes(1);
  });

  it("draws only the lines each holder's own rule text references", () => {
    // The config keeps L2 after its rule was deleted; only L1 is still named.
    src.bt = { lines: { L1: L, L2: { ...L, p1: 7 } }, longEntry: { combine: "AND", rules: [{ expr: "candle.close > L1", enabled: false }] } };
    // The armed snapshot names nothing.
    src.account = "capital:demo";
    src.armed = { cfg: { lines: { L3: { ...L, p1: 8 } } } };
    const { chart, created } = fakeChart();
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    expect(created.map((o) => o.extendData)).toEqual(["L1"]);
  });

  it("drops its clones from the old chart when the epic changes", () => {
    src.bt = holds({ L1: L });
    const { chart } = fakeChart();
    const c = new PickedLineClones();
    c.attach(chart as never, "capital", "US100", "HOUR");
    c.reconcile();
    c.attach(chart as never, "capital", "GOLD", "HOUR");
    expect(chart.removeOverlay).toHaveBeenCalledTimes(1);
    c.reconcile();
    expect(chart.createOverlay).toHaveBeenCalledTimes(1);
  });
});

describe("pickedLineClone template", () => {
  const draw = (coordinates: Array<{ x: number; y: number }>, extendData: unknown = "L1") =>
    pickedLineCloneTemplate.createPointFigures!({
      overlay: { extendData, styles: {} }, coordinates, bounding: { width: 800, height: 400 },
    } as never) as Array<{ type: string; attrs: Record<string, unknown> }>;

  it("strokes the segment and labels its right end", () => {
    const f = draw([{ x: 100, y: 200 }, { x: 500, y: 100 }]);
    expect(f.map((x) => x.type)).toEqual(["line", "text"]);
    expect(f[1].attrs).toMatchObject({ x: 504, y: 100, text: "L1" });
  });

  it("clips a stroke running far off the pane and drops the off-pane label", () => {
    const f = draw([{ x: 100, y: 200 }, { x: 1e7, y: -1e7 }]);
    expect(f.map((x) => x.type)).toEqual(["line"]);
    const [a, b] = f[0].attrs.coordinates as Array<{ x: number; y: number }>;
    expect(Math.max(Math.abs(a.x), Math.abs(b.x), Math.abs(a.y), Math.abs(b.y))).toBeLessThan(5000);
  });

  it("draws nothing when the segment misses the pane, and never throws", () => {
    expect(draw([{ x: -9e6, y: 0 }, { x: -8e6, y: 0 }])).toEqual([]);
    expect(draw([{ x: 1, y: 1 }])).toEqual([]);
    expect(() => pickedLineCloneTemplate.createPointFigures!(null as never)).not.toThrow();
  });
});
