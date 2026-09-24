// TRENDLINES DEBUG RUN: replays the detector with a recording sink (TlSink in
// trendlines.ts). The sink sees every candidate the seeder deletes, every line
// that dies or loses the live cap, every pivot the size/reach gates reject, and
// it injects FORCED pairs (the user's own line, which the seeder may never
// try). Lines it records keep being stepped (touches, crossings, liveness) so
// the popup reports their true stats, not the ones they had at birth.
//
// Render-only, no Python twin. The detector's own state is never touched; see
// trendlinesDebug.parity.test.ts.
import type { KLineData } from "klinecharts";
import {
  finishSeed,
  initTlState,
  isLive,
  newSeed,
  stepCrossing,
  stepTrendlinesBar,
  touchWeight,
  type PivotKind,
  type SeedGate,
  type TlSink,
  type TlState,
  type TrendLine,
} from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";

export interface ForcedPair {
  i1: number;
  k1: PivotKind;
  i2: number;
  k2: PivotKind;
}

export interface DebugRecord {
  line: TrendLine;
  origin: "seed" | "died" | "evicted" | "forced";
  seedGate?: SeedGate;
  /** Bar the candidate was built (the second anchor's confirm bar). */
  bornAt: number;
  /** Bar it stopped being live by its own rules (Max Projection, Lookback),
   * or null while still live at the eval bar. */
  endedAt: number | null;
  endedBy?: "stale" | "lookback";
  /** Bar the MAX_LIVE cap cut it (origin "evicted"). */
  evictedAt?: number;
  forced?: ForcedPair & {
    /** Pool entries between the anchors at seed time (Max Pairs reads this),
     * or null when the first anchor never entered the pool. */
    poolGap: number | null;
    inMajor: boolean;
    /** The second anchor had not confirmed by the eval bar. */
    unconfirmed: boolean;
  };
  dropped?: boolean;
}

export interface RejectedPivot {
  idx: number;
  kind: PivotKind;
  gate: "size" | "reach";
}

export interface DebugRunInput {
  bars: KLineData[];
  cfg: TrendlinesConfig;
  /** Compute floor, the same one the main session uses. */
  startIdx: number;
  evalIdx: number;
  /** Bars (compute space) the view can show; records wholly outside are
   * not kept. */
  window: [number, number];
  forced: ForcedPair[];
  /** Stepping cap override (tests); default DEBUG_MAX_STEPPING. */
  maxStepping?: number;
  /** Bar-open timestamps the candidate keys are read from when they are NOT
   * `bars`' own: MTF runs pass the pin's htfStarts, the same timestamps the
   * draw keys its lines off. */
  starts?: number[];
  /** The close the gates, the ranking and the merge measure at: the draw's
   * own (the chart's newest close, dataList[last].close). Under a pin that
   * is not the HTF bar's close, and on a forming bar it moves every tick.
   * Default: bars[evalIdx].close. Never part of the run key: a new close
   * re-runs explain only (trendlinesDebugStore). */
  evalClose?: number;
  /** The bars that key the run by content (count, first and last
   * timestamp), when it is not `bars`. A Wait-off pin refolds its forming
   * bar every second into NEW arrays; keying on the closed bars
   * (mtf.htfClosed) keeps one run across those folds. */
  keyBars?: readonly { timestamp: number }[];
}

export interface DebugRun {
  st: TlState;
  records: DebugRecord[];
  rejectedPivots: RejectedPivot[];
  overflow: number;
  input: DebugRunInput;
}

/** Most records a run keeps: the ones still stepped PLUS the ones already
 * ended (died, or stopped being live) inside the window. When full, the
 * quarter with the OLDEST last touch is dropped (counted in `overflow`): the
 * run goes left to right and the view sits at the right edge, so the newest
 * candidates must win (spec: "most recent win"). Batched so eviction is
 * amortised O(log n). */
export const DEBUG_MAX_STEPPING = 3000;

const priceOf = (st: TlState, idx: number, kind: PivotKind): number =>
  kind === "high" ? st.highs[idx] : st.lows[idx];

