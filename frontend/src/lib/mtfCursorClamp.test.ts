// The higher-timeframe no-lookahead clamp: a replaying cell must not let an
// indicator pinned to a higher timeframe read a bucket that has not closed at
// the cursor. The backend serves the bucket CONTAINING the chart's newest bar
// fully aggregated (it is in the past as far as the API is concerned), so
// without this an EMA pinned to 1H on a 15m replay would read a whole hour the
// user has not reached.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Chart, KLineData } from "klinecharts";

// The indicator templates pulled in via customIndicators read klinecharts enums
// at module load; stub the runtime surface like mtfCoordinator.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

// Controlled HTF fetch, so an apply* can be driven end to end.
const fetchRangeStrict = vi.fn<(...args: unknown[]) => Promise<KLineData[]>>();
const RES_SECONDS: Record<string, number> = { MINUTE_15: 900, HOUR: 3600, DAY: 86_400 };
// Pin aliases, the way feed's nominalBarHours falls through to expr/catalog's
// tfSeconds — an alias must score a real width, not 0.
const ALIAS_SECONDS: Record<string, number> = { "1H": 3600, D: 86_400 };
vi.mock("./feed", () => ({
  fetchRangeStrict: (...args: unknown[]) => fetchRangeStrict(...args),
  RESOLUTION_SECONDS: RES_SECONDS,
  nominalBarHours: (res: string) => {
    const secs = RES_SECONDS[res] ?? ALIAS_SECONDS[res];
    return secs ? secs / 3600 : null;
  },
}));

const { clampHtfBars, mtfBucketMs, setHtfCursorClamp, applyMaTimeframe } =
  await import("./mtfCoordinator");

const HOUR = 3_600_000;
const bar = (ts: number): KLineData => ({ timestamp: ts, open: 1, high: 2, low: 0, close: 1 });
const T = Date.UTC(2026, 2, 2, 12);

