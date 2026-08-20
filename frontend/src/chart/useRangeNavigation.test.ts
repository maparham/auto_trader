// jsdom, not the suite's default node env: this module imports klinecharts,
// which touches `window` at import time.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRangeToken, useRangeNavigation } from "./useRangeNavigation";
import type { RangeReq } from "./chartHandle";

// The jump's short-history warning is a toast; spy on it rather than the DOM.
const toastSpy = vi.fn();
vi.mock("../lib/notify", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

beforeEach(() => toastSpy.mockClear());

describe("buildRangeToken", () => {
  it("pads a narrow match so the surroundings are visible", () => {
    const t = buildRangeToken({
      fromTs: 1_700_000_000, toTs: 1_700_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    const span = t.toTs - t.fromTs;
    expect(span).toBeGreaterThan((1_700_000_900 - 1_700_000_000) * 1000);
    expect(t.fromTs).toBeLessThan(1_700_000_000_000);
    expect(t.toTs).toBeGreaterThan(1_700_000_900_000);
  });

  it("centres the padded window on the match", () => {
    const t = buildRangeToken({
      fromTs: 1_700_000_000, toTs: 1_700_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    const mid = (t.fromTs + t.toTs) / 2;
    expect(mid).toBe((1_700_000_000_000 + 1_700_000_900_000) / 2);
  });

  it("carries the series identity so a stale walk can be detected", () => {
    const t = buildRangeToken({
      fromTs: 1, toTs: 2, resolution: "HOUR", epic: "GOLD", broker: "dukascopy", side: "mid",
    });
    expect(t).toMatchObject({ resolution: "HOUR", epic: "GOLD", broker: "dukascopy", side: "mid" });
  });

  it("carries no page budget: the jump covers in parallel before the walk", () => {
    // It used to ask for 40 sequential pages (20,000 bars), which was really a
    // bound on how long the chart froze and put anything older out of reach.
    // goToRange now covers the gap with concurrent windows first, so by the
    // time this token's walk runs there is nothing left for it to page.
    const t = buildRangeToken({
      fromTs: 1_600_000_000, toTs: 1_600_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    expect(t.maxPages).toBeUndefined();
  });

  it("asks to be centred, not fitted, so a jump keeps the current zoom", () => {
    const t = buildRangeToken({
      fromTs: 1_600_000_000, toTs: 1_600_000_900,
      resolution: "MINUTE_5", epic: "US100", broker: "capital", side: "bid",
    });
    expect(t.fit).toBe("center");
  });
});

// --- the landing branch, exercised for real ---------------------------------
// useRangeNavigation calls no React hooks, so it can be invoked as a plain
// function and its ensureCoverageAndFit read straight off the bridge ref. Both
// landings are injectable deps, so the assertion is on BEHAVIOUR (which one ran)
// rather than on a token field restating its own type.
const LAST_BAR = 1_700_000_000_000; // the newest loaded bar in the fixture

function harness() {
  const fitVisibleRange = vi.fn();
  const scrollTsToCenter = vi.fn();
  const chart = { getDataList: () => [{ timestamp: LAST_BAR - 60_000 }, { timestamp: LAST_BAR }] };
  const handle = {
    chartRef: { current: chart },
    pendingRangeRef: { current: null as RangeReq | null },
    launchedTokenRef: { current: null as RangeReq | null },
    epicRef: { current: "US100" },
    brokerIdRef: { current: "capital" },
    priceSideRef: { current: "bid" },
    resRef: { current: "MINUTE_5" },
    loadingRef: { current: false },
    cursorSecRef: { current: 0 },
    exhaustedRef: { current: false },
    separatorTsRef: { current: null },
    ensureCoverageAndFitRef: { current: null },
    ensureAnchorCoverageRef: { current: null },
    overlays: { applyOlderBars: () => {} },
  };
  const deps = {
    pageHistoryBack: async () => "reached",
    pageBars: 500,
    fitVisibleRange,
    scrollTsToCenter,
    extendMtfCoverage: () => {},
    coverHistoryTo: async () => true,
    scope: "tab.A",
    symbol: { epic: "US100" },
    brokerId: "capital",
    priceSide: "bid",
    period: { resolution: "MINUTE_5" },
    timezone: "UTC",
    cellId: "cell.A",
    setActiveRange: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useRangeNavigation(handle as any, deps as any);
  const run = async (token: RangeReq) => {
    handle.pendingRangeRef.current = token;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handle.ensureCoverageAndFitRef.current as any)(token);
  };
  return { run, fitVisibleRange, scrollTsToCenter };
}

const baseToken = (over: Partial<RangeReq> = {}): RangeReq => ({
  resolution: "MINUTE_5",
  fromTs: LAST_BAR - 600_000,
  toTs: LAST_BAR + 300_000, // past the last bar, so the walk's clamp bites
  epic: "US100", broker: "capital", side: "bid",
  ...over,
});

describe("ensureCoverageAndFit landing", () => {
  it("fits a token with no fit mode, and does not scroll", async () => {
    const { run, fitVisibleRange, scrollTsToCenter } = harness();
    await run(baseToken());
    expect(fitVisibleRange).toHaveBeenCalledTimes(1);
    expect(scrollTsToCenter).not.toHaveBeenCalled();
  });

  it("scrolls a fit:center token, and does not fit", async () => {
    const { run, fitVisibleRange, scrollTsToCenter } = harness();
    await run(baseToken({ fit: "center" }));
    expect(scrollTsToCenter).toHaveBeenCalledTimes(1);
    expect(fitVisibleRange).not.toHaveBeenCalled();
  });

  it("centres on the token's own midpoint, not the window the clamp slid back", async () => {
    // The walk slides its window back to end at the last bar before paging, so
    // near the live edge the covered window sits EARLIER than the token asked
    // for. Fitting that is right (you fit what you covered); centring on it
    // would drop the viewport up to 3x the match span before the match, which
    // with the user's own zoom can leave the match off screen entirely.
    const token = baseToken({ fit: "center" });
    const { run, scrollTsToCenter } = harness();
    await run(token);
    const clampedTo = LAST_BAR;
    const clampedFrom = clampedTo - (token.toTs - token.fromTs);
    expect(scrollTsToCenter.mock.calls[0][1]).toBe(Math.round((token.fromTs + token.toTs) / 2));
    expect(scrollTsToCenter.mock.calls[0][1]).not.toBe(Math.round((clampedFrom + clampedTo) / 2));
  });

  it("fits the CLAMPED window, which is still what the old callers get", async () => {
    const token = baseToken();
    const { run, fitVisibleRange } = harness();
    await run(token);
    const clampedTo = LAST_BAR;
    const clampedFrom = clampedTo - (token.toTs - token.fromTs);
    expect(fitVisibleRange.mock.calls[0].slice(1)).toEqual([clampedFrom, clampedTo]);
  });
});

// --- the short-history warning on a jump ------------------------------------
// goToRange warns when the walk settles short of where the click was headed.
// "Short" has to mean the MATCH, not the padded coverage window: buildRangeToken
// asks for 3x the match span of context on each side, which is a nice-to-have,
// while the match itself is the thing the user clicked.
function jumpHarness(oldestMs: number) {
  type CoverOpts = {
    owner?: RangeReq | null;
    maxWindows?: number;
    onWindowError?: () => void;
  };
  const coverHistoryTo =
    vi.fn<(fromTs: number, opts?: CoverOpts) => Promise<boolean>>(async () => true);
  const chart = { getDataList: () => [{ timestamp: oldestMs }, { timestamp: LAST_BAR }] };
  const handle = {
    chartRef: { current: chart },
    pendingRangeRef: { current: null as RangeReq | null },
    launchedTokenRef: { current: null as RangeReq | null },
    epicRef: { current: "US100" },
    brokerIdRef: { current: "capital" },
    priceSideRef: { current: "bid" },
    resRef: { current: "MINUTE_5" },
    loadingRef: { current: false },
    cursorSecRef: { current: 0 },
    exhaustedRef: { current: false },
    separatorTsRef: { current: null },
    ensureCoverageAndFitRef: { current: null },
    ensureAnchorCoverageRef: { current: null },
    overlays: { applyOlderBars: () => {} },
  };
  const deps = {
    pageHistoryBack: async () => "reached", // budget spent, nothing more to page
    pageBars: 500,
    fitVisibleRange: () => {},
    scrollTsToCenter: () => {},
    extendMtfCoverage: () => {},
    coverHistoryTo,
    scope: "tab.A",
    symbol: { epic: "US100" },
    brokerId: "capital",
    priceSide: "bid",
    period: { resolution: "MINUTE_5" },
    timezone: "UTC",
    cellId: "cell.A",
    setActiveRange: () => {},
  };
  // Not a component: the hook calls no React hooks of its own (see the note on
  // the harness above), so it runs as a plain function here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, react-hooks/rules-of-hooks
  const { goToRange } = useRangeNavigation(handle as any, deps as any);
  // The walk clears the pending token when it settles — the signal that the
  // .then branch (and so the warning decision) has actually run.
  const settled = () => handle.pendingRangeRef.current === null;
  return { goToRange, settled, coverHistoryTo, handle };
}

describe("goToRange deep-history handling", () => {
  const MIN = 60_000;
  // A 20-minute match, 100 minutes behind the last bar. buildRangeToken pads it
  // by 3x the span each side, so the token reaches 150 minutes back.
  const matchFromSec = (LAST_BAR - 100 * MIN) / 1000;
  const matchToSec = (LAST_BAR - 80 * MIN) / 1000;

  it("stays quiet when the match itself is loaded, even if the padding is not", async () => {
    // Oldest bar sits between the token's padded edge (-150m) and the match
    // (-100m): every matched bar is on screen, so the jump landed. Warning here
    // would call a perfect jump broken.
    const { goToRange, settled } = jumpHarness(LAST_BAR - 120 * MIN);
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(settled()).toBe(true));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("warns when the walk stopped short of the match itself", async () => {
    const { goToRange, settled } = jumpHarness(LAST_BAR - 60 * MIN); // newer than the match
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(settled()).toBe(true));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    // Coalesced by key, so repeat clicks on the same dead end don't stack.
    expect(toastSpy.mock.calls[0][1]).toMatchObject({ key: expect.any(String) });
  });

  it("covers the padded window in parallel, owned by the parked token", async () => {
    // The parallel cover is the whole point: it takes the target up front, so
    // the sequential walk that follows has nothing to page. It must be asked
    // for the PADDED edge (anything left over is walked one request at a
    // time), and it must be handed the parked token as its owner, so clicking
    // the next match down the list preempts this cover instead of racing it.
    const { goToRange, settled, coverHistoryTo } = jumpHarness(LAST_BAR - 120 * MIN);
    goToRange(matchFromSec, matchToSec);
    const [askedFrom, opts] = coverHistoryTo.mock.calls[0]!;
    const parked = opts!.owner as RangeReq;
    expect(parked.fit).toBe("center");
    expect(askedFrom).toBe(parked.fromTs);
    expect(opts!.maxWindows).toBeGreaterThan(400);
    await vi.waitFor(() => expect(settled()).toBe(true));
  });

  it("says to try again, not that the history is missing, when a fetch failed", async () => {
    // A cold span the broker serves slower than the client's 10s deadline
    // throws, and the cover truncates at it. Reporting that as "older than the
    // history available at this timeframe" tells the user data that exists does
    // not, and sends them to a coarser timeframe for a problem a retry fixes.
    const { goToRange, settled, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    coverHistoryTo.mockImplementation(async (_fromTs, opts) => {
      opts?.onWindowError?.();
      return false;
    });
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(settled()).toBe(true));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toMatch(/try that match again/i);
  });

  it("leaves the landing to whoever preempted it", async () => {
    // A click on the next match parks its own token while this cover is in
    // flight. The stale jump must not fit, and must not toast about a history
    // depth that is no longer its business.
    const { goToRange, coverHistoryTo, handle } = jumpHarness(LAST_BAR - 60 * MIN);
    coverHistoryTo.mockImplementation(async () => {
      handle.pendingRangeRef.current = { resolution: "MINUTE_5" } as RangeReq;
      return false;
    });
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(coverHistoryTo).toHaveBeenCalled());
    await Promise.resolve();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
