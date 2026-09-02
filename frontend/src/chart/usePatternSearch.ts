// Pattern search state for one chart cell: the picked range, the request in
// flight and its result. Per-cell like useProximityHeatmap, no React context.
import { useCallback, useRef, useState } from "react";
import {
  barsInRange,
  mergePatternResults,
  searchPatterns,
  type MatchSource,
  type MergedPatternResult,
  type PatternBar,
  type PatternMode,
  type PatternSearchResult,
} from "../lib/patternSearch";

const MIN_BARS = 3;
const MAX_BARS = 1024;
const TOP_K = 20;
const DEFAULT_MODE: PatternMode = "shape";
const DEFAULT_FORWARD_BARS = 20;
// A workspace with many tabs can hold twenty-odd distinct series, and the
// first search on each is a cold cache build server-side. A small pool keeps
// the fan-out from hammering them all at once; results still merge as one.
const MAX_CONCURRENT_SEARCHES = 4;

/** What the search covers: this chart's series alone, or every chart in every
 *  open tab (the workspace series App enumerates via getSeries). */
export type PatternScope = "cell" | "all";
const DEFAULT_SCOPE: PatternScope = "all";

// Finished searches parked per series, so switching market tab / interval /
// side does not destroy a result list the user meant to come back to. Only the
// panel's own close (dismiss) deletes an entry. Module-level, not React state:
// the cell reloads in place on a series change and may unmount entirely on a
// layout change, and the parked result must survive both. The range is enough
// to repaint the selection band; the controls come along because the result
// was computed with them (restoring under different controls would caption the
// numbers wrongly).
interface ParkedSearch {
  result: MergedPatternResult;
  range: { fromMs: number; toMs: number };
  truncatedTo: number | null;
  mode: PatternMode;
  forwardBars: number;
  scope: PatternScope;
}
const parkedSearches = new Map<string, ParkedSearch>();

/** Test hook: the cache is deliberately module-level, so suites must clear it. */
export function clearParkedPatternSearches(): void {
  parkedSearches.clear();
}

interface Args {
  cellId: string;
  epic: string;
  broker: string;
  priceSide: string;
  resolution: string;
  getBars: () => PatternBar[];
  /** Every searchable chart in the workspace (all tabs), as App enumerates
   *  them — already gated (no synthetic epics, sub-minute or snapshot cells).
   *  Called at run time so it always reflects the tabs as they are now. */
  getSeries: () => MatchSource[];
}

