// RSI (TradingView "RSI") with optional DIVERGENCE detection. We deliberately
// REPLACE klinecharts' built-in RSI (which ships three lengths [6,12,24]) with a
// single-line, length-14 RSI matching TradingView — AND, unlike a built-in, this
// custom template can carry a `draw` callback so detected divergences are marked
// directly on the RSI plot. Divergence is OFF by default (extendData.divergence.on).
//
// RSI uses Wilder's smoothing (RMA), the same as TradingView's ta.rsi, so the
// curve matches TV rather than klinecharts' built-in. Length in calcParams[0];
// divergence config on extendData (RsiExtend).
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { priceOf, type PriceSource } from "../mtf";
import { hexToRgba } from "../lineStyle";
import { fullLine } from "./shared";
import { isPivotAt } from "./pivots";

export type DivergenceKind = "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";

// One divergence line to draw on the RSI pane: from a previous RSI pivot to the
// confirmed pivot at this bar. Stashed on the right-pivot bar's result point as a
// NON-figure field (klinecharts only reads figure keys, so it ignores `divs`).
interface DivSegment {
  kind: DivergenceKind;
  fromIndex: number; // previous pivot bar (data index)
  fromValue: number; // RSI at the previous pivot
  toIndex: number; // this bar (the confirmed pivot)
  toValue: number; // RSI here
  forming?: boolean; // tentative (partial-confirmation) pivot; may still be invalidated
}

interface RsiPoint {
  // The figure value (the klinecharts-drawn RSI line). Omitted when the line is
  // hidden via the Style tab (style.hidden.rsi) so klinecharts draws no line — while
  // `val` below keeps the value for the canvas-drawn elements.
  rsi?: number;
  // The RSI value, ALWAYS present (independent of line visibility) — used by the
  // gradient fills / divergence geometry in the draw callback.
  val?: number;
  // Optional smoothing MA of the RSI + Bollinger Bands around it (TV's RSI
  // "Smoothing"). Drawn in the `draw` callback (not figures), so adding them never
  // changes the figure count (the e2e single-line assertion stays valid).
  ma?: number;
  bbUp?: number;
  bbDn?: number;
  divs?: DivSegment[];
}

// RSI "Smoothing" moving-average type, mirroring TradingView's RSI panel options.
// "sma_bb" = SMA + Bollinger Bands (adds the ±stdDev bands around the SMA).
export type RsiSmoothType = "none" | "sma" | "sma_bb" | "ema" | "rma" | "wma" | "vwma";
export interface RsiSmoothing {
  type: RsiSmoothType;
  length: number;
  bbStdDev: number; // band width multiplier, only used for "sma_bb"
}
export const RSI_SMOOTHING_DEFAULTS: RsiSmoothing = {
  type: "none",
  length: 14,
  bbStdDev: 2,
};

// Divergence tuning, carried on extendData.divergence (set by the settings modal).
// Defaults mirror TradingView's "Divergence Indicator": pivot strength 5 each side,
// pivots 5–60 bars apart. Regular bull/bear on; hidden variants off; whole feature
// OFF until `on` is set.
export interface RsiDivergenceConfig {
  on: boolean;
  lookbackLeft: number; // pivot strength to the LEFT (bars before the pivot)
  lookbackRight: number; // pivot strength to the RIGHT (bars after; also the lag)
  rangeMin: number; // min bars between the two pivots
  rangeMax: number; // max bars between the two pivots
  bullish: boolean; // regular: price lower low + RSI higher low
  bearish: boolean; // regular: price higher high + RSI lower high
  hiddenBullish: boolean; // price higher low + RSI lower low
  hiddenBearish: boolean; // price lower high + RSI higher high
  showForming: boolean; // also mark the latest still-forming divergence
  formingLookbackRight: number; // right-side bars for a tentative (forming) pivot
  formingScanBack: boolean; // if the latest tail swing isn't diverging, scan older ones
}

export interface RsiExtend {
  source?: PriceSource; // price the RSI is computed on (default close, TV default)
  smoothing?: RsiSmoothing; // optional MA of the RSI (+ Bollinger Bands)
  divergence?: Partial<RsiDivergenceConfig>;
  style?: Partial<RsiStyle>; // Style-tab colours/levels for the canvas-drawn elements
  hideLegendValue?: boolean;
}

