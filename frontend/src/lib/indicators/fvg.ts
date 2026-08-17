// FVG: Fair Value Gaps (3-candle imbalances) as live, mitigation-tracked zones.
//
// Causal by construction (backtest-safe): a gap is confirmed BY the third bar of
// its pattern and every later mutation is driven by that later bar's own wick, so
// values at bar i depend only on bars [0..i].
//
//   bullish  low[i]  > high[i-2]  → zone [high[i-2], low[i]]
//   bearish  high[i] < low[i-2]   → zone [high[i],   low[i-2]]
//
// A gap is kept only if its height ≥ minSize × ATR(14) at the confirm bar
// (volatility-adaptive, like SR_LEVELS' cluster tolerance); gaps confirming
// before ATR(14) is warm are skipped regardless of minSize, which is what keeps
// fvgWarmup honest.
//
// MITIGATION IS WICK-DRIVEN, NOT CLOSE-DRIVEN. Each later bar's low (bullish) or
// high (bearish) eats into the zone: a wick that reaches or passes the FAR edge
// kills the gap outright, a wick that stops inside shrinks the zone to the
// unfilled remainder. Shrinking gives the outputs a useful invariant — a bar's
// close is never strictly inside a live zone, because any bar reaching into a
// bullish zone pulls its top down to that bar's low, and a close never sits below
// its own low. So "nearest live gap below the close" (bullish) and "above the
// close" (bearish) are total: there is no close-inside case to arbitrate. The
// suite pins this invariant; do not replace shrink-on-partial without revisiting
// the output selection.
//
// A gap also expires maxBars after its confirm bar, and only the newest maxGaps
// per side stay live. Per-bar outputs are the rule operands:
//   bull_top / bull_bottom — edges of the nearest live bullish gap below the close
//   bear_top / bear_bottom — edges of the nearest live bearish gap above the close
//
// Ported operation-for-operation to backend/auto_trader/indicators/fvg.py; keep
// the arithmetic order identical (see core.py's parity contract).
import {
  type Indicator,
  type IndicatorDrawParams,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";
import {
  FVG_ATR_LEN,
  FVG_DEFAULTS,
  FVG_OUTPUTS,
  parseFvgConfig,
  type FvgConfig,
} from "./fvgOutputs";
import { atrSeries } from "../atr";
import { alignHtfToChart } from "../mtf";

// The output names, config parser and warm-up live in the klinecharts-free leaf
// ./fvgOutputs so pure callers (exprInstances.ts) can read them without pulling
// klinecharts into node. Re-exported here so this module stays the one import
// site for everything FVG.
export {
  FVG_ATR_LEN,
  FVG_OUTPUTS,
  FVG_DEFAULTS,
  parseFvgConfig,
  fvgWarmup,
  type FvgConfig,
  type FvgOutput,
} from "./fvgOutputs";

export type FvgSide = "bull" | "bear";

/** A live gap at some bar: `top`/`bottom` are the UNFILLED remainder, so they
 * move as price mitigates the zone. `createdIdx` is the confirm bar. */
export interface FvgGap {
  side: FvgSide;
  top: number;
  bottom: number;
  createdIdx: number;
}

export interface FvgPoint {
  bullTop?: number;
  bullBottom?: number;
  bearTop?: number;
  bearBottom?: number;
}

interface MutableGap {
  side: FvgSide;
  top: number;
  bottom: number;
  createdIdx: number;
}

/** The newest `maxGaps` per side, returned in CREATION order (the draw order and
 * the order the last-row gap list is reported in). */
function capPerSide(live: readonly MutableGap[], maxGaps: number): MutableGap[] {
  let bull = 0;
  let bear = 0;
  const keep: MutableGap[] = [];
  for (let k = live.length - 1; k >= 0; k--) {
    const g = live[k];
    const n = g.side === "bull" ? ++bull : ++bear;
    if (n <= maxGaps) keep.push(g);
  }
  return keep.reverse();
}

/** Nearest live gap on each side of `close`. Bullish zones always sit at or
 * below the close and bearish at or above (see the header invariant), so
 * "nearest" is the highest bullish top / lowest bearish bottom. Ties break to
 * the more recent gap — a total order, so both runtimes agree without relying on
 * sort stability. */
function pointFrom(live: readonly MutableGap[]): FvgPoint {
  let bull: MutableGap | undefined;
  let bear: MutableGap | undefined;
  for (const g of live) {
    if (g.side === "bull") {
      if (!bull || g.top > bull.top || (g.top === bull.top && g.createdIdx > bull.createdIdx)) bull = g;
    } else if (!bear || g.bottom < bear.bottom || (g.bottom === bear.bottom && g.createdIdx > bear.createdIdx)) {
      bear = g;
    }
  }
  return {
    bullTop: bull?.top,
    bullBottom: bull?.bottom,
    bearTop: bear?.top,
    bearBottom: bear?.bottom,
  };
}

export function computeFvg(
  dataList: KLineData[],
  cfg: FvgConfig,
  ext?: Pick<FvgExtend, "mtf">,
): { points: FvgPoint[]; gaps: FvgGap[] } {
  const mtf = ext?.mtf;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfMs && mtf.htfBullTop && mtf.htfBearTop) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars. Each chart bar takes the most recent CLOSED HTF bar (waitClose), so
    // no chart bar sees a gap from an HTF bar that closes later — the same
    // contract as SR_LEVELS and Pivot Bands.
    const ts = dataList.map((k) => k.timestamp);
    const htfBars = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const at = (v: Array<number | undefined> | undefined): Array<number | undefined> =>
      alignHtfToChart(ts, htfBars, v ?? [], mtf.htfMs as number, true);
    const bullTop = at(mtf.htfBullTop);
    const bullBottom = at(mtf.htfBullBottom);
    const bearTop = at(mtf.htfBearTop);
    const bearBottom = at(mtf.htfBearBottom);
    const points = ts.map((_, i) => ({
      bullTop: bullTop[i],
      bullBottom: bullBottom[i],
      bearTop: bearTop[i],
      bearBottom: bearBottom[i],
    }));
    // Each stashed gap's confirm timestamp maps to the first chart bar inside
    // its HTF bar, so the box starts where that HTF bar started.
    const gaps: FvgGap[] = (mtf.htfGaps ?? []).map((g) => {
      const first = ts.findIndex((t) => t >= g.createdTs);
      return { side: g.side, top: g.top, bottom: g.bottom, createdIdx: first < 0 ? 0 : first };
    });
    return { points, gaps };
  }

  const len = dataList.length;
  const atr = atrSeries(dataList, FVG_ATR_LEN);
  const points: FvgPoint[] = new Array(len);
  const live: MutableGap[] = [];

  for (let i = 0; i < len; i++) {
    const bar = dataList[i];
    // 1. Mitigate every OPEN gap with this bar's wick. A gap confirmed at this
    //    bar is appended in step 3, so its own pattern can never fill it.
    for (let k = live.length - 1; k >= 0; k--) {
      const g = live[k];
      if (g.side === "bull") {
        if (bar.low <= g.bottom) live.splice(k, 1);
        else if (bar.low < g.top) g.top = bar.low;
      } else if (bar.high >= g.top) {
        live.splice(k, 1);
      } else if (bar.high > g.bottom) {
        g.bottom = bar.high;
      }
    }
    // 2. Expire by age.
    for (let k = live.length - 1; k >= 0; k--) {
      if (i - live[k].createdIdx > cfg.maxBars) live.splice(k, 1);
    }
    // 3. Detect this bar's gap. The two sides are mutually exclusive; bullish is
    //    tested first for a fixed cross-runtime order.
    const a = atr[i];
    if (i >= 2 && a != null) {
      const minHeight = a * cfg.minSize;
      const prev = dataList[i - 2];
      if (bar.low > prev.high) {
        if (bar.low - prev.high >= minHeight) {
          live.push({ side: "bull", bottom: prev.high, top: bar.low, createdIdx: i });
        }
      } else if (bar.high < prev.low) {
        if (prev.low - bar.high >= minHeight) {
          live.push({ side: "bear", bottom: bar.high, top: prev.low, createdIdx: i });
        }
      }
    }
    points[i] = pointFrom(capPerSide(live, cfg.maxGaps));
  }

  const gaps: FvgGap[] = capPerSide(live, cfg.maxGaps).map((g) => ({
    side: g.side,
    top: g.top,
    bottom: g.bottom,
    createdIdx: g.createdIdx,
  }));

  return { points, gaps };
}