export function usePatternSearch({ cellId, epic, broker, priceSide, resolution, getBars, getSeries }: Args) {
  const [result, setResult] = useState<MergedPatternResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ fromMs: number; toMs: number } | null>(null);
  // Bars actually searched when the drag covered more than MAX_BARS, else null.
  // The band stays painted over the WHOLE drag, so above the cap it shows more
  // than was searched; the panel discloses the difference. Set synchronously in
  // run(), like `range`, so an out-of-order response cannot revive an old value.
  const [truncatedTo, setTruncatedTo] = useState<number | null>(null);
  // The two search controls. Deliberately NOT persisted: this app has a save
  // path of its own for stored settings, and writing around it gets reverted.
  // These are per-cell session preferences, so React state is the whole story
  // and a fresh cell starts on the defaults.
  const [mode, setModeState] = useState<PatternMode>(DEFAULT_MODE);
  const [forwardBars, setForwardBarsState] = useState(DEFAULT_FORWARD_BARS);
  const [scope, setScopeState] = useState<PatternScope>(DEFAULT_SCOPE);
  // Mirrored into refs because `run` is a useCallback that must not take them
  // as deps: reading them out of the closure would send the value from BEFORE
  // the change on the very re-run the change triggers.
  const modeRef = useRef(mode);
  const forwardBarsRef = useRef(forwardBars);
  const scopeRef = useRef(scope);
  // The last range, for the same reason: the re-run happens inside a setter,
  // where the render-scope `range` is a snapshot.
  const rangeRef = useRef<{ fromMs: number; toMs: number } | null>(null);
  // Only the newest request may write state: a slow first search must not
  // overwrite the result of a second one the user has already seen.
  const reqRef = useRef(0);
  // Which series the live state belongs to vs. which the cell shows now. They
  // differ between a series change and the adoptSeries() that follows it, and
  // parkLive must file the result under the series it was SEARCHED on, not the
  // one the cell just switched to.
  const keyRef = useRef("");
  keyRef.current = `${broker}|${epic}|${priceSide}|${resolution}`;
  const liveKeyRef = useRef<string | null>(null);
  // Live state mirrored for parkLive, which is a stable callback (same reason
  // as modeRef above: it must read the value at call time, not at creation).
  const resultRef = useRef(result);
  resultRef.current = result;
  const truncatedToRef = useRef(truncatedTo);
  truncatedToRef.current = truncatedTo;

  const run = useCallback(
    (fromMs: number, toMs: number) => {
      const selected = barsInRange(getBars(), fromMs, toMs);
      const query = selected.slice(-MAX_BARS);
      liveKeyRef.current = keyRef.current;
      setRange({ fromMs, toMs });
      rangeRef.current = { fromMs, toMs };
      setTruncatedTo(selected.length > MAX_BARS ? MAX_BARS : null);
      if (query.length < MIN_BARS) {
        // Supersede anything in flight, exactly as dismiss() does. Without the
        // bump, a valid drag still loading when the user makes a too-short one
        // resolves afterwards and overwrites this error with results for the
        // PREVIOUS range, while the band on the chart shows the new one.
        reqRef.current += 1;
        setResult(null);
        setError(`select at least ${MIN_BARS} candles`);
        setLoading(false);
        return;
      }
      const id = ++reqRef.current;
      setLoading(true);
      setError(null);
      // The series to search: this chart first (found in App's workspace list
      // by cellId; a bare fallback covers a cell the list somehow misses),
      // then in all-charts scope every OTHER series across every tab, deduped
      // — two cells on the same symbol+timeframe would return identical
      // matches twice. broker and priceSide are global, so the series key
      // here is just epic|resolution.
      const all = getSeries();
      const origin: MatchSource =
        all.find((s) => s.cellId === cellId) ?? { cellId, epic, resolution, label: resolution };
      const seen = new Set([`${origin.epic}|${origin.resolution}`]);
      const sources = [origin];
      if (scopeRef.current === "all") {
        for (const s of all) {
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
            forwardBars: forwardBarsRef.current,
            mode: modeRef.current,
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
        if (reqRef.current !== id) return;
        try {
          setResult(mergePatternResults(outcomes, TOP_K));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
      });
    },
    [cellId, epic, broker, priceSide, resolution, getBars, getSeries],
  );

  // Changing a control re-runs the last range, so the effect is visible without
  // dragging the band again. Nothing to re-run before the first drag, and firing
  // then would search a range the user never picked.
  const setMode = useCallback(
    (next: PatternMode) => {
      setModeState(next);
      modeRef.current = next;
      const r = rangeRef.current;
      if (r) run(r.fromMs, r.toMs);
    },
    [run],
  );

  const setForwardBars = useCallback(
    (next: number) => {
      setForwardBarsState(next);
      forwardBarsRef.current = next;
      const r = rangeRef.current;
      if (r) run(r.fromMs, r.toMs);
    },
    [run],
  );

  const setScope = useCallback(
    (next: PatternScope) => {
      setScopeState(next);
      scopeRef.current = next;
      const r = rangeRef.current;
      if (r) run(r.fromMs, r.toMs);
    },
    [run],
  );

  const dismiss = useCallback(() => {
    reqRef.current += 1;
    setResult(null);
    setError(null);
    setRange(null);
    rangeRef.current = null;
    setTruncatedTo(null);
    setLoading(false);
    // Dismiss is the one deliberate "I am done with this" act, so it also
    // forgets the parked copy: without this the panel would come back on the
    // next tab switch after the user explicitly closed it.
    parkedSearches.delete(keyRef.current);
    // mode and forwardBars survive: they are how the user wants to search, not
    // part of the result being cleared.
  }, []);

  /** Park the live search under the series it was run on. Called from the
   *  series-reset effect's CLEANUP, so it still sees the old series' state
   *  while keyRef may already point at the new one. Only a finished result is
   *  worth keeping; a search still in flight is superseded (the bump) so a
   *  late response cannot land in the next series' panel. */
  const parkLive = useCallback(() => {
    const prev = liveKeyRef.current;
    if (prev && resultRef.current && rangeRef.current) {
      parkedSearches.set(prev, {
        result: resultRef.current,
        range: rangeRef.current,
        truncatedTo: truncatedToRef.current,
        mode: modeRef.current,
        forwardBars: forwardBarsRef.current,
        scope: scopeRef.current,
      });
    }
    reqRef.current += 1;
  }, []);

  /** Take over the series the cell now shows: clear whatever parkLive left on
   *  screen, then restore anything parked for this series (skipped while the
   *  cell is gated — replay, snapshot — but the parked copy is kept for when
   *  it comes back). Returns the restored range so the caller can repaint the
   *  selection band, or null when there is nothing to show. */
  const adoptSeries = useCallback(
    (available: boolean): { fromMs: number; toMs: number } | null => {
      liveKeyRef.current = keyRef.current;
      setResult(null);
      setError(null);
      setLoading(false);
      setRange(null);
      rangeRef.current = null;
      setTruncatedTo(null);
      const saved = available ? parkedSearches.get(keyRef.current) : undefined;
      if (!saved) return null;
      setResult(saved.result);
      setRange(saved.range);
      rangeRef.current = saved.range;
      setTruncatedTo(saved.truncatedTo);
      setModeState(saved.mode);
      modeRef.current = saved.mode;
      setForwardBarsState(saved.forwardBars);
      forwardBarsRef.current = saved.forwardBars;
      setScopeState(saved.scope);
      scopeRef.current = saved.scope;
      return saved.range;
    },
    [],
  );

  return {
    result, loading, error, range, truncatedTo, run, dismiss,
    mode, setMode, forwardBars, setForwardBars, scope, setScope,
    parkLive, adoptSeries,
  };
}
