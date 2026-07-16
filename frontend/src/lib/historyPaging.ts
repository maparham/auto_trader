// Bounded walk-back over older candle history. Pages older bars in fixed windows
// (the backend caps a single fetch, so a calendar window may need several pages),
// prepends each fresh page, and stops when coverage reaches `fromTs`, the broker
// runs out of history, or the caller signals the request is stale (a newer pick,
// an epic/broker switch, or a torn-down chart). Pure and dependency-injected so
// the paging correctness — filter-by-oldest dedup, empty-window exhaustion, and
// abort-without-applying — is unit-testable without klinecharts or the network.
//
// This is the shared primitive the quick-range "cover + fit" uses; the caller
// owns the mutex (so it can't race the scroll-back loader) and the actual fit.

export interface BarLike {
  timestamp: number; // ms
}

export type PageResult =
  | "reached" // coverage reached fromTs (or maxPages spent) — caller should fit
  | "exhausted" // broker is out of older history — caller should fit what it has
  | "aborted"; // request went stale mid-walk — caller must NOT fit

export interface PageHistoryBackArgs<T extends BarLike> {
  fromTs: number; // ms — target left edge (walk back until the oldest bar reaches it)
  toTs: number; // ms — right edge; the cursor's fallback when no data is loaded yet
  resSec: number; // seconds per bar (page width = pageBars * resSec)
  pageBars: number; // bars to request per page
  maxPages: number; // bound on the walk-back
  maxEmpty: number; // consecutive empty windows before declaring the broker exhausted
  // True when this request no longer owns the chart (newer pick, epic/broker change,
  // chart gone). Checked before each fetch and again after it resolves.
  isStale: () => boolean;
  getData: () => T[] | null | undefined; // current loaded bars, ascending
  fetchOlder: (fromSec: number, toSec: number) => Promise<T[]>; // older page in [from,to]
  applyData: (merged: T[]) => void; // prepend fresh + current
  onCursor?: (sec: number) => void; // advanced-to boundary (unix sec) after a fresh page
  onProgress?: () => void; // a fresh page landed (e.g. clear an exhausted flag)
  onExhausted?: () => void; // the broker bottomed out (set an exhausted flag)
}

export async function pageHistoryBack<T extends BarLike>(
  args: PageHistoryBackArgs<T>,
): Promise<PageResult> {
  const {
    fromTs,
    toTs,
    resSec,
    pageBars,
    maxPages,
    maxEmpty,
    isStale,
    getData,
    fetchOlder,
    applyData,
    onCursor,
    onProgress,
    onExhausted,
  } = args;

  let cursorSec = Math.floor((getData()?.[0]?.timestamp ?? toTs) / 1000);
  let empties = 0;

  for (let page = 0; page < maxPages; page++) {
    if (isStale()) return "aborted";
    if (cursorSec * 1000 <= fromTs) break; // history now reaches the period start
    const toSec = cursorSec - 1;
    // Never page older than the target left edge. Without this, a high/derived
    // timeframe (resSec = a year) makes pageBars*resSec span centuries in one
    // page — the backend would fold that from DAY base bars, looping ~180
    // sequential broker requests before the loop's fromTs break ever fires.
    // Clamping bounds each page to the requested [fromTs, toTs] window.
    const fromSec = Math.max(Math.floor(fromTs / 1000), toSec - pageBars * resSec);

    let older: T[];
    try {
      older = await fetchOlder(fromSec, toSec);
    } catch {
      break; // transient fetch failure — fit what we already have
    }
    if (isStale()) return "aborted";

    cursorSec = fromSec; // advance back even across gaps
    const cur = getData() ?? [];
    const oldestMs = cur[0]?.timestamp ?? Infinity;
    const fresh = older.filter((b) => b.timestamp < oldestMs);
    if (fresh.length) {
      empties = 0;
      applyData([...fresh, ...cur]);
      onCursor?.(Math.floor(fresh[0].timestamp / 1000));
      onProgress?.();
    } else if (++empties >= maxEmpty) {
      onExhausted?.();
      return "exhausted";
    }
  }
  return "reached";
}

