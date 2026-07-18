// Computes each indicator series a BacktestConfig references, keyed by the
// seriesName contract (backtestConfig.ts) so the backend can validate every
// name it needs is present without knowing anything about indicator math.
//
// An operand may name a higher timeframe than the run's base (op.timeframe): for
// those we fetch that timeframe's candles, compute the indicator on them, and
// forward-fill the result onto the base bars with alignHtfToChart (closed-bar,
// no lookahead). The emitted array is always base-length, so the backend — which
// only does positional arr[i] lookups and requires len(series)==len(candles) —
// needs no knowledge that a timeframe was involved.

import type { KLineData } from "klinecharts";
import { maSeries, sma, alignHtfToChart, normalizeMaKind, type MaOptions } from "./mtf";
import {
  vwapFrom, computeRsi, computeLr, computePrevHl, templateMaKind,
  DIVERGENCE_KINDS, cfgForKind, divergenceEventSeries,
  type AvwapExtend, type RsiExtend, type LrExtend, type PrevHlExtend,
} from "./customIndicators";
import {
  collectSeriesOperands, seriesName, slopeLen, riskAtrLengths, scalingAtrLengths,
  type BacktestConfig, type Operand, type IndicatorRecipe, type DrawingRecipe, type SeriesRecipe,
} from "./backtestConfig";
import { atrSeries } from "./atr";
import { computePivotBands, type PivotBandsExtend } from "./indicators/pivotBands";
import { computePivotAnalysis } from "./indicators/pivotAnalysis";
import { slopeLineSeries, accelLineSeries, inferBarHours, slopeLengths, type SlopeUnit, type SlopeExtend } from "./indicators/slope";
import { patternLineSeries } from "./indicators/candlePatterns";
import { RESOLUTION_SECONDS } from "./feed";

function toNullable(arr: Array<number | undefined>): Array<number | null> {
  return arr.map((v) => (v === undefined ? null : v));
}

/** Fetch the candles for one resolution over the same window as the base run.
 * Provided by the caller (BacktestButton) since it owns epic/window/broker. */
export type FetchTimeframe = (resolution: string) => Promise<KLineData[]>;

export async function buildSeries(
  candles: KLineData[],
  cfg: BacktestConfig,
  baseResolution: string,
  fetchTimeframe: FetchTimeframe,
): Promise<Record<string, Array<number | null>>> {
  const out: Record<string, Array<number | null>> = {};
  const baseTimestamps = candles.map((k) => k.timestamp);
  // Fetch each distinct higher timeframe once, even if several operands use it.
  const htfCache = new Map<string, KLineData[]>();

  for (const op of collectSeriesOperands(cfg)) {
    const name = seriesName(op);
    if (name === null) continue;
    const tf = op.kind === "indicator" || op.kind === "series" ? op.timeframe : undefined;
    if (!tf || tf === baseResolution) {
      out[name] = toNullable(derive(op, candles, tfHours(baseResolution)));
      continue;
    }
    let htf = htfCache.get(tf);
    if (!htf) {
      htf = await fetchTimeframe(tf);
      htfCache.set(tf, htf);
    }
    const htfMs = (RESOLUTION_SECONDS[tf] ?? 0) * 1000;
    // Slope MUST be taken on the native HTF values (inside derive), BEFORE the
    // forward-fill — diffing the forward-filled array would read 0 within each
    // held HTF value and spike at the boundary. The slope divides by elapsed time
    // in the operand's OWN timeframe, so pass the HTF's hours-per-bar.
    const aligned = alignHtfToChart(baseTimestamps, htf, derive(op, htf, tfHours(tf)), htfMs, true);
    out[name] = toNullable(aligned);
  }

  // ATR risk/scaling series are always base-timeframe (stops/targets execute on
  // the base bars), so they compute on the base candles directly.
  for (const length of riskAtrLengths(cfg)) {
    out[`ATR_${length}`] = atrSeries(candles, length);
  }
  for (const length of scalingAtrLengths(cfg)) {
    if (!out[`ATR_${length}`]) out[`ATR_${length}`] = atrSeries(candles, length);
  }

  return out;
}

/** Like `buildSeries`, but only for `kind:"series"` chart-operand/drawing
 * operands — the ones the backend can't recompute itself (it doesn't know
 * about on-chart indicator instances or drawings). Native indicators, price,
 * and slope-only operands are skipped: the backend now recomputes those from
 * the rule config directly, so the browser no longer ships them. ATR
 * risk/scaling series are dropped too (backend computes ATR). A chart operand
 * may still reference a higher timeframe, so the HTF fetch/align path is kept. */
