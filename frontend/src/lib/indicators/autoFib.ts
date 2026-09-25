// frontend/src/lib/indicators/autoFib.ts
// AUTO_FIB: a fib retracement between the latest confirmed pivot high and the
// latest confirmed pivot low, redrawn as pivots confirm, optionally with the
// last N fibs dimmed.
//
// Causal (backtest-safe): strict fractal pivots (shared isPivotAt, called the
// way Trendlines calls it) exist only at their confirm bar k + pivotLen, and a
// pair changes only at confirm bars, so the pair active at bar i depends on
// bars [0..i] alone. Per-bar outputs are the rule operands: high, low, dir and
// one price per enabled level (autoFibOutputs).
//
// Ported operation-for-operation to backend/auto_trader/indicators/auto_fib.py;
// keep the arithmetic order identical (see core.py's parity contract).
import type { Indicator, IndicatorDrawParams, IndicatorTemplate, KLineData } from "klinecharts";
import { fibLevelSegments, type FibConfig } from "../fibConfig";
import { isPivotAt } from "./pivots";
import { isSignificantSwing, paintPivotMarks, type TrendPivots } from "./trendlines";
import { atrSeries } from "../atr";
import { alignHtfToChart, type MtfSeriesBase } from "../mtf";
import { htfBarEndMs } from "../mtfForming";
import { clipSegmentToRect, DRAW_CLIP_PAD } from "./shared";
import {
  AUTO_FIB_ATR_LEN,
  AUTO_FIB_DEFAULTS,
  AUTO_FIB_MAX_PAST,
  autoFibFibConfig,
  autoFibLevelOutputs,
  fibLevelPrice,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./autoFibOutputs";

export {
  AUTO_FIB_ATR_LEN,
  AUTO_FIB_DEFAULTS,
  AUTO_FIB_MAX_PAST,
  autoFibFibConfig,
  autoFibOutputs,
  autoFibWarmup,
  fibLevelPrice,
  fibOutputName,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./autoFibOutputs";

export interface AutoFibPair {
  hiIdx: number;
  hiPrice: number;
  loIdx: number;
  loPrice: number;
  // +1: the high is the later anchor (an up-leg, retracing down). -1: the low.
  dir: 1 | -1;
  startIdx: number; // confirm bar that made this pair current
  endIdx: number | null; // confirm bar that replaced it; null while current
}

interface Anchor {
  idx: number;
  price: number;
}

/** A pivot that counted: it passed the swing filter, so a fib can anchor to
 * it. What "Show pivots" marks. */
export interface AutoFibPivot {
  idx: number;
  kind: "high" | "low";
}

/** Walk the bars once. `pairOf[i]` is the index of the pair current at bar i
 * (undefined before the first pair). Index 0 is a real pair: compare with
 * `=== undefined`, never by truthiness. */
export function computeAutoFibPairs(
  dataList: KLineData[],
  cfg: AutoFibConfig,
): { pairOf: Array<number | undefined>; pairs: AutoFibPair[]; pivots: AutoFibPivot[] } {
  const len = dataList.length;
  const n = cfg.pivotLen;
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  // No ATR at all with the filter off: pivots count from the first bar, unlike
  // Trendlines, which waits for ATR even then.
  const atr = cfg.minSwingAtr > 0 ? atrSeries(dataList, AUTO_FIB_ATR_LEN) : null;
  // RAW fractal turns per kind, counted or not: the pool isSignificantSwing
  // measures the leg against, exactly as Trendlines keeps it.
  const turns: Record<"high" | "low", number[]> = { high: [], low: [] };
  let hi: Anchor | null = null;
  let lo: Anchor | null = null;
  const pairs: AutoFibPair[] = [];
  const pivots: AutoFibPivot[] = [];
  const pairOf: Array<number | undefined> = new Array(len).fill(undefined);

  for (let i = 0; i < len; i++) {
    const k = i - n;
    if (k >= 0) {
      let changed = false;
      for (const kind of ["high", "low"] as const) {
        const vals = kind === "high" ? highs : lows;
        if (!isPivotAt(vals, k, n, n, kind, true)) continue;
        turns[kind].push(k);
        if (atr) {
          const atrK = atr[k];
          if (atrK === null) continue;
          const opposite = turns[kind === "high" ? "low" : "high"];
          if (!isSignificantSwing(highs, lows, opposite, k, kind, atrK, cfg.minSwingAtr)) continue;
        }
        if (kind === "high") hi = { idx: k, price: highs[k] };
        else lo = { idx: k, price: lows[k] };
        pivots.push({ idx: k, kind });
        changed = true;
      }
      if (changed && hi !== null && lo !== null) {
        if (pairs.length) pairs[pairs.length - 1].endIdx = i;
        // Equal indices mean one outside bar is both pivots: its colour picks
        // which extreme came first (green: the low).
        const dir: 1 | -1 =
          hi.idx > lo.idx
            ? 1
            : hi.idx < lo.idx
              ? -1
              : dataList[k].close >= dataList[k].open
                ? 1
                : -1;
        pairs.push({
          hiIdx: hi.idx,
          hiPrice: hi.price,
          loIdx: lo.idx,
          loPrice: lo.price,
          dir,
          startIdx: i,
          endIdx: null,
        });
      }
    }
    if (pairs.length) pairOf[i] = pairs.length - 1;
  }
  return { pairOf, pairs, pivots };
}

/** One operand series (`high`, `low`, `dir` or a level name) over the bars.
 * An output the pane does not expose is all undefined. The parity golden
 * reads this. */
export function autoFibSeries(
  dataList: KLineData[],
  cfg: AutoFibConfig,
  fib: FibConfig,
  output: string,
): Array<number | undefined> {
  const { pairOf, pairs } = computeAutoFibPairs(dataList, cfg);
  const level = autoFibLevelOutputs(fib).find((l) => l.name === output);
  return pairOf.map((p) => {
    if (p === undefined) return undefined;
    const q = pairs[p];
    if (output === "high") return q.hiPrice;
    if (output === "low") return q.loPrice;
    if (output === "dir") return q.dir;
    return level ? fibLevelPrice(q.hiPrice, q.loPrice, q.dir, fib.reverse, level.value) : undefined;
  });
}

// ---------------------------------------------------------------------------
// MTF mapping + chart template
// ---------------------------------------------------------------------------

/** One pair computed on HTF bars, stashed with TIMESTAMPS so calc can map it
 * onto whatever chart bars are loaded. */
export interface AutoFibMtfPair {
  hiTs: number; // open of the HTF bar holding the high anchor
  hiPrice: number;
  loTs: number;
  loPrice: number;
  dir: 1 | -1;
}

/** One counted HTF pivot, keyed by TIMESTAMP like the pairs. */
export interface AutoFibMtfPivot {
  ts: number; // open of the HTF bar holding the pivot
  kind: "high" | "low";
  price: number;
}

export interface AutoFibExtend {
  fib?: FibConfig; // levels, colours, extend, reverse, trend line, labels
  pastCount?: number; // earlier fibs to draw dimmed, 0..AUTO_FIB_MAX_PAST
  pastOpacity?: number; // percent
  // Mark every counted pivot (plain arrow) and the anchors of the fibs on the
  // chart (stemmed arrow), with Trendlines' glyphs. Render-only.
  showPivots?: boolean;
  // Set by the MTF coordinator (applyAutoFibTimeframe); calc re-aligns it.
  mtf?: MtfSeriesBase & {
    htfStarts?: number[];
    htfMs?: number;
    htfFibPairIdx?: Array<number | undefined>; // pair current on each HTF bar
    htfFibPairs?: AutoFibMtfPair[];
    htfFibPivots?: AutoFibMtfPivot[];
  };
  hideLegendValue?: boolean;
}

export interface AutoFibPoint {
  high?: number;
  low?: number;
  dir?: number;
}

/** calc row. The pair list (and, with Show pivots on, the pivot marks in
 * chart bar space) ride on the LAST row only; draw reads them there. */
export interface AutoFibRow extends AutoFibPoint {
  pairs?: AutoFibPair[];
  marks?: TrendPivots;
}

const pointOf = (q: { hiPrice: number; loPrice: number; dir: number } | undefined): AutoFibPoint =>
  q ? { high: q.hiPrice, low: q.loPrice, dir: q.dir } : {};

/** First index with ts[i] >= t (ts ascending); ts.length when none. */
function lowerBound(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mapMtf(
  dataList: KLineData[],
  mtf: NonNullable<AutoFibExtend["mtf"]>,
  htfStarts: number[],
  htfMs: number,
  pairIdx: Array<number | undefined>,
  src: AutoFibMtfPair[],
  srcPivots: AutoFibMtfPivot[] | null,
): { points: AutoFibPoint[]; pairs: AutoFibPair[]; marks?: TrendPivots } {
  const ts = dataList.map((k) => k.timestamp);
  const htfBars = htfStarts.map((t) => ({ timestamp: t }) as KLineData);
  // The same closed-bar rule as every MTF series: a chart bar never sees a
  // pair whose HTF confirm bar closes in its future.
  // A stash that went through JSON (persistence, a clipboard) holds null for
  // an HTF bar with no pair, and an index can outlive a shorter pair list; both
  // read as "no pair" rather than reaching src[p] and throwing inside calc.
  const valid = (p: number | null | undefined): p is number =>
    typeof p === "number" && src[p] !== undefined;
  const aligned = alignHtfToChart(ts, htfBars, pairIdx, htfMs, true, mtf.formingIdx, mtf.chartMs, mtf.timeframe);
  const points = aligned.map((p) => pointOf(valid(p) ? src[p] : undefined));
  // One forward pass: the aligned index never decreases, so each pair is one run.
  const runs: Array<{ p: number; start: number }> = [];
  for (let i = 0; i < aligned.length; i++) {
    const p = aligned[i];
    if (!valid(p)) continue;
    if (!runs.length || runs[runs.length - 1].p !== p) runs.push({ p, start: i });
  }
  const chartMs = mtf.chartMs ?? (ts.length > 1 ? ts[1] - ts[0] : htfMs);
  const barEnd = (open: number) => htfBarEndMs(open, htfMs, mtf.timeframe ?? undefined);
  // An anchor older than the loaded bars gets a negative index, so its x
  // lands off-pane left instead of on the first loaded bar.
  const idxAt = (t: number): number =>
    ts.length && t < ts[0] ? Math.floor((t - ts[0]) / chartMs) : lowerBound(ts, t);
  // The anchor moves from the HTF bar's open to the chart candle whose high
  // (or low) traded nearest the anchor price, SR's snapFirst rule. Skipped
  // when the pin is not coarser than the chart or the span is not fully loaded.
  const snap = (openTs: number, price: number, side: "high" | "low", fallback: number): number => {
    if (!(htfMs > chartMs) || fallback < 0 || !ts.length) return fallback;
    const spanEnd = barEnd(openTs);
    if (ts[0] > openTs || ts[ts.length - 1] < spanEnd - chartMs) return fallback;
    let best = fallback;
    let bestD = Infinity;
    for (let i = fallback; i < ts.length && ts[i] < spanEnd; i++) {
      const d = Math.abs((side === "high" ? dataList[i].high : dataList[i].low) - price);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  // Calc runs on every tick; snapping scans a whole HTF bar of chart candles,
  // so only the pairs draw can ever show are snapped.
  const firstSnapped = Math.max(0, runs.length - (AUTO_FIB_MAX_PAST + 1));
  const pairs = runs.map((r, j): AutoFibPair => {
    const q = src[r.p];
    const hiAt = idxAt(q.hiTs);
    const loAt = idxAt(q.loTs);
    const snapIt = j >= firstSnapped;
    return {
      hiIdx: snapIt ? snap(q.hiTs, q.hiPrice, "high", hiAt) : hiAt,
      hiPrice: q.hiPrice,
      loIdx: snapIt ? snap(q.loTs, q.loPrice, "low", loAt) : loAt,
      loPrice: q.loPrice,
      dir: q.dir,
      startIdx: r.start,
      endIdx: j + 1 < runs.length ? runs[j + 1].start : null,
    };
  });
  if (!srcPivots) return { points, pairs };
  // Pivot marks, snapped by the same rule as the anchors so an anchor's mark
  // lands on its fib. Every pivot is snapped: each scan covers only its own
  // HTF bar, so the total is bounded by the loaded chart bars. A pivot whose
  // HTF bar has not closed on the chart yet is not shown: its pair is not
  // either (closed-bar rule).
  const lastUsable = runs.length ? src[runs[runs.length - 1].p] : undefined;
  const cutoff = lastUsable ? Math.max(lastUsable.hiTs, lastUsable.loTs) : -Infinity;
  const placed = srcPivots
    .filter((v) => v.ts <= cutoff)
    .map((v) => ({ ...v, idx: snap(v.ts, v.price, v.kind, idxAt(v.ts)) }))
    .sort((a, b) => a.idx - b.idx);
  return { points, pairs, marks: pivotMarks(placed, ts.length) };
}

/** Pivots in chart bar space as the TrendPivots shape paintPivotMarks reads:
 * ascending idxs, and the price held at that idx in highs or lows. */
function pivotMarks(
  placed: ReadonlyArray<{ idx: number; kind: "high" | "low"; price: number }>,
  len: number,
): TrendPivots {
  const highs: number[] = new Array(len);
  const lows: number[] = new Array(len);
  const idxs: number[] = [];
  const kinds: Array<"high" | "low"> = [];
  for (const v of placed) {
    if (v.idx < 0 || v.idx >= len) continue;
    idxs.push(v.idx);
    kinds.push(v.kind);
    if (v.kind === "high") highs[v.idx] = v.price;
    else lows[v.idx] = v.price;
  }
  return { idxs, kinds, highs, lows };
}

export function computeAutoFib(
  dataList: KLineData[],
  cfg: AutoFibConfig,
  ext?: Pick<AutoFibExtend, "mtf" | "showPivots">,
): { points: AutoFibPoint[]; pairs: AutoFibPair[]; marks?: TrendPivots } {
  const mtf = ext?.mtf;
  const wantMarks = ext?.showPivots === true;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfMs && mtf.htfFibPairIdx && mtf.htfFibPairs) {
    return mapMtf(
      dataList, mtf, mtf.htfStarts, mtf.htfMs, mtf.htfFibPairIdx, mtf.htfFibPairs,
      wantMarks ? (mtf.htfFibPivots ?? []) : null,
    );
  }
  const { pairOf, pairs, pivots } = computeAutoFibPairs(dataList, cfg);
  const points = pairOf.map((p) => pointOf(p === undefined ? undefined : pairs[p]));
  if (!wantMarks) return { points, pairs };
  const placed = pivots.map((v) => ({
    ...v,
    price: v.kind === "high" ? dataList[v.idx].high : dataList[v.idx].low,
  }));
  return { points, pairs, marks: pivotMarks(placed, dataList.length) };
}

const TREND_COLOR = "#787b86"; // the fib drawing's anchor connector
const LABEL_FONT = "12px -apple-system, system-ui, sans-serif";

function drawAutoFib(params: IndicatorDrawParams<AutoFibRow, unknown, unknown>): boolean {
  const { ctx, chart, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as AutoFibRow[];
  const lastRow = result[result.length - 1];
  const pairs = lastRow?.pairs ?? [];
  const ext = (indicator.extendData ?? {}) as AutoFibExtend;
  const fib = autoFibFibConfig(ext);
  const pastCount = Math.min(AUTO_FIB_MAX_PAST, Math.max(0, Math.floor(Number(ext.pastCount) || 0)));
  const pastAlpha = Math.min(1, Math.max(0.05, (Number(ext.pastOpacity) || 35) / 100));
  const lastIdx = chart.getDataList().length - 1;
  const precision =
    (chart as { getSymbol?: () => { pricePrecision?: number } | null }).getSymbol?.()?.pricePrecision ??
    indicator.precision ??
    2;
  // bounding.width runs under the y-axis strip; labels must stop short of it.
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const W = bounding.width;
  const H = bounding.height;
  const clampX = (x: number) => Math.min(W + DRAW_CLIP_PAD, Math.max(-DRAW_CLIP_PAD, x));
  const firstDrawn = Math.max(0, pairs.length - 1 - pastCount);

  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "bottom";
  for (let p = firstDrawn; p < pairs.length; p++) {
    const pair = pairs[p];
    const current = pair.endIdx === null;
    const up = pair.dir > 0;
    const ePrice = up ? pair.loPrice : pair.hiPrice;
    const lPrice = up ? pair.hiPrice : pair.loPrice;
    const e = { x: xAxis.convertToPixel(up ? pair.loIdx : pair.hiIdx), y: yAxis.convertToPixel(ePrice) };
    const l = { x: xAxis.convertToPixel(up ? pair.hiIdx : pair.loIdx), y: yAxis.convertToPixel(lPrice) };
    const extL = current && (fib.extend === "left" || fib.extend === "both");
    const extR = current && (fib.extend === "right" || fib.extend === "both");
    const rawX1 = extL ? 0 : e.x;
    const rawX2 = extR ? W : xAxis.convertToPixel(pair.endIdx ?? lastIdx);
    if (rawX2 < 0 || rawX1 > W) continue; // off-pane: cull
    const x1 = clampX(rawX1);
    const x2 = clampX(rawX2);
    ctx.globalAlpha = current ? 1 : pastAlpha;
    if (current && fib.trendLine) {
      const seg = clipSegmentToRect(e.x, e.y, l.x, l.y, -DRAW_CLIP_PAD, -DRAW_CLIP_PAD, W + DRAW_CLIP_PAD, H + DRAW_CLIP_PAD);
      if (seg) {
        ctx.strokeStyle = TREND_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
    }
    // fibLevelSegments supplies each level's y, colour, width/dash and label;
    // the x-span is this pane's own (anchor to replacement bar, or extended).
    const segs = fibLevelSegments({ cfg: fib, coordinates: [e, l], values: [ePrice, lPrice], boundingWidth: W, precision });
    for (const s of segs) {
      // The canvas is shared with the panes above and below.
      if (s.y < 0 || s.y > H) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size ?? 1;
      ctx.setLineDash(s.style === "dashed" ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x1, s.y);
      ctx.lineTo(x2, s.y);
      ctx.stroke();
      if (current && fib.labels) {
        const atEdge = x2 >= W - axisWidth - 1;
        ctx.fillStyle = s.color;
        ctx.textAlign = atEdge ? "right" : "left";
        ctx.fillText(s.label, atEdge ? W - axisWidth - 4 : x2 + 4, s.y - 2);
      }
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
  // Pivot marks go on top of the fibs, and paint even with no fib yet: a pane
  // whose filter admitted pivots of one kind only still shows them.
  if (ext.showPivots && lastRow?.marks) {
    const used = new Set<number>();
    for (let p = firstDrawn; p < pairs.length; p++) {
      used.add(pairs[p].hiIdx);
      used.add(pairs[p].loIdx);
    }
    paintPivotMarks(
      ctx,
      lastRow.marks,
      (j) => xAxis.convertToPixel(j),
      (price) => yAxis.convertToPixel(price),
      W - axisWidth - 4,
      H,
      used,
      true,
      true,
      TREND_COLOR,
    );
  }
  return true; // the fibs replace any default figure drawing
}

// Auto Fib: calcParams = [pivotLen, minSwingAtr].
export const AUTO_FIB_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Auto Fib",
  series: "price",
  precision: 2,
  calcParams: [AUTO_FIB_DEFAULTS.pivotLen, AUTO_FIB_DEFAULTS.minSwingAtr],
  // Figure-less like Trendlines: draw paints everything, so there are no line
  // figures to hang selection handles on (no ZONE_ONLY_TYPES entry needed).
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, pairs, marks } = computeAutoFib(
      dataList,
      parseAutoFibConfig(ind.calcParams),
      (ind.extendData ?? {}) as AutoFibExtend,
    );
    const out = points as AutoFibRow[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], pairs, ...(marks ? { marks } : {}) };
    return out;
  },
  draw: (params) => drawAutoFib(params as IndicatorDrawParams<AutoFibRow, unknown, unknown>),
};