// The interactive scroll-back loader: answers ONE klinecharts forward ('older')
// load. Distinct from pageHistoryBack in two load-bearing ways, both driven by
// how klinecharts chains loads: it only re-triggers the next forward load when
// a NON-empty prepend re-adjusts the visible range, and it re-asks SYNCHRONOUSLY
// from inside done().
//
//  1. Interior gap windows (weekend/holiday closures wider than one page) are
//     walked across INSIDE this one load. Answering them with an empty done()
//     would end the chain and stall the fill until the next user gesture (the
//     "scroll-back walls at a weekend until I zoom" bug).
//  2. The shared pager mutex is freed BEFORE done() on every exit path. done()
//     re-enters the loader for the next page while this frame is still on the
//     stack; freeing it after (e.g. in a .finally) makes that re-entry hit the
//     mutex-busy bail, killing the chain after one page per gesture, and a
//     late reset would stomp the mutex the re-entrant page just took. For the
//     same reason a throw inside done()/onFresh is contained here: letting it
//     escape would float an unhandled rejection, and any catch-side mutex
//     reset would stomp the re-entrant page's ownership.
//
// Shared refs (cursorSec/emptyStreak/exhausted/loading) are the same loose ones
// the coverage walks coordinate through; see the DESIGN DEBT note in
// useRangeNavigation.ensureCoverageAndFit.
export interface ScrollbackLoadArgs<T extends BarLike> {
  boundary: number; // ms; oldest loaded bar, only strictly-older bars count as fresh
  resSec: number; // seconds per bar
  pageBars: number; // bars to request per page window
  maxPageSpanSec: number; // cap on a page's span (high/derived timeframes)
  maxEmpty: number; // consecutive empty windows before latching exhaustion
  cursorSec: { current: number }; // shared walk-back cursor (unix sec)
  emptyStreak: { current: number }; // shared consecutive-empty counter
  exhausted: { current: boolean }; // shared no-older-history latch
  loading: { current: boolean }; // shared pager mutex
  isStale: () => boolean; // request no longer owns the chart (identity drift, teardown, range pick)
  fetchOlder: (fromSec: number, toSec: number) => Promise<T[]>;
  done: (bars: T[], more: boolean) => void; // klinecharts DataLoader callback
  onFresh?: (bars: T[]) => void; // after done(); e.g. extend HTF MTF coverage
}

export async function scrollbackLoadOlder<T extends BarLike>(
  args: ScrollbackLoadArgs<T>,
): Promise<void> {
  const { boundary, resSec, pageBars, maxPageSpanSec, maxEmpty, cursorSec, emptyStreak, exhausted, loading, isStale, fetchOlder, done, onFresh } = args;
  // Contain callback throws (see contract note): the mutex is already settled
  // by the time done()/onFresh run, so the only safe handling is to swallow.
  const answer = (bars: T[], more: boolean, fresh?: T[]) => {
    try {
      done(bars, more);
      if (fresh) onFresh?.(fresh);
    } catch {
      /* disposed chart or a listener throw; mutex state is already correct */
    }
  };
  loading.current = true;
  for (;;) {
    const toSec = cursorSec.current - 1;
    const fromSec = toSec - Math.min(pageBars * resSec, maxPageSpanSec);
    let older: T[];
    try {
      older = await fetchOlder(fromSec, toSec);
    } catch {
      // Transient failure (broker breaker / slow source / network): retry the
      // SAME window on the next gesture. Don't advance the cursor or the empty
      // streak, so a momentary hiccup can't wall scroll-back for the session.
      loading.current = false;
      answer([], true);
      return;
    }
    if (isStale()) {
      loading.current = false;
      answer([], true);
      return;
    }
    cursorSec.current = fromSec; // advance back even across gaps
    const fresh = older.filter((b) => b.timestamp < boundary);
    if (fresh.length > 0) {
      emptyStreak.current = 0;
      loading.current = false; // BEFORE done(); see contract note above
      answer(fresh, true, fresh);
      return;
    }
    emptyStreak.current += 1;
    if (emptyStreak.current >= maxEmpty) {
      exhausted.current = true;
      loading.current = false;
      answer([], false);
      return;
    }
    // Interior gap window: keep walking back within this one load.
  }
}
