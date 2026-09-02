// Pattern search state for one chart cell: the picked range, the request in
// flight and its result. Per-cell like useProximityHeatmap, no React context.
import { useCallback, useRef, useState } from "react";
import {
  barsInRange,
  searchPatterns,
  type PatternBar,
  type PatternMode,
  type PatternSearchResult,
} from "../lib/patternSearch";

const MIN_BARS = 3;
const MAX_BARS = 1024;
const TOP_K = 20;
const DEFAULT_MODE: PatternMode = "shape";
const DEFAULT_FORWARD_BARS = 20;

// Finished searches parked per series, so switching market tab / interval /
// side does not destroy a result list the user meant to come back to. Only the
// panel's own close (dismiss) deletes an entry. Module-level, not React state:
// the cell reloads in place on a series change and may unmount entirely on a
// layout change, and the parked result must survive both. The range is enough
// to repaint the selection band; the controls come along because the result
// was computed with them (restoring under different controls would caption the
// numbers wrongly).
interface ParkedSearch {
  result: PatternSearchResult;
  range: { fromMs: number; toMs: number };
  truncatedTo: number | null;
  mode: PatternMode;
  forwardBars: number;
}
const parkedSearches = new Map<string, ParkedSearch>();

/** Test hook: the cache is deliberately module-level, so suites must clear it. */
export function clearParkedPatternSearches(): void {
  parkedSearches.clear();
}

interface Args {
  epic: string;
  broker: string;
  priceSide: string;
  resolution: string;
  getBars: () => PatternBar[];
}

export function usePatternSearch({ epic, broker, priceSide, resolution, getBars }: Args) {
  const [result, setResult] = useState<PatternSearchResult | null>(null);
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
  // Mirrored into refs because `run` is a useCallback that must not take them
  // as deps: reading them out of the closure would send the value from BEFORE
  // the change on the very re-run the change triggers.
  const modeRef = useRef(mode);
  const forwardBarsRef = useRef(forwardBars);
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
      searchPatterns({
        epic,
        resolution,
        priceSide,
        broker,
        query,
        queryFromTs: query[0].ts,
        queryToTs: query[query.length - 1].ts,
        topK: TOP_K,
        forwardBars: forwardBarsRef.current,
        mode: modeRef.current,
      })
        .then((res) => {
          if (reqRef.current !== id) return;
          setResult(res);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (reqRef.current !== id) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    },
    [epic, broker, priceSide, resolution, getBars],
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
      return saved.range;
    },
    [],
  );

  return {
    result, loading, error, range, truncatedTo, run, dismiss,
    mode, setMode, forwardBars, setForwardBars, parkLive, adoptSeries,
  };
}
