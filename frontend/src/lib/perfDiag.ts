// Hot-path instrumentation for the live chart, built for one question: when a
// tab starts burning CPU, WHAT is doing it — the per-tick indicator recalc, or
// a history/MTF fetch that will not settle?
//
// Everything here is measured from inside the real tab, because that is the
// only place the answer lives: a headless load misses whatever depends on a
// visible, interacted-with chart (crosshair repaints above all), and profiling
// a jammed renderer from outside mostly measures the jam.
//
// COST. Two performance.now() calls and a handful of adds per tick, a counter
// bump per fetch. No timers, no allocation in steady state, no work at all when
// off — call sites guard on PERF_DIAG_ON so even the call disappears. A
// diagnostic that shows up in its own numbers is worse than none.
//
// Windows are flushed lazily by the next record() rather than on an interval,
// so an idle tab costs literally nothing (and has nothing to report anyway).
//
// Read it live in the browser console:
//   __perf.report()   the last windows, newest first
//   __perf.hot()      only the windows that tripped a threshold
//   __perf.reset()

/** On in dev, and in a production build only when explicitly asked for — the
 * same convention the agent bridge uses (see CLAUDE.md). */
export const PERF_DIAG_ON =
  import.meta.env.DEV || import.meta.env.VITE_PERF_DIAG === "1";

/** A window long enough to average out a single slow frame, short enough that a
 * runaway shows up while the user is still looking at it. */
const WINDOW_MS = 15_000;
/** Windows kept for report(). ~5 minutes at WINDOW_MS. */
const KEEP = 20;

// --- thresholds: what counts as "this tab is in trouble" --------------------
//
// Chosen from measurements on this app rather than taste. A healthy idle tab
// sits near 12% main-thread busy with recalcs in low single-digit ms, and makes
// essentially no windowed candle requests once loaded.

/** One recalc chain this slow is a dropped frame the user can feel. */
const SLOW_TICK_MS = 50;
/** Share of wall-clock spent inside the tick path before it is the problem. */
const BUSY_SHARE = 0.2;
/** Windowed candle requests per window. A settled chart makes ~0; the
 * scroll-back walk is bounded at 16 pages, so sustained double digits means
 * something is re-walking rather than paging once. */
const FETCH_STORM = 20;

export interface PerfWindow {
  /** Wall-clock ms the window actually covered. */
  ms: number;
  /** Ticks (candle frames) processed. */
  ticks: number;
  /** Total ms spent in the tick path (indicator recalc + redraw). */
  tickMs: number;
  /** Slowest single tick in the window. */
  maxTickMs: number;
  /** Share of the window spent in the tick path, 0..1. */
  busy: number;
  /** Windowed /api/candles requests (the scroll-back and MTF paging path). */
  rangeFetches: number;
  /** Recent-load /api/candles requests. */
  recentFetches: number;
  /** Bars returned across all counted fetches. */
  barsFetched: number;
  /** Which thresholds tripped, empty when the window looked healthy. */
  flags: string[];
}

interface Live {
  start: number;
  ticks: number;
  tickMs: number;
  maxTickMs: number;
  rangeFetches: number;
  recentFetches: number;
  barsFetched: number;
}

const fresh = (now: number): Live => ({
  start: now,
  ticks: 0,
  tickMs: 0,
  maxTickMs: 0,
  rangeFetches: 0,
  recentFetches: 0,
  barsFetched: 0,
});

let live: Live = fresh(0);
const windows: PerfWindow[] = [];

function summarise(w: Live, now: number): PerfWindow {
  const ms = now - w.start;
  const busy = ms > 0 ? w.tickMs / ms : 0;
  const flags: string[] = [];
  if (w.maxTickMs >= SLOW_TICK_MS) flags.push(`slow-tick(${w.maxTickMs.toFixed(0)}ms)`);
  if (busy >= BUSY_SHARE) flags.push(`busy(${(busy * 100).toFixed(0)}%)`);
  if (w.rangeFetches >= FETCH_STORM) flags.push(`fetch-storm(${w.rangeFetches})`);
  return {
    ms: Math.round(ms),
    ticks: w.ticks,
    tickMs: Math.round(w.tickMs),
    maxTickMs: Math.round(w.maxTickMs),
    busy,
    rangeFetches: w.rangeFetches,
    recentFetches: w.recentFetches,
    barsFetched: w.barsFetched,
    flags,
  };
}

/** Close the window if it is old enough. Called from the record functions, so a
 * quiet tab neither flushes nor warns — there is nothing to say about it. */
function maybeFlush(now: number): void {
  if (live.start === 0) {
    live.start = now;
    return;
  }
  if (now - live.start < WINDOW_MS) return;
  const w = summarise(live, now);
  windows.unshift(w);
  if (windows.length > KEEP) windows.pop();
  if (w.flags.length) {
    // One line per window, only when something tripped. Never a heartbeat: log
    // spam in a hot tab is itself a cost, and it buries the signal.
    console.warn(
      `[perf] ${w.flags.join(" ")} | ${w.ticks} ticks, ${w.tickMs}ms in tick path ` +
        `(max ${w.maxTickMs}ms), ${w.rangeFetches} range + ${w.recentFetches} recent fetches, ` +
        `${w.barsFetched} bars. __perf.report() for history.`,
    );
  }
  live = fresh(now);
}

/** Time spent in one candle frame: the synchronous indicator recalc chain plus
 * the redraw it triggers. This is the number that decides whether the recalc
 * path is what is eating the tab. */
export function recordTick(ms: number): void {
  if (!PERF_DIAG_ON) return;
  const now = performance.now();
  maybeFlush(now);
  live.ticks += 1;
  live.tickMs += ms;
  if (ms > live.maxTickMs) live.maxTickMs = ms;
}

/** One candle request. `kind` separates the windowed paging path (the one that
 * can loop) from the bounded initial load. `bars` is the row count when known,
 * which is far cheaper to obtain than response bytes and answers the same
 * question: how much history is being pulled, and does it ever stop. */
export function recordFetch(kind: "range" | "recent", bars: number): void {
  if (!PERF_DIAG_ON) return;
  const now = performance.now();
  maybeFlush(now);
  if (kind === "range") live.rangeFetches += 1;
  else live.recentFetches += 1;
  live.barsFetched += bars;
}

/** Rows returned by a candle response, recorded where the body is parsed (the
 * request itself was already counted at its choke point). Separate from
 * recordFetch so a request is never double-counted. */
export function recordBars(bars: number): void {
  if (!PERF_DIAG_ON) return;
  maybeFlush(performance.now());
  live.barsFetched += bars;
}

/** Closed windows, newest first, plus the one still filling. */
export function report(): PerfWindow[] {
  const now = performance.now();
  const current = live.start === 0 ? [] : [summarise(live, now)];
  return [...current, ...windows];
}

/** Only the windows that tripped a threshold. */
export function hot(): PerfWindow[] {
  return report().filter((w) => w.flags.length > 0);
}

export function reset(): void {
  windows.length = 0;
  live = fresh(performance.now());
}

// The console handle. Deliberately the app's only window global: this is a
// debugging surface, not an API, and nothing in the app reads it back.
if (PERF_DIAG_ON && typeof window !== "undefined") {
  (window as unknown as { __perf?: unknown }).__perf = { report, hot, reset };
}
