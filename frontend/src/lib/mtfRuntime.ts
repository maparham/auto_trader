// The extendData keys under `mtf` that are RUNTIME state rather than authored
// settings: the per-HTF-bar series, the detected line/pivot lists and the
// forming-bar fold state. The coordinator recomputes all of them from the HTF
// candles on load, so only `mtf.timeframe` (and the waitClose flag beside it)
// is ever worth keeping.
//
// A leaf module with no imports of its own, purely to avoid a cycle: both the
// rule clipboard (lib/ruleClipboard) and the per-cell settings store
// (lib/persist/artifacts) need this list, and artifacts importing ruleClipboard
// would drag backtestConfig and exprInstances into the persistence layer.
//
// Keeping these OUT of storage is not just about size. They are computed
// output, so their shape follows the detector: a stash written by an older
// build restores objects the current draw path does not recognise, and the
// Sept 2026 `touchKinds` addition turned exactly that into a frozen chart
// (see touchKindAt in lib/indicators/trendlines.ts).

export const MTF_RUNTIME_KEYS = [
  "htfStarts",
  "htfSeries",
  "htfSmoothing",
  "htfMs",
  "htfSeriesByLine",
  "htfMaBaseByLine",
  "htfAccelByLine",
  // S/R Levels: the per-HTF-bar nearest support and resistance series.
  "htfSupport",
  "htfResistance",
  // Auto Fib: the pair current on each HTF bar, the pair list and the pivots.
  "htfFibPairIdx",
  "htfFibPairs",
  "htfFibPivots",
  // Trendlines: the config-driven operand rows, the detected line list, the
  // per-HTF-bar pivot arrays and the HTF ATR the merge tolerances are
  // measured in.
  "htfOutputs",
  "htfPoints",
  "htfLines",
  "htfPivots",
  "htfAtr",
  "htfBars",
  // Forming-bar mode's per-session fold state (waitClose itself is CONFIG and
  // ships): the flag and inputs are re-derived by the coordinator on the
  // target, and htfClosed is a whole candle array besides.
  "formingIdx",
  "htfClosed",
  "htfSeed",
  // The viewport-scoped coverage stamps: what the last walk ASKED for, on this
  // chart's data window. Meaningless once the window is gone.
  "coveredFromMs",
  "coveredToMs",
] as const;

/** `extendData.mtf` with the runtime arrays dropped, or the same object back
 * when there is nothing under `mtf` to drop. Returns a copy; never mutates. */
export function stripMtfRuntime(
  extendData: Record<string, unknown>,
): Record<string, unknown> {
  const mtf = extendData.mtf;
  if (typeof mtf !== "object" || mtf === null) return extendData;
  const m = { ...(mtf as Record<string, unknown>) };
  let dropped = false;
  for (const k of MTF_RUNTIME_KEYS) {
    if (k in m) {
      delete m[k];
      dropped = true;
    }
  }
  return dropped ? { ...extendData, mtf: m } : extendData;
}