export async function buildChartOperandSeries(
  candles: KLineData[],
  cfg: BacktestConfig,
  baseResolution: string,
  fetchTimeframe: FetchTimeframe,
): Promise<Record<string, Array<number | null>>> {
  const out: Record<string, Array<number | null>> = {};
  const baseTimestamps = candles.map((k) => k.timestamp);
  const htfCache = new Map<string, KLineData[]>();

  for (const op of collectSeriesOperands(cfg)) {
    if (op.kind !== "series") continue;
    const name = seriesName(op);
    if (name === null) continue;
    const tf = op.timeframe;
    if (!tf || tf === baseResolution) {
      out[name] = toNullable(derive(op, candles, tfHours(baseResolution)));
      continue;
    }
    let htf = htfCache.get(tf);
    if (!htf) {
      htf = await fetchTimeframe(tf);
      htfCache.set(tf, htf);
    }
    const htfMs = (RESOLUTION_SECONDS[tf] ?? 0) * 1000;
    const aligned = alignHtfToChart(baseTimestamps, htf, derive(op, htf, tfHours(tf)), htfMs, true);
    out[name] = toNullable(aligned);
  }

  return out;
}

/** Hours per bar for a resolution (the "TF" in the slope's time denominator).
 * Falls back to 1 hour for an unknown resolution. Sub-hour timeframes are < 1
 * (e.g. a 5-minute bar is 1/12 h). */
function tfHours(resolution: string): number {
  return (RESOLUTION_SECONDS[resolution] ?? 3600) / 3600;
}

/** An operand's per-bar values, applying its slope transform if it has one. The
 * slope is taken on `candles`' own values (native timeframe) so an HTF operand is
 * differenced before it's forward-filled onto the base bars, not after.
 * `barHours` is the hours-per-bar of THIS operand's timeframe. */
function derive(op: Operand, candles: KLineData[], barHours: number): Array<number | undefined> {
  const raw = computeRaw(op, candles, barHours);
  const n = slopeLen(op);
  return n === null ? raw : slopeOf(raw, n, barHours);
}

/** Tangent rate of change of `raw` in percent per HOUR over `n` bars:
 *   (v[i] − v[i−n]) / |v[i−n]| / (n × barHours) × 100
 * The run is elapsed time (n bars × barHours each), not bar count, so the slope
 * is in %/hr regardless of the operand's timeframe — a 5-min and a 15-min EMA
 * slope are directly comparable. undefined for the first `n` bars, wherever `raw`
 * is undefined, or where the denominator is 0. */
function slopeOf(raw: Array<number | undefined>, n: number, barHours: number): Array<number | undefined> {
  return raw.map((v, i) => {
    const prev = raw[i - n];
    if (i < n || v === undefined || prev === undefined || prev === 0) return undefined;
    return ((v - prev) / Math.abs(prev) / (n * barHours)) * 100;
  });
}

/** One indicator's per-bar values over the given candles (or a price field's, for
 * a sloped price operand), undefined where there's no value (warm-up gap, unplaced
 * AVWAP, missing volume). Pure in `candles`, so it runs identically on the base
 * bars or a higher timeframe's. */
function computeRaw(op: Operand, candles: KLineData[], barHours: number): Array<number | undefined> {
  if (op.kind === "price") return candles.map((k) => k[op.field] ?? undefined);
  if (op.kind === "series") return computeSeriesRecipe(op.recipe, candles, barHours);
  if (op.kind !== "indicator") return [];
  switch (op.indicator) {
    case "EMA":
    case "SMA":
      return maSeries(candles, templateMaKind(op.indicator), op.length ?? 0, {}).base;
    case "VOLMA":
      return sma(candles.map((k) => k.volume ?? 0), op.length ?? 0);
    case "VOL":
      return candles.map((k) => k.volume ?? undefined);
    case "AVWAP": {
      // Mirror the chart's AVWAP calc (customIndicators.ts): anchor is an epoch-ms
      // timestamp; <= 0 means unplaced (no line). Otherwise accumulate from the
      // first bar at/after the anchor. An anchor past the last bar -> all blank.
      const anchor = op.anchor ?? 0;
      if (anchor <= 0) return candles.map(() => undefined);
      const idx = candles.findIndex((k) => k.timestamp >= anchor);
      const start = idx < 0 ? candles.length : idx;
      return vwapFrom(candles, start, {}).map((p) => p.vwap ?? undefined);
    }
    case "RSI":
      // `.val` is always present; `.rsi` is omitted when the line is style-hidden,
      // which would silently null the series for a hidden RSI line.
      return computeRsi(candles, op.length ?? 14, {}).map((p) => p.val ?? undefined);
    default:
      return [];
  }
}

// --- chart operands (kind "series") -----------------------------------------

/** A copied chart operand's per-bar values. Runs the SAME pure compute function
 * the chart uses (so the operand reproduces the exact curve), then extracts the
 * selected output line. Pure in `candles`, so MTF just runs it on HTF bars. */
