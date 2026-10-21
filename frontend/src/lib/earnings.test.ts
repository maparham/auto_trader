import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetEarningsCache,
  barsPerMs,
  earningsLines,
  fetchEarnings,
  projectEarningsMarkers,
  type Earnings,
} from "./earnings";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 27); // Mon 27 Jul 2026
const days = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * DAY }));
const reported: Earnings = { timeMs: T0 + 3 * DAY + 20 * 3_600_000, epsEstimate: 1.89, epsActual: 2.02, surprisePct: 6.74 };
const upcoming = (offsetDays: number): Earnings => ({
  timeMs: T0 + offsetDays * DAY,
  epsEstimate: 1.98,
  epsActual: null,
  surprisePct: null,
});
// One bar per 10px, bar i at x = 10 * i.
const toX = (ts: number) => ((ts - T0) / DAY) * 10;

describe("earningsLines", () => {
  it("reads a reported quarter as date, Reported, est, actual, surprise", () => {
    expect(earningsLines(reported)).toEqual([
      "Earnings 30 Jul 2026",
      "Reported",
      "EPS est 1.89",
      "EPS actual 2.02",
      "Surprise +6.7%",
    ]);
  });

  it("reads an upcoming report as Estimated with only the estimate", () => {
    expect(earningsLines(upcoming(5))).toEqual(["Earnings 1 Aug 2026", "Estimated", "EPS est 1.98"]);
    expect(earningsLines({ ...upcoming(5), epsEstimate: null })).toEqual([
      "Earnings 1 Aug 2026",
      "Estimated",
    ]);
  });

  it("signs a miss without a plus", () => {
    expect(earningsLines({ ...reported, epsActual: 1.8, surprisePct: -4.76 }).at(-1)).toBe("Surprise -4.8%");
  });
});

describe("barsPerMs", () => {
  it("measures bar density over the window", () => {
    expect(barsPerMs(days(5))).toBeCloseTo(1 / DAY);
    expect(barsPerMs(days(1))).toBeNull();
  });
});

describe("projectEarningsMarkers", () => {
  const bars = days(10);
  const all = { from: 0, to: 9 };
  const run = (e: Earnings[], paneW = 500, avoid: number[] = []) =>
    projectEarningsMarkers(e, bars, DAY, all, toX, 10, paneW, 14, avoid);

  it("puts a reported date on the bar that holds it", () => {
    const [m] = run([reported]);
    expect(m.x).toBe(30);
    expect(m.upcoming).toBe(false);
    expect(m.lift).toBe(false);
  });

  it("puts an upcoming date past the last bar by bar density", () => {
    // Last bar is day 9 at x=90; day 13 is 4 bars further.
    const [m] = run([upcoming(13)]);
    expect(m.x).toBe(130);
    expect(m.upcoming).toBe(true);
  });

  it("skips an upcoming date the future space cannot reach", () => {
    expect(run([upcoming(13)], 120)).toEqual([]);
  });

  it("drops a past date outside the visible bars", () => {
    expect(projectEarningsMarkers([reported], bars, DAY, { from: 5, to: 9 }, toX, 10, 500, 14)).toEqual([]);
  });

  it("never puts a reported row past the last bar", () => {
    expect(run([{ ...reported, timeMs: T0 + 20 * DAY }])).toEqual([]);
  });

  it("lifts a chip that would sit on a split chip", () => {
    expect(run([reported], 500, [34])[0].lift).toBe(true);
    expect(run([reported], 500, [60])[0].lift).toBe(false);
  });
});

describe("fetchEarnings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetEarningsCache();
  });

  it("maps the payload to ms, sorted, and memoizes per broker and epic", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          epic: "AAPL",
          earnings: [
            { time: 1793649600, epsEstimate: 1.98, epsActual: null, surprisePct: null },
            { time: 1785441600, epsEstimate: 1.89, epsActual: 2.02, surprisePct: 6.74 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchEarnings("AAPL", "yfinance")).toEqual([
      { timeMs: 1785441600_000, epsEstimate: 1.89, epsActual: 2.02, surprisePct: 6.74 },
      { timeMs: 1793649600_000, epsEstimate: 1.98, epsActual: null, surprisePct: null },
    ]);
    await fetchEarnings("AAPL", "yfinance");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/market/AAPL/earnings?broker=yfinance");
  });

  it("answers [] on failure and does not cache it", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchEarnings("AAPL", "yfinance")).toEqual([]);
    await fetchEarnings("AAPL", "yfinance");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