describe("clampHtfBars", () => {
  const htf = [0, 1, 2, 3].map((i) => bar(T + i * HOUR));

  it("drops the higher-timeframe bar still forming at the cursor", () => {
    // Cursor known through 14:30 — the 14:00 hourly bar has NOT closed.
    const out = clampHtfBars(htf, T + 2.5 * HOUR, HOUR);
    expect(out.map((b) => b.timestamp)).toEqual([T, T + HOUR]);
  });

  it("keeps a bar that closes exactly at the cursor", () => {
    expect(clampHtfBars(htf, T + 2 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([T, T + HOUR]);
  });

  it("is a no-op when not replaying (cursor 0)", () => {
    expect(clampHtfBars(htf, 0, HOUR)).toHaveLength(4);
  });

  it("drops everything when the cursor precedes the first close", () => {
    expect(clampHtfBars(htf, T + HOUR / 2, HOUR)).toEqual([]);
  });

  it("closes the NEWEST bar on the nominal width, having no successor", () => {
    // The production shape: the last bar fetched IS the bucket the cursor sits
    // in, so this branch of barCloseMs is the one that decides the clamp.
    const two = [bar(T), bar(T + HOUR)];
    expect(clampHtfBars(two, T + 1.5 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([T]);
    // ...and it is released the instant the cursor reaches that close.
    expect(clampHtfBars(two, T + 2 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([T, T + HOUR]);
  });
});

// The refresh trigger: the set of CLOSED higher-timeframe bars can only change
// when the cursor crosses a bucket boundary, so the smallest pinned bucket is
// what a replaying cell re-fetches on.
const chartWith = (indicators: Array<{ name: string; extendData?: object }>): Chart =>
  ({
    getIndicators: () => indicators.map((i) => ({ paneId: "candle_pane", ...i })),
  }) as unknown as Chart;

describe("mtfBucketMs", () => {
  it("is 0 when nothing is pinned to a higher timeframe", () => {
    expect(mtfBucketMs(chartWith([{ name: "EMA", extendData: { mtf: { timeframe: null } } }]))).toBe(0);
    expect(mtfBucketMs(chartWith([{ name: "MACD" }]))).toBe(0);
  });

  it("is the SMALLEST pinned bucket, so no indicator refreshes late", () => {
    const chart = chartWith([
      { name: "EMA", extendData: { mtf: { timeframe: "DAY" } } },
      { name: "EMA2", extendData: { mtf: { timeframe: "HOUR" } } },
      { name: "MACD" },
    ]);
    expect(mtfBucketMs(chart)).toBe(HOUR);
  });

  it("resolves a pin ALIAS, not just a canonical resolution", () => {
    // A 0 here would switch the cursor-advance refresh off for the session.
    expect(mtfBucketMs(chartWith([{ name: "EMA", extendData: { mtf: { timeframe: "1H" } } }]))).toBe(
      HOUR,
    );
  });
});

// --- the clamp is actually WIRED into the fetch -----------------------------
//
// The pure cases above would all pass with the clamp never called. These drive a
// real applyMaTimeframe through fetchHtfBars and assert on what it STASHES, so
// removing the clamp from fetchHtfBars fails them.
const HTF_MS = 900_000; // MINUTE_15
const NEWEST_MS = 10_000_300_000; // the chart's newest (revealed) bar
// The bucket containing that bar — the one the backend serves fully aggregated
// and the replay must not read — plus the one before it.
const FORMING_BUCKET = Math.floor(NEWEST_MS / HTF_MS) * HTF_MS;
const CLOSED_BUCKET = FORMING_BUCKET - HTF_MS;

/** HTF bars on the real 15m grid, covering whatever window the pager asks for. */
const htfPage = (fromSec: number, toSec: number): KLineData[] => {
  const out: KLineData[] = [];
  for (let t = Math.floor((fromSec * 1000) / HTF_MS) * HTF_MS; t <= toSec * 1000; t += HTF_MS) {
    out.push(bar(t));
  }
  return out;
};

function fakeChart() {
  const overrides: Array<{ extendData?: { mtf?: { htfStarts?: number[] } } }> = [];
  let indicator: { extendData: object } = { extendData: {} };
  const chart = {
    getDataList: () => [bar(NEWEST_MS - 300_000), bar(NEWEST_MS)],
    getIndicators: () => [indicator],
    overrideIndicator: (patch: { extendData?: object }) => {
      overrides.push(patch);
      indicator = { extendData: patch.extendData ?? {} };
    },
  } as unknown as Chart;
  return { chart, overrides };
}

const applyEma = (chart: Chart) =>
  applyMaTimeframe(chart, "EPIC", "ema1", "candle_pane", { kind: "ema", length: 2, options: {} }, "MINUTE_15");

const stashedStarts = (overrides: Array<{ extendData?: { mtf?: { htfStarts?: number[] } } }>) =>
  overrides.at(-1)!.extendData!.mtf!.htfStarts!;

describe("fetchHtfBars applies the cursor clamp", () => {
  afterEach(() => {
    fetchRangeStrict.mockReset();
  });

  it("stops the stashed series before the bucket the cursor sits in", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    // Replaying: the market is known through the newest revealed bar's close.
    setHtfCursorClamp(chart, () => NEWEST_MS);
    await applyEma(chart);

    const starts = stashedStarts(overrides);
    expect(starts).toContain(CLOSED_BUCKET);
    expect(starts).not.toContain(FORMING_BUCKET); // the lookahead this exists to stop
    expect(starts.at(-1)).toBe(CLOSED_BUCKET);
  });

  it("stashes the full series again once the cell stops replaying", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    setHtfCursorClamp(chart, () => NEWEST_MS);
    await applyEma(chart);
    expect(stashedStarts(overrides)).not.toContain(FORMING_BUCKET);

    // Exiting the session must not leave a truncated series behind.
    setHtfCursorClamp(chart, null);
    await applyEma(chart);
    expect(stashedStarts(overrides).at(-1)).toBe(FORMING_BUCKET);
  });

  it("leaves a cell that is not replaying unclamped (reader reports 0)", async () => {
    fetchRangeStrict.mockImplementation((_e, _tf, fromSec, toSec) =>
      Promise.resolve(htfPage(fromSec as number, toSec as number)),
    );
    const { chart, overrides } = fakeChart();
    setHtfCursorClamp(chart, () => 0);
    await applyEma(chart);
    expect(stashedStarts(overrides).at(-1)).toBe(FORMING_BUCKET);
  });
});