function computeSeriesRecipe(recipe: SeriesRecipe, candles: KLineData[], barHours: number): Array<number | undefined> {
  return recipe.source === "indicator"
    ? computeIndicatorRecipe(recipe, candles, barHours)
    : computeDrawingRecipe(recipe, candles);
}

// Output-line keys per indicator type, in the chart template's figure order, so a
// recipe's numeric `line` resolves to the right series (EMA/MA are handled apart:
// maSeries returns {base, smoothing} rather than a keyed point array).
export const LINE_KEYS: Record<string, readonly string[]> = {
  LR: ["lr", "up", "dn"],
  VWAP: ["vwap"],
  AVWAP: ["vwap"],
  PREV_HL: ["rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow", "anchorHigh", "anchorLow"],
  PIVOT_BANDS: ["pivotHigh", "pivotLow"],
  PIVOT_ANALYSIS: ["pivotHigh", "pivotLow", "deltaPct", "deltaT"],
};

function pickLine(points: Array<Record<string, unknown>>, keys: readonly string[], line: number): Array<number | undefined> {
  const key = keys[line] ?? keys[0];
  return points.map((p) => {
    const v = p[key];
    return typeof v === "number" ? v : undefined;
  });
}

// `_barHours` is intentionally unused by every case below except SLOPE, which
// deliberately ignores it in favor of inferBarHours(candles) for visual parity
// (see the SLOPE case). Threaded through only so the signature stays uniform
// with computeSeriesRecipe/computeRaw.
export function computeIndicatorRecipe(r: IndicatorRecipe, candles: KLineData[], _barHours: number): Array<number | undefined> {
  const ext = (r.extend ?? {}) as Record<string, unknown>;
  const line = r.line ?? 0;
  switch (r.indicatorType) {
    case "EMA":
    case "MA": {
      // The Type dropdown rides on extendData.maType; the recipe must honor it
      // or a flipped instance's rule would silently compute the template kind.
      const kind = normalizeMaKind(
        (ext as { maType?: unknown }).maType,
        templateMaKind(r.indicatorType),
      );
      const ma = maSeries(candles, kind, r.calcParams[0] ?? 0, ext as MaOptions);
      return line === 1 && ma.smoothing ? ma.smoothing : ma.base;
    }
    case "LR": {
      const pts = computeLr(candles, r.calcParams[0] ?? 0, r.calcParams[1] ?? 0, ext as LrExtend);
      return pickLine(pts as unknown as Array<Record<string, unknown>>, LINE_KEYS.LR, line);
    }
    case "VWAP":
    case "AVWAP": {
      // AVWAP accumulates from the first bar at/after its anchor (calcParams[0]);
      // plain VWAP accumulates from bar 0. Anchor <= 0 (or past the last bar) means
      // unplaced -> no line. Mirrors the chart's calc and computeRaw's AVWAP path.
      let start = 0;
      if (r.indicatorType === "AVWAP") {
        const anchor = r.calcParams[0] ?? 0;
        if (anchor <= 0) return candles.map(() => undefined);
        const idx = candles.findIndex((k) => k.timestamp >= anchor);
        start = idx < 0 ? candles.length : idx;
      }
      return vwapFrom(candles, start, ext as AvwapExtend).map((p) => p.vwap ?? undefined);
    }
    case "PREV_HL": {
      const pts = computePrevHl(candles, ext as PrevHlExtend);
      return pickLine(pts as unknown as Array<Record<string, unknown>>, LINE_KEYS.PREV_HL, line);
    }
    case "RSI": {
      // line 0 = the RSI value line (unchanged). line ≥ 1 = a confirmed-divergence
      // event series (0/1) for the kind at DIVERGENCE_KINDS[line-1], detected on the
      // same RSI curve the chart draws — see the divergence-operands design.
      const rext = ext as RsiExtend;
      const len = r.calcParams[0] ?? 14;
      const pts = computeRsi(candles, len, rext);
      const kind = line >= 1 ? DIVERGENCE_KINDS[line - 1] : undefined;
      if (!kind) return pts.map((p) => (line === 0 ? p.val ?? undefined : undefined));
      const rsi = pts.map((p) => p.val);
      return divergenceEventSeries(candles, rsi, cfgForKind(rext.divergence, kind), kind);
    }
    case "PIVOT_BANDS": {
      // N (strength) and K (avg window) clamped exactly like the chart template
      // (Math.max(1, …||default)) so the rule reproduces the on-chart curve — the
      // loose `?? 0` other cases use would give N=0 and break isPivotAt.
      const n = Math.max(1, Number(r.calcParams[0]) || 5);
      const k = Math.max(1, Number(r.calcParams[1]) || 3);
      const pts = computePivotBands(candles, n, k, ext as PivotBandsExtend);
      return pickLine(pts as unknown as Array<Record<string, unknown>>, LINE_KEYS.PIVOT_BANDS, line);
    }
    case "PIVOT_ANALYSIS": {
      // Strength (length) clamped exactly like the chart template so the rule
      // reproduces the on-chart values. Line 0/1 = forward-carried pivot high/low
      // price, 2/3 = the most recent swing's Δ%/Δt — all confirmed-only (no
      // lookahead), keys per LINE_KEYS.PIVOT_ANALYSIS.
      const length = Math.max(1, Number(r.calcParams[0]) || 50);
      const pts = computePivotAnalysis(candles, length);
      return pickLine(pts as unknown as Array<Record<string, unknown>>, LINE_KEYS.PIVOT_ANALYSIS, line);
    }
    case "SLOPE": {
      // Uses inferBarHours(candles) — NOT the threaded barHours param — so this
      // matches SLOPE_TEMPLATE.calc exactly (recipe/visual parity). The threaded
      // barHours instead drives the operand-level `~slope` transform in derive().
      // Four fixed blocks, relative to K = number of configured lengths:
      //   block 0 (line < K)      raw slope of lengths[j]
      //   block 1 (K..2K-1)       smoothed slope of lengths[j]
      //   block 2 (2K..3K-1)      acceleration of lengths[j]
      //   block 3 (3K..4K-1)      accel-smoothed acceleration of lengths[j]
      // Every block always resolves to a real value: a block whose toggle is off
      // degenerates (smoothing none is identity) rather than returning undefined,
      // because a dead operand would silently stop a rule.
      const sext = ext as SlopeExtend;
      const lengths = slopeLengths(r.calcParams);
      const K = lengths.length;
      const line = r.line ?? 0;
      const block = Math.floor(line / K);
      const len = lengths[line % K] ?? lengths[0];
      const maType = normalizeMaKind(sext.maType);
      const n = Number(sext.slopePeriod) || 3;
      const n2 = Number(sext.accelPeriod) || 3;
      const units: SlopeUnit = sext.units ?? "pctHr";
      const bh = inferBarHours(candles);
      if (block >= 2) {
        return accelLineSeries(candles, maType, len, n, n2, units, sext.source,
          sext.smoothing, block === 3 ? sext.accelSmoothing : undefined, bh);
      }
      return slopeLineSeries(candles, maType, len, n, units, sext.source,
        block === 1 ? sext.smoothing : undefined, bh);
    }
    case "CANDLE_PATTERNS": {
      // line < 24 = one canonical pattern; 24/25 = aggregate over the member ids
      // snapshotted in the recipe (never the live enable-set — spec: toggling
      // patterns on the chart must not silently change an existing rule).
      const members = ext.members as string[] | undefined;
      return patternLineSeries(candles, line, members);
    }
    default:
      return candles.map(() => undefined);
  }
}

