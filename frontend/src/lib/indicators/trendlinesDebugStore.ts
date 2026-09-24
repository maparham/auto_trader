// Per-chart debug state for TRENDLINES instances: the last result, the pending
// run, the user's target line, similarity limits and hidden reason groups.
// The draw path calls requestDebug every frame; a run happens only when the
// request key changes, off the draw (async, chunked), and a landed result
// repaints the instance by bumping extendData.debugRev.
import type { Chart, KLineData } from "klinecharts";
import { overrideExtend } from "../overrideExtend";
import { floorIdxOf, type TrendlinesExtend } from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";
import { runDebugAsync, type DebugRun, type DebugRunInput } from "./trendlinesDebug";
import { DEBUG_SAMPLE, explain, type TlDebugResult } from "./trendlinesDebugExplain";
import {
  forcedPairsFor, lookup, SIM_DEFAULTS, targetToIdx, type Match, type SimLimits, type TargetIdx, type TargetLine,
} from "./trendlinesDebugLookup";
import type { ForcedPair } from "./trendlinesDebug";

export interface DebugEntry {
  key: string;
  /** The replay behind `result`. Kept so a new close (a tick, or the chart's
   * close moving under a pin) re-runs explain only, never the replay. */
  run: DebugRun | null;
  result: TlDebugResult | null;
  /** The newest close a draw asked for (DebugRunInput.evalClose). */
  close: number | null;
  /** A re-explain at `close` is scheduled off the draw. */
  reexplain: boolean;
  pending: { key: string; ctl: AbortController } | null;
  target: TargetLine | null;
  targetError: string | null;
  sim: SimLimits;
  hidden: Set<string>;
  /** Groups painted in full rather than sampled (DEBUG_SAMPLE nearest). */
  expanded: Set<string>;
  rev: number;
  paneId: string;
  input: DebugRunInput | null;
  /** The target resolved against one bars array: recomputed only when the
   * bars key, eval index, target or Min Length change, never per frame
   * (chart draw perf rule: no whole-series allocations in the draw). */
  tmemo: {
    bars: string; evalIdx: number; target: TargetLine; pivotLen: number;
    tgt: TargetIdx | { error: string }; forced: ForcedPair[];
  } | null;
  /** The target's lookup against `result`: once per (result, target, sim),
   * shared by the draw and the strip. Never per frame. */
  lmemo: { res: TlDebugResult; tgt: TargetIdx; sim: SimLimits; out: DebugLookup } | null;
}

export interface DebugLookup {
  matches: Match[];
  covered: Match | null;
  /** Candidate keys of `matches`, for the paint filter. */
  keys: Set<string>;
}

const STORE = new WeakMap<object, Map<string, DebugEntry>>();
const LISTENERS = new WeakMap<object, Set<() => void>>();
const ARRAY_IDS = new WeakMap<object, number>();
let nextArrayId = 1;
const idOf = (a: object) => {
  let id = ARRAY_IDS.get(a);
  if (!id) ARRAY_IDS.set(a, (id = nextArrayId++));
  return id;
};

export function debugState(chart: object, name: string): DebugEntry {
  let byName = STORE.get(chart);
  if (!byName) STORE.set(chart, (byName = new Map()));
  let e = byName.get(name);
  if (!e) {
    e = {
      key: "", run: null, result: null, close: null, reexplain: false, pending: null, target: null, targetError: null,
      sim: { ...SIM_DEFAULTS }, hidden: new Set(), expanded: new Set(), rev: 0, paneId: "candle_pane",
      input: null, tmemo: null, lmemo: null,
    };
    byName.set(name, e);
  }
  return e;
}