// ---------------------------------------------------------------------------
// Chart template
// ---------------------------------------------------------------------------

/** Draw-only zone styling (Style tab). */
export interface FvgZoneStyle {
  bullColor: string;
  bearColor: string;
  opacity: number;
}

export const FVG_ZONE_STYLE_DEFAULTS: FvgZoneStyle = {
  bullColor: "#26A69A",
  bearColor: "#EF5350",
  opacity: 0.14,
};

/** One live gap computed on HTF bars, stashed with a TIMESTAMP (not an HTF bar
 * index) so calc can map it onto whatever chart bars are loaded. */
export interface FvgMtfGap {
  side: FvgSide;
  top: number;
  bottom: number;
  createdTs: number; // open timestamp of the HTF bar that confirmed the gap
}

export interface FvgExtend {
  // Draw a dashed line through each zone's midpoint (the drawn remainder's 50%,
  // ICT's "consequent encroachment"). Default off — the band alone reads cleaner.
  showMidline?: boolean;
  // Zone colors / fill opacity (Style tab); partial, resolved over defaults.
  zoneStyle?: Partial<FvgZoneStyle>;
  // Multi-timeframe: series + gaps computed on a higher timeframe and aligned
  // onto the chart bars inside calc (no lookahead). Set by the MTF coordinator
  // (applyFvgTimeframe); calc re-aligns on scroll-back.
  mtf?: {
    timeframe: string | null;
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfMs?: number; // HTF bar duration (ms)
    htfBullTop?: Array<number | undefined>;
    htfBullBottom?: Array<number | undefined>;
    htfBearTop?: Array<number | undefined>;
    htfBearBottom?: Array<number | undefined>;
    htfGaps?: FvgMtfGap[]; // live gaps at the last closed HTF bar
  };
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  hideLegendValue?: boolean;
}

