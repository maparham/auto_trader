// The ONE workspace-level pattern search: the picked range, the request in
// flight and its merged result. Module-level (not per-cell React state) on
// purpose — the results panel must survive tab switches, series changes on the
// chart it was dragged on, even that chart closing. Only the panel's own ✕
// (dismissPatternPanel) destroys a result list; everything else at most hides
// the panel and finds it intact afterwards. Cells call runPatternSearch from
// the drag gesture; App renders the panel from this state and registers the
// workspace's searchable series (setPatternSeriesProvider).
import {
  mergePatternResults,
  searchPatterns,
  type MatchSource,
  type MergedPatternResult,
  type PatternBar,
  type PatternMode,
  type PatternSearchResult,
} from "./patternSearch";
import { listPatternTargets } from "./patternTargets";

const MIN_BARS = 3;
const MAX_BARS = 1024;
const TOP_K = 20;
const DEFAULT_MODE: PatternMode = "shape";
const DEFAULT_FORWARD_BARS = 20;
// A workspace with many tabs can hold twenty-odd distinct series, and the
// first search on each is a cold cache build server-side. A small pool keeps
// the fan-out from hammering them all at once; results still merge as one.
const MAX_CONCURRENT_SEARCHES = 4;

/** What the search covers: the dragged chart's series alone, or every chart in
 *  every open tab (the workspace series App enumerates via the provider). */
export type PatternScope = "cell" | "all";
const DEFAULT_SCOPE: PatternScope = "all";

export interface PatternPanelState {
  /** The series the query was dragged on. Null until the first search. */
  origin: MatchSource | null;
  broker: string;
  priceSide: string;
  result: MergedPatternResult | null;
  loading: boolean;
  error: string | null;
  /** The dragged range, for repainting the selection band on the origin chart. */
  range: { fromMs: number; toMs: number } | null;
  /** Bars actually searched when the drag covered more than the cap, else null.
   *  The band spans the WHOLE drag, so the panel must disclose the difference. */
  truncatedTo: number | null;
  mode: PatternMode;
  forwardBars: number;
  scope: PatternScope;
}

const initial: PatternPanelState = {
  origin: null, broker: "", priceSide: "",
  result: null, loading: false, error: null,
  range: null, truncatedTo: null,
  mode: DEFAULT_MODE, forwardBars: DEFAULT_FORWARD_BARS, scope: DEFAULT_SCOPE,
};

let state: PatternPanelState = initial;
const listeners = new Set<() => void>();
// Only the newest request may write state: a slow first search must not
// overwrite the result of a second one the user has already seen.
let reqId = 0;
// The last run's inputs, so a control change re-runs the SAME query even after
// the origin chart moved on to another series (the query bars were captured at
// drag time and stay valid on their own).
let lastRun: {
  origin: MatchSource;
  broker: string;
  priceSide: string;
  bars: PatternBar[];
} | null = null;
// Every searchable chart in the workspace (all tabs), as App enumerates them —
// already gated (no synthetic epics, sub-minute or snapshot cells). Called at
// run time so it always reflects the tabs as they are now.
let seriesProvider: () => MatchSource[] = () => [];