export function subscribeDebug(chart: object, fn: () => void): () => void {
  let set = LISTENERS.get(chart);
  if (!set) LISTENERS.set(chart, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
/** Listeners for every chart: the strip's hook mounts before its chart
 * exists, so it cannot subscribe per chart. */
const ANY = new Set<() => void>();
export function subscribeDebugAny(fn: () => void): () => void {
  ANY.add(fn);
  return () => ANY.delete(fn);
}
const notify = (chart: object) => {
  LISTENERS.get(chart)?.forEach((fn) => fn());
  ANY.forEach((fn) => fn());
};

/** Debug-on instance names per chart, as the draw path last saw them. A
 * toggle (on or off) changes no run result, so without this the strip
 * would only appear or disappear on the host's next unrelated render. */
const DEBUG_ON = new WeakMap<object, Set<string>>();
export function noteDebugOn(chart: object, name: string, on: boolean): void {
  let set = DEBUG_ON.get(chart);
  if (!set) DEBUG_ON.set(chart, (set = new Set()));
  if (set.has(name) === on) return;
  if (on) set.add(name);
  else set.delete(name);
  notify(chart);
}

export function repaintDebug(chart: object, paneId: string, name: string): void {
  const e = debugState(chart, name);
  e.rev++;
  overrideExtend(chart as Chart, paneId, name, { debugRev: e.rev });
  notify(chart);
}

/** Visible bar range widened and bucketed, so a small pan keeps the key.
 * Bucketed off the CENTER of the range rather than its two edges
 * independently: bucketing `a` and `b` each on their own can put them in
 * different cells right at a boundary (a span whose right edge sits exactly
 * on a bucket line), which would defeat the whole point of bucketing. */
export function debugWindow(from: number, to: number, toLine: (j: number) => number): [number, number] {
  const a = Math.floor(toLine(from));
  const b = Math.ceil(toLine(to));
  const bucket = Math.max(50, Math.round((b - a) / 2));
  const cell = Math.floor((a + b) / 2 / bucket);
  return [cell * bucket - bucket, cell * bucket + 2 * bucket];
}

/** What to replay: the chart's bars under the session floor, or the pinned
 * timeframe's stashed bars. `lastIdx` is the draw path's eval index. */
export function debugInputFor(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
  ext: TrendlinesExtend | undefined,
  lastIdx: number,
  window: [number, number],
  /** The draw's close (dataList[last].close); see DebugRunInput.evalClose. */
  evalClose?: number,
): DebugRunInput | { error: string } {
  const mtf = ext?.mtf;
  if (mtf?.timeframe) {
    const htf = mtf.htfBars;
    if (!htf?.length) return { error: "Reload the timeframe to debug." };
    const evalIdx = Math.min(lastIdx, htf.length - 1);
    // Key off htfStarts, the same timestamps the draw's lineKey uses under a
    // pin, so a debug key and a drawn line's key always agree.
    const starts = mtf.htfStarts?.length ? mtf.htfStarts : undefined;
    // Wait off refolds the forming bar into a NEW htfBars array every ~1s;
    // the closed bars only change when a bar closes (or on a refetch), so
    // they key the run. The forming bar's own tick shows through evalClose.
    const closed = mtf.waitClose === false && mtf.htfClosed?.length ? mtf.htfClosed : undefined;
    return {
      bars: htf, cfg, startIdx: 0, evalIdx, window, forced: [],
      ...(starts ? { starts } : {}),
      ...(closed ? { keyBars: closed } : {}),
      ...(evalClose !== undefined ? { evalClose } : {}),
    };
  }
  if (!dataList.length) return { error: "No bars loaded." };
  const startIdx = Math.min(floorIdxOf(dataList, ext?.tlFloorTs), dataList.length - 1);
  return {
    bars: dataList, cfg, startIdx, evalIdx: Math.min(lastIdx, dataList.length - 1), window, forced: [],
    ...(evalClose !== undefined ? { evalClose } : {}),
  };
}

/** Identity for the chart's bars; CONTENT for keyBars, since every Wait-off
 * fold writes the stash through overrideIndicator and klinecharts deep-copies
 * it, so htfClosed is a new array each second with the same bars in it. */
const keySig = (inp: DebugRunInput): string => {
  const k = inp.keyBars;
  if (!k) return `${idOf(inp.bars)}:${inp.bars.length}`;
  return k.length ? `c${k.length}:${k[0].timestamp}:${k[k.length - 1].timestamp}` : "c0";
};

/** Everything but the window: when only it moved, the previous result
 * stays on screen while the new run is pending. The target is in here: an
 * old result has the old target's forced lines and none of the new one's. */
const baseKeyFor = (inp: DebugRunInput, e: DebugEntry) =>
  [
    keySig(inp), inp.bars[inp.evalIdx]?.timestamp, inp.startIdx, inp.evalIdx,
    JSON.stringify(inp.cfg),
    e.target ? `${e.target.t1}:${e.target.p1}:${e.target.t2}:${e.target.p2}` : "",
  ].join("|");

/** The run key. The close is NOT in it (see DebugEntry.run). */
const keyFor = (inp: DebugRunInput, e: DebugEntry) => `${baseKeyFor(inp, e)}#${inp.window[0]}|${inp.window[1]}`;
const baseOf = (key: string) => key.slice(0, key.indexOf("#"));

/** The entry's target in `input`'s bar space, memoised (see tmemo). */
export function debugTarget(
  e: DebugEntry, input: DebugRunInput,
): { tgt: TargetIdx | { error: string }; forced: ForcedPair[] } | null {
  const target = e.target;
  if (!target) return null;
  const m = e.tmemo;
  const kb = keySig(input);
  if (m && m.bars === kb && m.evalIdx === input.evalIdx && m.target === target && m.pivotLen === input.cfg.pivotLen)
    return m;
  const times: number[] = new Array(input.evalIdx + 1);
  for (let j = 0; j <= input.evalIdx; j++) times[j] = input.starts?.[j] ?? input.bars[j].timestamp;
  // Pinned (starts set): a click belongs to the HTF bar that contains it.
  const tgt = targetToIdx(times, target, input.starts ? "containing" : "nearest");
  let forced: ForcedPair[] = [];
  if (!("error" in tgt)) {
    const highs = input.bars.map((b) => b.high);
    const lows = input.bars.map((b) => b.low);
    forced = forcedPairsFor(highs, lows, tgt, input.cfg.pivotLen);
  }
  e.tmemo = { bars: kb, evalIdx: input.evalIdx, target, pivotLen: input.cfg.pivotLen, tgt, forced };
  return e.tmemo;
}

/** Re-explain the kept run at the entry's newest close, off the draw. The
 * replay is untouched: only the gates, ranking and merge move with a tick. */
function scheduleReexplain(chart: object, paneId: string, name: string, e: DebugEntry): void {
  if (e.reexplain || !e.run || !e.result || e.close === null || e.result.close === e.close) return;
  e.reexplain = true;
  const run = e.run;
  setTimeout(() => {
    e.reexplain = false;
    const close = e.close;
    if (e.run !== run || close === null || e.result?.close === close) return;
    let result: TlDebugResult;
    try {
      result = explain(run, close);
    } catch {
      return;
    }
    e.result = result;
    if (e.input) e.input = { ...e.input, evalClose: close };
    repaintDebug(chart, paneId, name);
  }, 0);
}

/** The current result when it matches `input`, else null; starts (or keeps)
 * the run that will produce it. While a run for a new WINDOW (or target) is
 * pending over the same bars, cfg and eval bar, the previous result stays up
 * rather than the layer blinking off for the run's duration. */
export function requestDebug(
  chart: object, paneId: string, name: string, input: DebugRunInput,
): TlDebugResult | null {
  const e = debugState(chart, name);
  e.paneId = paneId;
  const t = debugTarget(e, input);
  e.targetError = t && "error" in t.tgt ? t.tgt.error : null;
  const forced = t ? t.forced : input.forced;
  const full: DebugRunInput = { ...input, forced };
  if (full.evalClose !== undefined) e.close = full.evalClose;
  const key = keyFor(full, e);
  const stale = e.result && e.key && baseOf(e.key) === baseOf(key) ? e.result : null;
  if (e.key === key) {
    // Back on the cached key (a pan out and back): a run started for the
    // other key is moot now, and left pending it would land and replace
    // the result this frame is showing.
    if (e.pending) {
      e.pending.ctl.abort();
      e.pending = null;
    }
    scheduleReexplain(chart, paneId, name, e);
    return e.result;
  }
  if (e.pending?.key === key) return stale;
  e.pending?.ctl.abort();
  const ctl = new AbortController();
  e.pending = { key, ctl };
  void runDebugAsync(full, ctl.signal)
    .then((run) => {
      if (!run || e.pending?.ctl !== ctl) return;
      // explain first: if it throws, no state has moved yet, so the new key
      // can never end up holding the previous key's result. At the NEWEST
      // close seen, not the one this run started with.
      const close = e.close ?? undefined;
      const result = explain(run, close);
      e.pending = null;
      e.key = key;
      e.run = run;
      e.input = close !== undefined ? { ...full, evalClose: close } : full;
      e.result = result;
      repaintDebug(chart, paneId, name);
    })
    // A run (or explain) that throws must not wedge the key: left pending,
    // every later frame would see pending.key === key and never settle.
    // Record it as the current key with no result, so the same input does
    // not retry on every redraw (crosshair moves); a new key retries.
    .catch(() => {
      if (e.pending?.ctl !== ctl) return;
      e.pending = null;
      e.key = key;
      e.run = null;
      e.input = null;
      e.result = null;
    });
  return stale;
}

export function setDebugTarget(chart: object, paneId: string, name: string, target: TargetLine | null): void {
  debugState(chart, name).target = target;
  repaintDebug(chart, paneId, name);
}

export function setDebugSim(chart: object, paneId: string, name: string, sim: SimLimits): void {
  debugState(chart, name).sim = sim;
  repaintDebug(chart, paneId, name);
}

/** The target's lookup against `res`, memoised (see DebugEntry.lmemo). */
export function debugLookup(e: DebugEntry, res: TlDebugResult, tgt: TargetIdx): DebugLookup {
  const m = e.lmemo;
  if (m && m.res === res && m.tgt === tgt && m.sim === e.sim) return m.out;
  const { matches, covered } = lookup(res, tgt, e.sim);
  const out = { matches, covered, keys: new Set(matches.map((x) => x.cand.key)) };
  e.lmemo = { res, tgt, sim: e.sim, out };
  return out;
}

/** A strip click: sampled, then all (only when the group has more than it
 * samples), then hidden, then sampled again. `n` is the group's size; the
 * pivots entry passes 0 and just toggles. */
export function cycleDebugGroup(chart: object, paneId: string, name: string, group: string, n: number): void {
  const e = debugState(chart, name);
  if (e.hidden.has(group)) e.hidden.delete(group);
  else if (e.expanded.has(group)) {
    e.expanded.delete(group);
    e.hidden.add(group);
  } else if (n > DEBUG_SAMPLE) e.expanded.add(group);
  else e.hidden.add(group);
  repaintDebug(chart, paneId, name);
}
