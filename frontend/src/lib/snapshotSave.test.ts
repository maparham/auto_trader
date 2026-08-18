// @vitest-environment jsdom
//
// A snapshot must never be taken of a REPLAYING chart.
//
// The record stores `readVisibleRange(chart)` — the real epoch milliseconds of
// the bars on screen, which during a session is the replayed slice. Restoring it
// opens a cell that is NOT replaying, so its axis uses the unmasked formatter and
// prints the exact dates the session is hiding, with the original session still
// sitting there resumable. Both entry points (the toolbar camera and the
// gallery's "Save current chart") funnel through saveSnapshotOfChart, so the
// guard belongs there rather than at either button.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const readVisibleRange = vi.hoisted(() => vi.fn(() => ({ fromTs: 1_700_000_000_000, toTs: 1_700_003_600_000 })));
vi.mock("./chartSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chartSync")>()),
  readVisibleRange,
}));

const makeChartThumbnail = vi.hoisted(() => vi.fn(async () => "data:image/png;base64,x"));
vi.mock("./snapshots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshots")>()),
  makeChartThumbnail,
}));

const { saveSnapshotOfChart } = await import("./snapshotSave");
const { registerReplayingChart } = await import("./backtest");
const { loadSnapshotIndex } = await import("./persist");

// saveSnapshotOfChart only ever passes the chart through to the mocked
// readVisibleRange / makeChartThumbnail and to the replay registry, which is
// keyed by object identity — so a bare token stands in for a klinecharts Chart.
const chart = {} as unknown as import("klinecharts").Chart;

const SYMBOL = { epic: "US100", name: "US 100", status: null } as const;
const PERIOD = { label: "1m", resolution: "MINUTE" } as const;

const save = () =>
  saveSnapshotOfChart(
    chart,
    "tab1.cellSnap",
    SYMBOL as unknown as import("./feed").Instrument,
    PERIOD as unknown as import("./feed").Period,
  );

beforeEach(() => {
  localStorage.clear();
  registerReplayingChart(chart, null);
});
afterEach(() => {
  registerReplayingChart(chart, null);
  vi.clearAllMocks();
});

describe("saveSnapshotOfChart", () => {
  it("saves normally when the chart is not replaying", async () => {
    const snap = await save();
    expect(snap).not.toBeNull();
    expect(loadSnapshotIndex()).toHaveLength(1);
  });

  it("refuses while the chart is replaying, and writes nothing", async () => {
    registerReplayingChart(chart, () => true);
    const snap = await save();
    expect(snap).toBeNull();
    expect(loadSnapshotIndex()).toHaveLength(0);
  });

  it("does not even read the visible range of a replaying chart", async () => {
    // The range IS the leak, so the guard sits above the read rather than
    // sanitising the value afterwards — there is no safe version of the record.
    registerReplayingChart(chart, () => true);
    await save();
    expect(readVisibleRange).not.toHaveBeenCalled();
    expect(makeChartThumbnail).not.toHaveBeenCalled();
  });

  it("saves again once the session has ended", async () => {
    registerReplayingChart(chart, () => true);
    expect(await save()).toBeNull();
    registerReplayingChart(chart, null); // session over, reader unregistered
    expect(await save()).not.toBeNull();
    expect(loadSnapshotIndex()).toHaveLength(1);
  });
});