/** Resolve an instance's zone style over the defaults. */
export function fvgZoneStyleOf(ext: FvgExtend | undefined): FvgZoneStyle {
  return { ...FVG_ZONE_STYLE_DEFAULTS, ...(ext?.zoneStyle ?? {}) };
}

/** calc result row. The full gap list rides on the LAST row only (draw reads it
 * from indicator.result); every other row carries just the rule operands. */
export interface FvgCalcPoint extends FvgPoint {
  gaps?: FvgGap[];
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `${hex}${a}`;
}

function drawFvg(params: IndicatorDrawParams<FvgCalcPoint, unknown, unknown>): boolean {
  const { ctx, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as FvgCalcPoint[];
  const last = result[result.length - 1];
  if (!last?.gaps?.length) return true;
  const ext = indicator.extendData as FvgExtend | undefined;
  const showMidline = ext?.showMidline === true;
  const style = fvgZoneStyleOf(ext);

  ctx.save();
  for (const g of last.gaps) {
    const color = g.side === "bull" ? style.bullColor : style.bearColor;
    const x0 = Math.max(0, xAxis.convertToPixel(g.createdIdx));
    const yTop = yAxis.convertToPixel(g.top);
    const yBot = yAxis.convertToPixel(g.bottom);
    const w = bounding.width - x0;
    if (w <= 0) continue;
    ctx.fillStyle = hexWithAlpha(color, style.opacity);
    ctx.fillRect(x0, yTop, w, Math.max(1, yBot - yTop));
    if (showMidline) {
      const yMid = yAxis.convertToPixel((g.top + g.bottom) / 2);
      ctx.strokeStyle = hexWithAlpha(color, 0.9);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, yMid);
      ctx.lineTo(bounding.width, yMid);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
  return true; // zones replace the default figure lines
}

// Figure keys are the BACKEND output names verbatim, so a rule operand and the
// legend row a user clicks to insert it can never drift apart.
const FVG_FIGURE_TITLE: Record<(typeof FVG_OUTPUTS)[number], string> = {
  bull_top: "Bull top: ",
  bull_bottom: "Bull bottom: ",
  bear_top: "Bear top: ",
  bear_bottom: "Bear bottom: ",
};

const FVG_FIGURES = FVG_OUTPUTS.map((key) => ({ key, title: FVG_FIGURE_TITLE[key], type: "line" }));

const FVG_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(FVG_ZONE_STYLE_DEFAULTS.bullColor, "solid"),
  fullLine(FVG_ZONE_STYLE_DEFAULTS.bullColor, "solid"),
  fullLine(FVG_ZONE_STYLE_DEFAULTS.bearColor, "solid"),
  fullLine(FVG_ZONE_STYLE_DEFAULTS.bearColor, "solid"),
];

/** The calc row klinecharts reads for the legend — figure keys, not the camelCase
 * the compute layer speaks. */
function toCalcRow(p: FvgPoint): Record<string, number | undefined> {
  return {
    bull_top: p.bullTop,
    bull_bottom: p.bullBottom,
    bear_top: p.bearTop,
    bear_bottom: p.bearBottom,
  };
}

// FVG: fair-value-gap zones. calcParams = [minSize, maxBars, maxGaps].
export const FVG_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "FVG",
  series: "price",
  precision: 2,
  calcParams: [FVG_DEFAULTS.minSize, FVG_DEFAULTS.maxBars, FVG_DEFAULTS.maxGaps],
  figures: FVG_FIGURES,
  styles: { lines: FVG_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, gaps } = computeFvg(
      dataList,
      parseFvgConfig(ind.calcParams),
      (ind.extendData ?? {}) as FvgExtend,
    );
    const out = points.map(toCalcRow) as FvgCalcPoint[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], gaps };
    return out;
  },
  draw: (params) => drawFvg(params as IndicatorDrawParams<FvgCalcPoint, unknown, unknown>),
};