function set(patch: Partial<PatternPanelState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribePatternPanel(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stable snapshot for useSyncExternalStore (and plain reads elsewhere). */
export function getPatternPanelState(): PatternPanelState {
  return state;
}

export function setPatternSeriesProvider(fn: () => MatchSource[]): () => void {
  seriesProvider = fn;
  return () => {
    if (seriesProvider === fn) seriesProvider = () => [];
  };
}

export interface PatternRunArgs {
  /** The dragging cell's identity; tabId is filled in from the provider when
   *  the workspace enumeration knows this cell. */
  origin: MatchSource;
  broker: string;
  priceSide: string;
  /** The bars inside the dragged range, uncapped — the store slices. */
  bars: PatternBar[];
  range: { fromMs: number; toMs: number };
}

export function runPatternSearch(args: PatternRunArgs): void {
  const all = seriesProvider();
  // Prefer the provider's entry: it carries the tab the cell lives on, which
  // a foreign-row jump needs to switch there.
  const origin = all.find((s) => s.cellId === args.origin.cellId) ?? args.origin;
  // A new search retires the bands the previous one left on OTHER cells: the
  // superseded origin's selection band (its band-sync effect keys on its own
  // series, which no longer matches the store, so nothing on the cell's side
  // would ever clear it) and any match bands painted by row jumps. The
  // dragging cell is skipped — its gesture just painted the new band.
  const prev = state.origin;
  for (const t of listPatternTargets()) {
    if (t.cellId === args.origin.cellId) continue;
    t.clearMatchBands();
    if (
      prev &&
      (prev.epic !== origin.epic || prev.resolution !== origin.resolution) &&
      t.epic === prev.epic && t.resolution === prev.resolution
    ) {
      t.clearSelectionBand();
    }
  }
  lastRun = { origin, broker: args.broker, priceSide: args.priceSide, bars: args.bars };
  doRun(args.range);
}

function doRun(range: { fromMs: number; toMs: number }): void {
  const { origin, broker, priceSide, bars } = lastRun!;
  const query = bars.slice(-MAX_BARS);
  const base = {
    origin, broker, priceSide,
    range,
    truncatedTo: bars.length > MAX_BARS ? MAX_BARS : null,
  };
  if (query.length < MIN_BARS) {
    // Supersede anything in flight, exactly as dismiss() does. Without the
    // bump, a valid drag still loading when the user makes a too-short one
    // resolves afterwards and overwrites this error with results for the
    // PREVIOUS range, while the band on the chart shows the new one.
    reqId += 1;
    set({ ...base, result: null, error: `select at least ${MIN_BARS} candles`, loading: false });
    return;
  }
  const id = ++reqId;
  set({ ...base, loading: true, error: null });
  // The series to search: the origin chart first, then in all-charts scope
  // every OTHER series across every tab, deduped — two cells on the same
  // symbol+timeframe would return identical matches twice. broker and
  // priceSide are global, so the series key here is just epic|resolution.
  const seen = new Set([`${origin.epic}|${origin.resolution}`]);
  const sources = [origin];
  if (state.scope === "all") {
    for (const s of seriesProvider()) {
      const key = `${s.epic}|${s.resolution}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(s);
    }
  }
  // One request per series, all with the SAME query (the origin chart's
  // drag). Each settles into an outcome so one failed series cannot reject
  // the whole batch; the merge below throws only when every one failed. A
  // small worker pool caps the requests in flight; outcomes land by index,
  // so the merge still sees the origin first.
  const outcomes: { source: MatchSource; result?: PatternSearchResult; error?: string }[] =
    new Array(sources.length);
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const i = next++;
      const source = sources[i];
      outcomes[i] = await searchPatterns({
        epic: source.epic,
        resolution: source.resolution,
        priceSide,
        broker,
        query,
        queryFromTs: query[0].ts,
        queryToTs: query[query.length - 1].ts,
        topK: TOP_K,
        forwardBars: state.forwardBars,
        mode: state.mode,
      }).then(
        (res) => ({ source, result: res }),
        (e: unknown) => ({
          source,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };
  Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_SEARCHES, sources.length) }, worker),
  ).then(() => {
    if (reqId !== id) return;
    try {
      set({ result: mergePatternResults(outcomes, TOP_K), loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  });
}

// Changing a control re-runs the last query, so the effect is visible without
// dragging the band again. Nothing to re-run before the first drag, and firing
// then would search a range the user never picked.
export function setPatternMode(next: PatternMode): void {
  set({ mode: next });
  if (lastRun && state.range) doRun(state.range);
}

export function setPatternForwardBars(next: number): void {
  set({ forwardBars: next });
  if (lastRun && state.range) doRun(state.range);
}

export function setPatternScope(next: PatternScope): void {
  set({ scope: next });
  if (lastRun && state.range) doRun(state.range);
}

/** The panel's ✕ — the ONE way a result list is destroyed. mode, forwardBars
 *  and scope survive: they are how the user wants to search, not part of the
 *  result being cleared. */
export function dismissPatternPanel(): void {
  reqId += 1;
  lastRun = null;
  set({
    origin: null, result: null, loading: false, error: null,
    range: null, truncatedTo: null,
  });
}

/** Test hook: the store is deliberately module-level, so suites must reset it. */
export function resetPatternPanel(): void {
  reqId += 1;
  lastRun = null;
  seriesProvider = () => [];
  state = initial;
  listeners.clear();
}
