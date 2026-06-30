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
