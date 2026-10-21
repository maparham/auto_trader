import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetEarningsCache,
  barsPerMs,
  earningsView,
  fetchEarnings,
  projectEarningsMarkers,
  revenueText,
  type Earnings,
} from "./earnings";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 27); // Mon 27 Jul 2026
const days = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * DAY }));
const reported: Earnings = {
  timeMs: T0 + 3 * DAY + 20 * 3_600_000,
  epsEstimate: 1.89,
  epsActual: 2.02,
  surprisePct: 6.74,
  revenueEstimate: null,
  revenueActual: 109.417e9,
  session: "post",
  sessionTime: "16:00 EDT",
};
const upcoming = (offsetDays: number): Earnings => ({
  timeMs: T0 + offsetDays * DAY,
  epsEstimate: 1.98,
  epsActual: null,
  surprisePct: null,
  revenueEstimate: 113.357e9,
  revenueActual: null,
  session: null,
  sessionTime: null,
});
// One bar per 10px, bar i at x = 10 * i.
const toX = (ts: number) => ((ts - T0) / DAY) * 10;

describe("earningsView", () => {
  it("lays a reported quarter out as estimate vs actual with the surprise", () => {
    expect(earningsView(reported)).toEqual({
      date: "30 Jul 2026",
      status: "Reported",
      session: "After close (16:00 EDT)",
      rows: [
        { label: "EPS", estimate: "1.89", actual: "2.02" },
        { label: "Revenue", estimate: null, actual: "109.4B" },
      ],
      hasActual: true,
      surprise: { text: "+6.7%", tone: "pos" },
    });
  });

  it("lays an upcoming report out as estimates only", () => {
    expect(earningsView(upcoming(5), T0)).toEqual({
      date: "1 Aug 2026",
      status: "Upcoming",
      session: null,
      rows: [
        { label: "EPS", estimate: "1.98", actual: null },
        { label: "Revenue", estimate: "113.4B", actual: null },
      ],
      hasActual: false,
      surprise: null,
    });
  });

  it("says Today for an unreported report due on today's date", () => {
    expect(earningsView(upcoming(5), T0 + 5 * DAY + 3_600_000).status).toBe("Today");
    expect(earningsView(upcoming(5), T0 + 4 * DAY).status).toBe("Upcoming");
    expect(earningsView(reported, reported.timeMs).status).toBe("Reported");
  });

  it("drops a row Yahoo has nothing for", () => {
    const v = earningsView({ ...upcoming(5), revenueEstimate: null });
    expect(v.rows.map((r) => r.label)).toEqual(["EPS"]);
    expect(earningsView({ ...upcoming(5), epsEstimate: null, revenueEstimate: null }).rows).toEqual([]);
  });

  it("tones a miss negative without a plus", () => {
    expect(earningsView({ ...reported, epsActual: 1.8, surprisePct: -4.76 }).surprise).toEqual({
      text: "-4.8%",
      tone: "neg",
    });
  });

  it("names each session", () => {
    expect(earningsView({ ...upcoming(5), session: "pre" }).session).toBe("Before open");
    expect(earningsView({ ...upcoming(5), session: "intraday" }).session).toBe("During market hours");
    expect(earningsView({ ...upcoming(5), session: "pre", sessionTime: "09:30 EST" }).session).toBe(
      "Before open (09:30 EST)",
    );
  });

  it("scales revenue to T, B or M", () => {
    expect(revenueText(1.234e12)).toBe("1.2T");
    expect(revenueText(950e6)).toBe("950.0M");
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
            { time: 1793649600, epsEstimate: 1.98, epsActual: null, surprisePct: null, revenueEstimate: 113.4e9, session: "bogus" },
            { time: 1785441600, epsEstimate: 1.89, epsActual: 2.02, surprisePct: 6.74, revenueActual: 109.4e9, session: "post", sessionTime: "16:00 EDT" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchEarnings("AAPL", "yfinance")).toEqual([
      { timeMs: 1785441600_000, epsEstimate: 1.89, epsActual: 2.02, surprisePct: 6.74, revenueEstimate: null, revenueActual: 109.4e9, session: "post", sessionTime: "16:00 EDT" },
      { timeMs: 1793649600_000, epsEstimate: 1.98, epsActual: null, surprisePct: null, revenueEstimate: 113.4e9, revenueActual: null, session: null, sessionTime: null },
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