// The four divergence kinds in the order the RSI series operand exposes them as
// output lines: line 1 = bullish, 2 = bearish, 3 = hiddenBullish, 4 = hiddenBearish
// (line 0 is the RSI value). Single source of truth for the line ↔ kind mapping,
// shared by the compute (backtestSeries) and the picker enumeration (chartOperand).
export const DIVERGENCE_KINDS: readonly DivergenceKind[] = [
  "bullish",
  "bearish",
  "hiddenBullish",
  "hiddenBearish",
];

export const RSI_DIVERGENCE_DEFAULTS: RsiDivergenceConfig = {
  on: false,
  lookbackLeft: 5,
  lookbackRight: 5,
  rangeMin: 5,
  rangeMax: 60,
  bullish: true,
  bearish: true,
  hiddenBullish: false,
  hiddenBearish: false,
  showForming: false,
  formingLookbackRight: 2,
  formingScanBack: false,
};

// One RSI pivot: its bar index, the RSI value, and the price extreme used for the
// divergence comparison (the bar's low for low pivots, high for high pivots).
interface RsiPivot {
  index: number;
  rsi: number;
  price: number;
}

// Detect regular/hidden divergences by comparing each confirmed RSI pivot to the
// previous pivot of the same side, within [rangeMin, rangeMax] bars. Segments are
// appended to the right-pivot bar's result point so `draw` can render them.
export function detectDivergences(
  dataList: KLineData[],
  rsi: Array<number | undefined>,
  out: RsiPoint[],
  cfg: RsiDivergenceConfig,
): void {
  const n = rsi.length;
  const lbL = Math.max(1, Math.floor(cfg.lookbackLeft) || 1);
  const lbR = Math.max(1, Math.floor(cfg.lookbackRight) || 1);
  const lo = Math.max(1, Math.floor(cfg.rangeMin) || 1);
  const hi = Math.max(lo, Math.floor(cfg.rangeMax) || lo);
  // A pivot is confirmed only with lbL valid bars to the LEFT and lbR to the RIGHT
  // (so the most recent lbR bars never form one — the same confirmation lag as
  // TradingView's ta.pivothigh/low). Ties allowed (strict=false): `"low"` finds a
  // local minimum with no neighbour strictly lower, `"high"` a local maximum.
  const isPivot = (i: number, want: "low" | "high"): boolean =>
    isPivotAt(rsi, i, lbL, lbR, want, false);
  const add = (i: number, seg: DivSegment) => {
    (out[i].divs ??= []).push(seg);
  };
  let lastLow: RsiPivot | null = null;
  let lastHigh: RsiPivot | null = null;
  for (let i = 0; i < n; i++) {
    if (isPivot(i, "low")) {
      const price = dataList[i].low;
      const v = rsi[i] as number;
      if (lastLow) {
        const dist = i - lastLow.index;
        if (dist >= lo && dist <= hi) {
          // Regular bullish: price makes a LOWER low while RSI makes a HIGHER low.
          if (cfg.bullish && v > lastLow.rsi && price < lastLow.price)
            add(i, { kind: "bullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v });
          // Hidden bullish: price makes a HIGHER low while RSI makes a LOWER low.
          if (cfg.hiddenBullish && v < lastLow.rsi && price > lastLow.price)
            add(i, { kind: "hiddenBullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v });
        }
      }
      lastLow = { index: i, rsi: v, price };
    }
    if (isPivot(i, "high")) {
      const price = dataList[i].high;
      const v = rsi[i] as number;
      if (lastHigh) {
        const dist = i - lastHigh.index;
        if (dist >= lo && dist <= hi) {
          // Regular bearish: price makes a HIGHER high while RSI makes a LOWER high.
          if (cfg.bearish && v < lastHigh.rsi && price > lastHigh.price)
            add(i, { kind: "bearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v });
          // Hidden bearish: price makes a LOWER high while RSI makes a HIGHER high.
          if (cfg.hiddenBearish && v > lastHigh.rsi && price < lastHigh.price)
            add(i, { kind: "hiddenBearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v });
        }
      }
      lastHigh = { index: i, rsi: v, price };
    }
  }

  // Forming pass: the latest STILL-FORMING divergence on each side. A tentative
  // pivot uses the same rule as a confirmed one but only `formingLookbackRight`
  // bars to the right (< lbR), and must sit in the not-yet-confirmable tail
  // (i + lbR >= n) so it's a genuinely forming swing — not an old one that failed
  // full confirmation. It is compared to the last CONFIRMED pivot of its side.
  if (cfg.showForming) {
    // Forming right-lookback: at least 1 (never the noisy zero-right case) and strictly
    // less than the confirmed lbR. When lbR === 1 this yields fbR === 1 === lbR, and the
    // tail (`i + lbR >= n`) and `i + fbR < n` conditions below can't both hold — so no
    // forming pivot forms, the right outcome (no room for a "less confirmed" pivot).
    const fbR = Math.max(1, Math.min(lbR - 1, Math.max(1, Math.floor(cfg.formingLookbackRight) || 1)));
    const isFormingPivot = (i: number, want: "low" | "high"): boolean => {
      const v = rsi[i];
      if (v === undefined) return false;
      if (i - lbL < 0 || i + fbR >= n) return false;
      for (let j = i - lbL; j <= i + fbR; j++) {
        const w = rsi[j];
        if (w === undefined) return false;
        if (j !== i && (want === "low" ? w < v : w > v)) return false;
      }
      return true;
    };
    if (lastLow) {
      for (let i = n - 1; i > lastLow.index && i + lbR >= n; i--) {
        if (!isFormingPivot(i, "low")) continue;
        const dist = i - lastLow.index;
        if (dist > hi) continue;
        if (dist < lo) break;
        const v = rsi[i] as number;
        const price = dataList[i].low;
        let emitted = false;
        if (cfg.bullish && v > lastLow.rsi && price < lastLow.price) {
          add(i, { kind: "bullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v, forming: true });
          emitted = true;
        }
        if (cfg.hiddenBullish && v < lastLow.rsi && price > lastLow.price) {
          add(i, { kind: "hiddenBullish", fromIndex: lastLow.index, fromValue: lastLow.rsi, toIndex: i, toValue: v, forming: true });
          emitted = true;
        }
        // Default: stop at the most recent tentative low (even if it didn't diverge).
        // scanBack: keep looking at older in-range tail lows until one diverges.
        if (emitted || !cfg.formingScanBack) break;
      }
    }
    if (lastHigh) {
      for (let i = n - 1; i > lastHigh.index && i + lbR >= n; i--) {
        if (!isFormingPivot(i, "high")) continue;
        const dist = i - lastHigh.index;
        if (dist > hi) continue;
        if (dist < lo) break;
        const v = rsi[i] as number;
        const price = dataList[i].high;
        let emitted = false;
        if (cfg.bearish && v < lastHigh.rsi && price > lastHigh.price) {
          add(i, { kind: "bearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v, forming: true });
          emitted = true;
        }
        if (cfg.hiddenBearish && v > lastHigh.rsi && price < lastHigh.price) {
          add(i, { kind: "hiddenBearish", fromIndex: lastHigh.index, fromValue: lastHigh.rsi, toIndex: i, toValue: v, forming: true });
          emitted = true;
        }
        // Default: stop at the most recent tentative high (even if it didn't diverge).
        // scanBack: keep looking at older in-range tail highs until one diverges.
        if (emitted || !cfg.formingScanBack) break;
      }
    }
  }
}

// A divergence config that force-detects EXACTLY one kind: the pivot/range params
// come from the instance's config (or the defaults), but every per-kind flag except
// `kind` is turned off and the whole feature is turned on — so `detectDivergences`
// with this config yields only that kind's confirmed segments regardless of which
// kinds the source RSI instance had toggled. `showForming` is off (the operand is
// confirmed-only: no repaint, no lookahead).
export function cfgForKind(
  div: Partial<RsiDivergenceConfig> | undefined,
  kind: DivergenceKind,
): RsiDivergenceConfig {
  return {
    ...RSI_DIVERGENCE_DEFAULTS,
    ...(div ?? {}),
    on: true,
    bullish: kind === "bullish",
    bearish: kind === "bearish",
    hiddenBullish: kind === "hiddenBullish",
    hiddenBearish: kind === "hiddenBearish",
    showForming: false,
  };
}

// Confirmed divergences of one `kind` as a per-bar 0/1 event series: `1` on the bar
// a divergence of that kind confirms (its right pivot, `toIndex`), `0` everywhere
// else — including the warm-up (never undefined, so a rule comparison stays
// well-defined). Reuses the exact detector the chart draws with, so backtest ↔ live
// ↔ chart all agree. `cfg` should force-enable just `kind` (see `cfgForKind`).
export function divergenceEventSeries(
  dataList: KLineData[],
  rsi: Array<number | undefined>,
  cfg: RsiDivergenceConfig,
  kind: DivergenceKind,
): Array<0 | 1> {
  const out: RsiPoint[] = dataList.map(() => ({}));
  detectDivergences(dataList, rsi, out, cfg);
  return dataList.map((_, i) => (out[i].divs?.some((d) => d.kind === kind) ? 1 : 0));
}

// A moving average over a sparse series (undefined entries are "not ready yet", as
// in the RSI's warm-up). Each output index needs `length` consecutive DEFINED inputs
// ending at it; otherwise undefined. Mirrors TradingView's ta.* over an na-prefixed
// series. `vol` is required for "vwma" (volume-weighted). "rma" is Wilder's smoothing.
function smoothSeries(
  src: Array<number | undefined>,
  type: RsiSmoothType,
  length: number,
  vol?: number[],
): Array<number | undefined> {
  const n = src.length;
  const out: Array<number | undefined> = new Array(n).fill(undefined);
  const L = Math.max(1, Math.floor(length) || 1);
  if (type === "none") return out;
  if (type === "ema" || type === "rma") {
    // EMA/RMA recurse from the first L-window SMA seed over defined values.
    const alpha = type === "ema" ? 2 / (L + 1) : 1 / L;
    let prev: number | undefined;
    let seedSum = 0;
    let seedCount = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (v === undefined) continue;
      if (prev === undefined) {
        seedSum += v;
        seedCount++;
        if (seedCount === L) {
          prev = seedSum / L;
          out[i] = prev;
        }
      } else {
        prev = alpha * v + (1 - alpha) * prev;
        out[i] = prev;
      }
    }
    return out;
  }
  // SMA / WMA / VWMA: a trailing window of the last L defined values.
  for (let i = 0; i < n; i++) {
    if (src[i] === undefined) continue;
    // Walk back L defined values (they're contiguous once RSI is warm).
    let count = 0;
    let num = 0;
    let den = 0;
    for (let j = i; j >= 0 && count < L; j--) {
      const v = src[j];
      if (v === undefined) break;
      const w = type === "wma" ? L - count : type === "vwma" ? (vol?.[j] ?? 0) : 1;
      num += v * w;
      den += w;
      count++;
    }
    if (count === L && den > 0) out[i] = num / den;
  }
  return out;
}

// Wilder's RSI (RMA of gains/losses), seeded with the SMA of the first `length`
// changes — identical to TradingView's ta.rsi. The RSI is computed on `ext.source`
// (default close). When smoothing is set, an MA of the RSI (+ optional Bollinger
// Bands) is attached; when divergence is enabled, its segments are attached too —
// both consumed by the `draw` callback.
export function computeRsi(dataList: KLineData[], length: number, ext: RsiExtend): RsiPoint[] {
  const n = dataList.length;
  const out: RsiPoint[] = dataList.map(() => ({}));
  const period = Math.max(1, Math.floor(length) || 14);
  const source = ext.source ?? "close";
  const rsi: Array<number | undefined> = new Array(n).fill(undefined);
  if (n > period) {
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < n; i++) {
      const change = priceOf(dataList[i], source) - priceOf(dataList[i - 1], source);
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (i <= period) {
        avgGain += gain;
        avgLoss += loss;
        if (i === period) {
          avgGain /= period;
          avgLoss /= period;
          rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
  }
  // `val` always carries the RSI value (for the canvas-drawn fills/divergence); the
  // `rsi` figure key is omitted when the line is hidden (Style tab), so klinecharts
  // draws no line but the rest of the overlay still works.
  const hideLine = ext.style?.hidden?.rsi === true;
  for (let i = 0; i < n; i++) {
    if (rsi[i] === undefined) continue;
    out[i].val = rsi[i];
    if (!hideLine) out[i].rsi = rsi[i];
  }
  // Optional smoothing MA of the RSI (+ Bollinger Bands for "sma_bb").
  const sm: RsiSmoothing = { ...RSI_SMOOTHING_DEFAULTS, ...(ext.smoothing ?? {}) };
  if (sm.type !== "none") {
    const maType: RsiSmoothType = sm.type === "sma_bb" ? "sma" : sm.type;
    const vol = sm.type === "vwma" ? dataList.map((k) => k.volume ?? 0) : undefined;
    const ma = smoothSeries(rsi, maType, sm.length, vol);
    for (let i = 0; i < n; i++) if (ma[i] !== undefined) out[i].ma = ma[i];
    if (sm.type === "sma_bb") {
      // Bollinger Bands: SMA ± mult · population stdev of the RSI over the window.
      const L = Math.max(1, Math.floor(sm.length) || 1);
      for (let i = 0; i < n; i++) {
        const mid = ma[i];
        if (mid === undefined) continue;
        let sumSq = 0;
        let count = 0;
        for (let j = i; j >= 0 && count < L; j--) {
          const v = rsi[j];
          if (v === undefined) break;
          sumSq += (v - mid) * (v - mid);
          count++;
        }
        if (count === L) {
          const dev = sm.bbStdDev * Math.sqrt(sumSq / L);
          out[i].bbUp = mid + dev;
          out[i].bbDn = mid - dev;
        }
      }
    }
  }
  const cfg: RsiDivergenceConfig = { ...RSI_DIVERGENCE_DEFAULTS, ...(ext.divergence ?? {}) };
  if (cfg.on) detectDivergences(dataList, rsi, out, cfg);
  return out;
}

const DIV_LABEL: Record<DivergenceKind, string> = {
  bullish: "Bull",
  bearish: "Bear",
  hiddenBullish: "H Bull",
  hiddenBearish: "H Bear",
};

// Resolve a divergence segment's visual state. Three states, one bull/bear colour:
// confirmed-regular = solid/opaque, confirmed-hidden = dashed, forming = dotted +
// faded + a "?" suffix so it reads as provisional (may still be invalidated).
export function divVisual(seg: { kind: DivergenceKind; forming?: boolean }): {
  label: string;
  dash: number[];
  alpha: number;
} {
  const base = DIV_LABEL[seg.kind];
  if (seg.forming) return { label: `${base}?`, dash: [2, 3], alpha: 0.55 };
  const hidden = seg.kind === "hiddenBullish" || seg.kind === "hiddenBearish";
  return { label: base, dash: hidden ? [4, 3] : [], alpha: 1 };
}

// Per-instance RSI visual style (the Style tab), carried on extendData.style and
// resolved over RSI_STYLE_DEFAULTS at draw time. Colours are hex; the three bands
// pair a colour with an editable level + line style (TV's RSI Upper/Middle/Lower Band).
type RsiLineStyle = "solid" | "dashed" | "dotted";
// The togglable RSI elements (Style-tab visibility checkboxes), keyed in style.hidden.
export type RsiElement =
  | "rsi"
  | "ma"
  | "bull"
  | "bear"
  | "upper"
  | "middle"
  | "lower"
  | "bg"
  | "ob"
  | "os";
interface RsiBandStyle {
  color: string;
  level: number;
  lineStyle: RsiLineStyle;
}
export interface RsiStyle {
  ma: string; // RSI-based MA line
  maLineStyle: RsiLineStyle;
  bull: string; // bullish divergence (line + label)
  bear: string; // bearish divergence (line + label)
  upper: RsiBandStyle; // overbought band line + level (default 70)
  middle: RsiBandStyle; // midline + level (default 50)
  lower: RsiBandStyle; // oversold band line + level (default 30)
  bgFill: string; // faint background between upper/lower
  obFill: string; // overbought gradient
  osFill: string; // oversold gradient
  hidden: Partial<Record<RsiElement, boolean>>; // per-element visibility (unchecked → true)
}
export const RSI_STYLE_DEFAULTS: RsiStyle = {
  ma: "#FFB300",
  maLineStyle: "solid",
  bull: "#26a69a",
  bear: "#ef5350",
  upper: { color: "#787B86", level: 70, lineStyle: "dashed" },
  middle: { color: "#787B86", level: 50, lineStyle: "dashed" },
  lower: { color: "#787B86", level: 30, lineStyle: "dashed" },
  bgFill: "#7E57C2",
  obFill: "#4CAF50",
  osFill: "#EF5350",
  hidden: {},
};

// Resolve an instance's RSI style over the defaults (deep-merging the band objects).
function rsiStyleOf(ind: Indicator): RsiStyle {
  const s = ((ind.extendData as RsiExtend)?.style ?? {}) as Partial<RsiStyle>;
  return {
    ...RSI_STYLE_DEFAULTS,
    ...s,
    upper: { ...RSI_STYLE_DEFAULTS.upper, ...s.upper },
    middle: { ...RSI_STYLE_DEFAULTS.middle, ...s.middle },
    lower: { ...RSI_STYLE_DEFAULTS.lower, ...s.lower },
    hidden: { ...(s.hidden ?? {}) },
  };
}

// Map a line style to a canvas dash pattern.
function dashFor(style: RsiLineStyle): number[] {
  return style === "dashed" ? [5, 4] : style === "dotted" ? [1, 3] : [];
}

// TradingView's RSI pane background: a faint purple region between the upper/lower
// levels, solid boundary lines at each band level, and a faint midline. Pane-local
// coords (see the convertToPixel note in the divergence draw); clamped to the pane.
function drawRsiBand(params: IndicatorDrawParams<RsiPoint>, style: RsiStyle): void {
  const { ctx, yAxis, bounding } = params;
  const left = 0;
  const right = bounding.width;
  const clampY = (y: number) => Math.max(0, Math.min(bounding.height, y));
  const yOB = clampY(yAxis.convertToPixel(style.upper.level));
  const yOS = clampY(yAxis.convertToPixel(style.lower.level));
  const yMid = clampY(yAxis.convertToPixel(style.middle.level));
  const hline = (y: number, color: string, ls: RsiLineStyle) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dashFor(ls));
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineWidth = 1;
  if (!style.hidden.bg) {
    ctx.fillStyle = hexToRgba(style.bgFill, 0.1);
    ctx.fillRect(left, Math.min(yOB, yOS), right - left, Math.abs(yOS - yOB));
  }
  if (!style.hidden.upper) hline(yOB, style.upper.color, style.upper.lineStyle);
  if (!style.hidden.lower) hline(yOS, style.lower.color, style.lower.lineStyle);
  if (!style.hidden.middle) hline(yMid, hexToRgba(style.middle.color, 0.5), style.middle.lineStyle);
  ctx.restore();
}

// Green/red gradient shading of the RSI line's overbought/oversold excursions, like
// TV's "Overbought/Oversold Gradient Fill". `inner` is the threshold (70 or 30),
// `outer` the extreme (100 or 0). The fill spans between the RSI line and the inner
// level, clipped to the beyond-threshold side, with a vertical gradient from solid at
// the extreme to transparent at the threshold.
function drawRsiZoneFill(
  params: IndicatorDrawParams<RsiPoint>,
  inner: number,
  outer: number,
  hex: string,
  isUpper: boolean,
): void {
  const { ctx, indicator, xAxis, yAxis } = params;
  const result = indicator.result ?? [];
  const start = result.findIndex((p) => p?.val !== undefined);
  if (start < 0) return;
  const yInner = yAxis.convertToPixel(inner);
  const yOuter = yAxis.convertToPixel(outer);
  ctx.save();
  // Clip to the beyond-threshold half-plane (above 70 for overbought, below 30 for
  // oversold), so the area between the RSI line and the level only paints where the
  // line actually crosses the threshold.
  ctx.beginPath();
  if (isUpper) ctx.rect(0, yInner - 1e6, 1e7, 1e6);
  else ctx.rect(0, yInner, 1e7, 1e6);
  ctx.clip();
  // Area between the RSI line and the threshold level.
  ctx.beginPath();
  ctx.moveTo(xAxis.convertToPixel(start), yAxis.convertToPixel(result[start].val as number));
  let lastX = xAxis.convertToPixel(start);
  for (let i = start; i < result.length; i++) {
    const v = result[i]?.val;
    if (v === undefined) continue;
    lastX = xAxis.convertToPixel(i);
    ctx.lineTo(lastX, yAxis.convertToPixel(v));
  }
  ctx.lineTo(lastX, yInner);
  ctx.lineTo(xAxis.convertToPixel(start), yInner);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, yOuter, 0, yInner);
  grad.addColorStop(0, hexToRgba(hex, 0.5)); // solid at the extreme (100 / 0)
  grad.addColorStop(1, hexToRgba(hex, 0)); // transparent at the threshold (70 / 30)
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
}

// Draw a polyline over a per-bar field of the RSI result (the smoothing MA or a BB
// edge), skipping undefined gaps. Pane-local coords (xAxis/yAxis.convertToPixel),
// same space as the RSI line figure.
function drawRsiSeries(
  params: IndicatorDrawParams<RsiPoint>,
  pick: (p: RsiPoint) => number | undefined,
  color: string,
  width: number,
  dash: number[] = [],
): void {
  const { ctx, indicator, xAxis, yAxis } = params;
  const result = indicator.result ?? [];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < result.length; i++) {
    const v = pick(result[i]);
    if (v === undefined) {
      pen = false;
      continue;
    }
    const x = xAxis.convertToPixel(i);
    const y = yAxis.convertToPixel(v);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
  ctx.restore();
}

// Draw the optional RSI smoothing MA + Bollinger Bands (when present in the result).
// The MA uses the styled colour; the Bollinger Bands echo it at lower opacity.
function drawRsiSmoothing(params: IndicatorDrawParams<RsiPoint>, style: RsiStyle): void {
  if (style.hidden.ma) return;
  const result = params.indicator.result ?? [];
  const hasMa = result.some((p) => p?.ma !== undefined);
  if (!hasMa) return;
  const dash = dashFor(style.maLineStyle);
  if (result.some((p) => p?.bbUp !== undefined)) {
    const bb = hexToRgba(style.ma, 0.5);
    drawRsiSeries(params, (p) => p.bbUp, bb, 1, dash);
    drawRsiSeries(params, (p) => p.bbDn, bb, 1, dash);
  }
  drawRsiSeries(params, (p) => p.ma, style.ma, 1.5, dash);
}

// Draw the RSI pane decorations: the TV-style overbought/oversold band + gradient
// fills (always), the optional smoothing MA + Bollinger Bands, plus — when divergence
// is enabled — a line between the two RSI pivots and a Bull/Bear label at the
// confirmed (right) pivot. All colours/levels come from the resolved RsiStyle. Reads
// data stashed in calc on indicator.result; converts (dataIndex, rsi) → pixels via the
// pane's own axes. Returns false so klinecharts still draws the RSI line itself.
function drawRsiDivergences(params: IndicatorDrawParams<RsiPoint>): boolean {
  const style = rsiStyleOf(params.indicator);
  drawRsiBand(params, style);
  if (!style.hidden.ob) drawRsiZoneFill(params, style.upper.level, 100, style.obFill, true);
  if (!style.hidden.os) drawRsiZoneFill(params, style.lower.level, 0, style.osFill, false);
  drawRsiSmoothing(params, style);
  const { ctx, indicator, xAxis, yAxis, bounding } = params;
  const result = indicator.result ?? [];
  const left = bounding.left;
  const right = bounding.left + bounding.width;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = "10px Helvetica Neue, Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let i = 0; i < result.length; i++) {
    const segs = result[i]?.divs;
    if (!segs?.length) continue;
    for (const s of segs) {
      const x1 = xAxis.convertToPixel(s.fromIndex);
      const x2 = xAxis.convertToPixel(s.toIndex);
      if ((x1 < left && x2 < left) || (x1 > right && x2 > right)) continue; // off-screen
      const y1 = yAxis.convertToPixel(s.fromValue);
      const y2 = yAxis.convertToPixel(s.toValue);
      const bullish = s.kind === "bullish" || s.kind === "hiddenBullish";
      if (bullish ? style.hidden.bull : style.hidden.bear) continue;
      const color = bullish ? style.bull : style.bear;
      const vis = divVisual(s);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = vis.alpha;
      ctx.setLineDash(vis.dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Label outside the pivot: above for bearish (RSI tops), below for bullish.
      ctx.setLineDash([]);
      ctx.fillText(vis.label, x2 + 3, bullish ? y2 + 7 : y2 - 7);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  return false; // keep the default RSI line
}

// Single-line, length-14 RSI (TradingView shape) that REPLACES klinecharts'
// built-in three-length RSI, plus optional divergence marking via the `draw`
// callback. Length in calcParams[0]; divergence config on extendData (RsiExtend).
export const RSI_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "RSI",
  series: IndicatorSeries.Normal, // sub-pane (NOT a price overlay)
  precision: 2,
  calcParams: [14],
  figures: [{ key: "rsi", title: "RSI: ", type: "line" }],
  // TradingView's RSI line colour (purple), so a fresh RSI matches TV by default.
  styles: { lines: [fullLine("#7E57C2", LineType.Solid)] },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeRsi(dataList, Number(ind.calcParams?.[0]) || 14, (ind.extendData ?? {}) as RsiExtend),
  draw: (params) => drawRsiDivergences(params as IndicatorDrawParams<RsiPoint>),
};