/** First pool position at or after bar `idx` (pool is in bar order). */
function firstPoolAtOrAfter(pool: TlState["pool"], idx: number): number {
  let lo = 0;
  let hi = pool.idxs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pool.idxs[mid] < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function poolIndexOf(pool: TlState["pool"], idx: number, kind: PivotKind): number {
  for (let q = firstPoolAtOrAfter(pool, idx); q < pool.idxs.length && pool.idxs[q] === idx; q++)
    if (pool.kinds[q] === kind) return q;
  return -1;
}

interface RecordingSink extends TlSink {
  records: DebugRecord[];
  rejectedPivots: RejectedPivot[];
  overflow: number;
  finish(st: TlState, evalIdx: number, cfg: TrendlinesConfig): void;
}

function createSink(lo: number, hi: number, forced: ForcedPair[], maxStepping: number): RecordingSink {
  const records: DebugRecord[] = [];
  let stepping: DebugRecord[] = [];
  /** Kept records no longer stepped: died lines and ones that ended. They
   * count toward the cap like the stepped ones. */
  let ended: DebugRecord[] = [];
  const injected = new Set<ForcedPair>();
  const makeRoom = (): void => {
    if (stepping.length + ended.length < maxStepping) return;
    // Forced lines are the user's own and are never evicted.
    const byAge = [...stepping, ...ended]
      .filter((x) => x.origin !== "forced")
      .sort((a, b) => a.line.lastTouchIdx - b.line.lastTouchIdx);
    const cut = new Set(byAge.slice(0, Math.max(1, Math.floor(maxStepping / 4))));
    for (const x of cut) x.dropped = true;
    sink.overflow += cut.size;
    stepping = stepping.filter((x) => !cut.has(x));
    ended = ended.filter((x) => !cut.has(x));
  };
  const track = (r: DebugRecord): void => {
    makeRoom();
    records.push(r);
    stepping.push(r);
  };
  const inject = (st: TlState, f: ForcedPair, i: number, cfg: TrendlinesConfig, unconfirmed: boolean): void => {
    injected.add(f);
    const line = newSeed(f.i1, priceOf(st, f.i1, f.k1), f.k1, f.i2, priceOf(st, f.i2, f.k2), f.k2);
    finishSeed(st, line, firstPoolAtOrAfter(st.pool, f.i1), i, cfg);
    const q1 = poolIndexOf(st.pool, f.i1, f.k1);
    const q2 = poolIndexOf(st.pool, f.i2, f.k2);
    const poolGap = q1 < 0 ? null : (q2 >= 0 ? q2 : st.pool.idxs.length) - q1;
    const inMajor = q1 >= 0 && st.majors.q.includes(q1);
    track({
      line, origin: "forced", bornAt: i, endedAt: null,
      forced: { ...f, poolGap, inMajor, unconfirmed },
    });
  };
  const sink: RecordingSink = {
    records,
    rejectedPivots: [],
    overflow: 0,
    crossings(i, close) {
      for (const r of stepping) stepCrossing(r.line, i, close);
    },
    pivotRejected(_st, k, kind, gate) {
      if (k >= lo && k <= hi) sink.rejectedPivots.push({ idx: k, kind, gate });
    },
    pivotTouch(st, k, price, kind, cfg) {
      const tolA = st.atr[k];
      if (tolA === null) return;
      // Same bookkeeping as step 2a of stepTrendlinesBar.
      for (const r of stepping) {
        const line = r.line;
        if (k <= line.i2) continue;
        const w = touchWeight(line, k, price, kind, cfg.touchMult * tolA, cfg.pierceMult * tolA);
        if (w > 0) {
          line.touches += w;
          line.touchIdxs.push(k);
          line.touchKinds.push(kind);
          const gap = k - line.maxTouchIdx;
          if (gap > line.maxTouchGap) line.maxTouchGap = gap;
          if (gap < line.minTouchGap) line.minTouchGap = gap;
          line.maxTouchIdx = k;
          line.lastTouchIdx = k;
        }
      }
    },
    seedRejected(st, q, k, kind, price, i, cfg, gate) {
      const i1 = st.pool.idxs[q];
      if (i1 > hi) return;
      const k1 = st.pool.kinds[q];
      const line = newSeed(i1, priceOf(st, i1, k1), k1, k, price, kind);
      finishSeed(st, line, q + 1, i, cfg);
      track({ line, origin: "seed", seedGate: gate, bornAt: i, endedAt: null });
    },
    died(line, i, cfg) {
      if (i < lo || line.i1 > hi) return;
      const endedBy = i - line.lastTouchIdx > cfg.maxProjBars ? "stale" : "lookback";
      makeRoom();
      const r: DebugRecord = { line, origin: "died", bornAt: line.i2, endedAt: i, endedBy };
      records.push(r);
      ended.push(r);
    },
    evicted(lines, i) {
      for (const line of lines)
        if (line.i1 <= hi)
          track({ line, origin: "evicted", bornAt: line.i2, endedAt: null, evictedAt: i });
    },
    afterConfirm(st, i, cfg) {
      for (let s = stepping.length - 1; s >= 0; s--) {
        const r = stepping[s];
        if (isLive(r.line, i, cfg)) continue;
        stepping.splice(s, 1);
        r.endedAt = i;
        r.endedBy = i - r.line.lastTouchIdx > cfg.maxProjBars ? "stale" : "lookback";
        if (i < lo) r.dropped = true;
        else ended.push(r);
      }
      for (const f of forced)
        if (!injected.has(f) && f.i2 + cfg.pivotLen === i && f.i1 < f.i2) inject(st, f, i, cfg, false);
    },
    finish(st, evalIdx, cfg) {
      for (const f of forced)
        // Past the confirm bar without an afterConfirm (ATR warmup or the
        // compute floor): confirmed all the same, so not "unconfirmed".
        if (!injected.has(f) && f.i1 < f.i2 && f.i2 <= evalIdx)
          inject(st, f, evalIdx, cfg, f.i2 + cfg.pivotLen > evalIdx);
    },
  };
  return sink;
}

/** Yields every `chunk` bars so the async run can give the main thread back. */
function* steps(input: DebugRunInput, st: TlState, sink: RecordingSink, chunk: number): Generator<void> {
  const m = input.evalIdx + 1;
  for (let i = input.startIdx; i < m; i++) {
    stepTrendlinesBar(st, i, input.cfg, sink);
    if ((i - input.startIdx) % chunk === chunk - 1) yield;
  }
}

function prepare(input: DebugRunInput): { st: TlState; sink: RecordingSink } {
  const st = initTlState(input.bars, input.evalIdx + 1, input.startIdx);
  const sink = createSink(input.window[0], input.window[1], input.forced, input.maxStepping ?? DEBUG_MAX_STEPPING);
  return { st, sink };
}

function done(input: DebugRunInput, st: TlState, sink: RecordingSink): DebugRun {
  sink.finish(st, input.evalIdx, input.cfg);
  return {
    st,
    records: sink.records.filter((r) => !r.dropped),
    rejectedPivots: sink.rejectedPivots,
    overflow: sink.overflow,
    input,
  };
}

export function runDebugSync(input: DebugRunInput): DebugRun {
  const { st, sink } = prepare(input);
  for (const _ of steps(input, st, sink, Number.MAX_SAFE_INTEGER)) void _;
  return done(input, st, sink);
}

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The same run in chunks of bars, yielding between them. Resolves null when
 * `signal` aborts (checked at every yield and before starting). */
export async function runDebugAsync(
  input: DebugRunInput,
  signal?: AbortSignal,
  chunk = 1500,
): Promise<DebugRun | null> {
  if (signal?.aborted) return null;
  const { st, sink } = prepare(input);
  for (const _ of steps(input, st, sink, chunk)) {
    void _;
    await yieldToMain();
    if (signal?.aborted) return null;
  }
  return done(input, st, sink);
}