/** A straight-line drawing as a per-bar price series. The line through two
 * absolute anchors (t0,v0)-(t1,v1) is price(t) = v0 + (v1−v0)·(t−t0)/(t1−t0);
 * each tool defines it over a different domain (undefined = no value at that bar):
 *   segment                 — only within [t0, t1]
 *   rayLine                 — forward from t0 (t >= t0)
 *   straightLine            — everywhere (both directions)
 *   horizontalStraightLine / priceLine — a flat constant at anchors[0].value. */
function computeDrawingRecipe(r: DrawingRecipe, candles: KLineData[]): Array<number | undefined> {
  const a = r.anchors;
  if (r.drawingKind === "horizontalStraightLine" || r.drawingKind === "priceLine") {
    const v = a[0]?.value;
    return candles.map(() => (typeof v === "number" ? v : undefined));
  }
  if (a.length < 2) return candles.map(() => undefined);
  // Keep the DRAWN anchor order: a[0] is the origin, a[1] the direction point —
  // this matters for a rayLine, which extends from a[0] THROUGH a[1] and beyond
  // (that direction may point backward in time if the user drew it leftward).
  const [o, d] = a;
  const dt = d.timestamp - o.timestamp;
  if (dt === 0) return candles.map(() => undefined); // vertical: not a function of t
  const slope = (d.value - o.value) / dt;
  const lo = Math.min(o.timestamp, d.timestamp);
  const hi = Math.max(o.timestamp, d.timestamp);
  return candles.map((k) => {
    const t = k.timestamp;
    if (r.drawingKind === "segment" && (t < lo || t > hi)) return undefined;
    // Ray: defined on the half-line from the origin toward the direction point,
    // i.e. (t − o.t) has the same sign as (d.t − o.t) (origin itself included).
    if (r.drawingKind === "rayLine" && (t - o.timestamp) * dt < 0) return undefined;
    return o.value + slope * (t - o.timestamp);
  });
}
