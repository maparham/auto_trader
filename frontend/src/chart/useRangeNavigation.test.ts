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
function jumpHarness(oldestMs: number, detached: { targetMs: number } | null = null) {
  type CoverOpts = {
    owner?: RangeReq | null;
    maxWindows?: number;
    onWindowError?: () => void;
    onWindowPartial?: (p: { done: number; total: number }) => void;
  };
  const coverHistoryTo =
    vi.fn<(fromTs: number, opts?: CoverOpts) => Promise<boolean>>(async () => true);
  const enterDetached = vi.fn<(targetMs: number) => void>();
  const exitDetached = vi.fn<() => void>();
  const onPeriod = vi.fn<(cellId: string, p: { resolution: string }) => void>();
  // getSize width 0 makes readVisibleRange bail to its 30-day fallback span, so
  // onGoToDate can run against this light mock without a real layout.
  const chart = {
    getDataList: () => [{ timestamp: oldestMs }, { timestamp: LAST_BAR }],
    getSize: () => ({ width: 0 }),
  };
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
    onPeriod,
    enterDetached,
    exitDetached,
    detached,
  };
  // Not a component: the hook calls no React hooks of its own (see the note on
  // the harness above), so it runs as a plain function here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, react-hooks/rules-of-hooks
  const { goToRange, onGoToDate, onRangePick } = useRangeNavigation(handle as any, deps as any);
  // The walk clears the pending token when it settles — the signal that the
  // .then branch (and so the warning decision) has actually run.
  const settled = () => handle.pendingRangeRef.current === null;
  return {
    goToRange,
    onGoToDate,
    onRangePick,
    settled,
    coverHistoryTo,
    enterDetached,
    exitDetached,
    onPeriod,
    handle,
  };
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

  // Three dead ends, three answers. Landing short because the backend is still
  // DOWNLOADING the gap is not the same as landing short because the history
  // ends there, and it used to be reported as the latter: "older than the
  // history available at this timeframe" over data that was on its way.
  it("says the history is still downloading, with how far it got", async () => {
    const { goToRange, settled, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    coverHistoryTo.mockImplementation(async (_from, opts) => {
      // Reported from inside the fetch each lane is awaiting, so the marker is
      // in hand by the time the cover resolves (the real pager awaits all its
      // lanes). The await here is what makes that ordering real in the test
      // rather than assumed.
      await Promise.resolve();
      // Six lanes on one series: the one doing the work reports progress, the
      // ones queued behind its lock report none. The furthest must win, or the
      // user is told 0 of 96 while a lane is nearly done.
      opts?.onWindowPartial?.({ done: 0, total: 96 });
      opts?.onWindowPartial?.({ done: 37, total: 96 });
      opts?.onWindowPartial?.({ done: 0, total: 96 });
      return true;
    });
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(settled()).toBe(true));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toContain("37 of 96");
    expect(toastSpy.mock.calls[0][0]).not.toContain("higher timeframe");
  });

  it("still blames the history itself when nothing was downloading", async () => {
    const { goToRange, settled } = jumpHarness(LAST_BAR - 60 * MIN);
    goToRange(matchFromSec, matchToSec);
    await vi.waitFor(() => expect(settled()).toBe(true));
    expect(toastSpy.mock.calls[0][0]).toContain("higher timeframe");
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
    // "the jump", not "that match": the same path now serves the calendar Go.
    expect(toastSpy.mock.calls[0][0]).toMatch(/try the jump again/i);
  });

  // The calendar Go used to only fit the already-loaded extent: landing in
  // whitespace left the scroll-back pager to fill a years-deep gap one 500-bar
  // request per second. It must ride the same parallel cover as a match jump.
  it("go-to-date covers the gap in parallel, centred on the chosen day", async () => {
    const { onGoToDate, settled, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    onGoToDate("2024-03-07");
    const [askedFrom, opts] = coverHistoryTo.mock.calls[0]!;
    const parked = opts!.owner as RangeReq;
    expect(parked.fit).toBe("center");
    expect(askedFrom).toBe(parked.fromTs);
    // Padded symmetrically, so the token midpoint IS the chosen date (deps
    // timezone is UTC, so the civil day starts at UTC midnight).
    expect(Math.round((parked.fromTs + parked.toTs) / 2)).toBe(Date.UTC(2024, 2, 7));
    await vi.waitFor(() => expect(settled()).toBe(true));
  });

  it("go-to-date honours a datetime-local value down to the minute", async () => {
    const { onGoToDate, settled, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    onGoToDate("2024-03-07T14:30");
    const [, opts] = coverHistoryTo.mock.calls[0]!;
    const parked = opts!.owner as RangeReq;
    expect(Math.round((parked.fromTs + parked.toTs) / 2)).toBe(Date.UTC(2024, 2, 7, 14, 30));
    await vi.waitFor(() => expect(settled()).toBe(true));
  });

  // A date years behind the loaded oldest bar can't be reached by extending
  // history: the parallel cover would be hundreds of windows and (cold) minutes
  // of backfill. Past DETACH_GAP_BARS the chart reloads with just the target
  // window instead — no cover, no fetch storm.
  it("go-to-date deeper than the detach budget enters detached view", async () => {
    const { onGoToDate, enterDetached, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    // ~2.9 years behind the loaded oldest on 5m (LAST_BAR is 2023-11-14T22:13Z):
    // ~300k bars, far past DETACH_GAP_BARS.
    onGoToDate("2021-01-05");
    expect(enterDetached).toHaveBeenCalledTimes(1);
    expect(enterDetached.mock.calls[0][0]).toBe(Date.UTC(2021, 0, 5));
    expect(coverHistoryTo).not.toHaveBeenCalled(); // no fetch storm
  });

  it("go-to-date inside the detach budget keeps the parallel cover", async () => {
    const { onGoToDate, settled, enterDetached, coverHistoryTo } = jumpHarness(LAST_BAR - 60 * MIN);
    onGoToDate("2023-11-13"); // ~a day behind LAST_BAR (2023-11-14T22:13Z): near
    expect(enterDetached).not.toHaveBeenCalled();
    expect(coverHistoryTo).toHaveBeenCalled();
    await vi.waitFor(() => expect(settled()).toBe(true));
  });

  // Already detached, EVERY Go re-detaches — inside the loaded window included.
  // Recentring in place was cheaper, but it left the target (and so the "Viewing
  // <date>" pill, and the next Go's own window) naming the FIRST jump while the
  // view had moved on. The target is the last date asked for, always.
  it("re-detaches on every go-to-date, inside the loaded window or not", async () => {
    const target = Date.UTC(2021, 0, 5);
    // A 3-day loaded extent stands in for the detached window.
    const inside = jumpHarness(LAST_BAR - 3 * 1440 * MIN, { targetMs: target });
    inside.onGoToDate("2023-11-13"); // inside [oldest, LAST_BAR] of this fixture
    expect(inside.enterDetached).toHaveBeenCalledTimes(1);
    expect(inside.enterDetached.mock.calls[0][0]).toBe(Date.UTC(2023, 10, 13));
    expect(inside.coverHistoryTo).not.toHaveBeenCalled(); // a reload, not a cover

    const outside = jumpHarness(LAST_BAR - 60 * MIN, { targetMs: target });
    outside.onGoToDate("2019-06-03"); // older than the loaded oldest bar
    expect(outside.enterDetached).toHaveBeenCalledTimes(1);
    expect(outside.coverHistoryTo).not.toHaveBeenCalled();
  });

  // A quick range is a statement about the LIVE edge: every window it computes
  // ends at now, which is nowhere near the detached window. Fitting one over
  // that window would land on nothing while the cell still called itself
  // detached (the pill asserting a date the view had left), so the pick exits
  // instead and the reload it triggers consumes the parked token.
  it("quick range while detached exits detached view, with the token parked", () => {
    const h = jumpHarness(LAST_BAR - 60 * MIN, { targetMs: Date.UTC(2021, 0, 5) });
    h.onRangePick("5D"); // MINUTE_5: same resolution as the fixture's period
    expect(h.exitDetached).toHaveBeenCalledTimes(1);
    expect(h.onPeriod).not.toHaveBeenCalled();
    // Parked for the data-load effect that the exit's reload runs — the walk
    // must NOT have been kicked off against the stale detached series.
    expect(h.handle.pendingRangeRef.current?.resolution).toBe("MINUTE_5");
    expect(h.coverHistoryTo).not.toHaveBeenCalled();
  });

  it("quick range while detached still switches the interval it implies", () => {
    const h = jumpHarness(LAST_BAR - 60 * MIN, { targetMs: Date.UTC(2021, 0, 5) });
    h.onRangePick("1Y"); // DAY: a resolution change AND an exit, both needed
    expect(h.onPeriod).toHaveBeenCalledTimes(1);
    expect(h.onPeriod.mock.calls[0][1].resolution).toBe("DAY");
    expect(h.exitDetached).toHaveBeenCalledTimes(1);
  });

  it("quick range on the live series is untouched by the detached path", () => {
    const h = jumpHarness(LAST_BAR - 60 * MIN); // not detached
    h.onRangePick("5D");
    expect(h.exitDetached).not.toHaveBeenCalled();
    expect(h.onPeriod).not.toHaveBeenCalled();
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
