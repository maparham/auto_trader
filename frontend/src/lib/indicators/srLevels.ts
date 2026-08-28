// SR_LEVELS: major support/resistance zones from clustered fractal pivots.
//
// Causal by construction (backtest-safe): a strict fractal pivot at bar i
// (shared isPivotAt, same as PivotBands) only exists at its confirm bar i+N,
// and every cluster mutation happens at confirm bars, so values at bar i depend
// only on bars [0..i]. A confirmed pivot merges into the nearest existing level
// within tolerance = ATR(14)×atrMult at the confirm bar (volatility-adaptive);
// otherwise it seeds a new level. Pivots confirming before ATR(14) is warm are
// skipped. A level's price is the arithmetic mean of its member pivots; swing
// highs and lows share one pool, so a flipped level keeps its touch history.
//
// A level is MAJOR at bar i when it has ≥ minTouches members and its last touch
// confirmed within the trailing maxBars window; only the strongest maxLevels
// (by touches, then recency) are live. Per-bar outputs are the rule operands:
//   support    — nearest major level price at or below the bar's close
//   resistance — nearest major level price above the bar's close
//
// Ported operation-for-operation to backend/auto_trader/indicators/sr_levels.py;
// keep the arithmetic order identical (see core.py's parity contract).
import {
  type Indicator,
  type IndicatorDrawParams,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";
import { isPivotAt } from "./pivots";
import { atrSeries } from "../atr";
import { alignHtfToChart } from "../mtf";
// Config shape, defaults, parser, output names and warm-up live in the leaf
// (no klinecharts) so the expression bridge can read them from a node context;
// re-exported here so every existing `from "./indicators/srLevels"` import
// keeps working.
import { parseSrConfig, SR_ATR_LEN, type SrLevelsConfig } from "./srLevelsOutputs";

export {
  parseSrConfig,
  SR_ATR_LEN,
  SR_LEVELS_DEFAULTS,
  SR_LEVELS_OUTPUTS,
  srLevelsWarmup,
  type SrLevelsConfig,
  type SrLevelsOutput,
} from "./srLevelsOutputs";

export interface SrLevel {
  price: number; // mean of member pivot prices
  halfWidth: number; // zone half-height = tolerance at the last touch
  touches: number;
  firstIdx: number; // bar index of the first member pivot's extreme
  lastIdx: number; // bar index where the last member pivot confirmed
}

export interface SrPoint {
  support?: number;
  resistance?: number;
}

interface Cluster {
  sum: number;
  touches: number;
  firstIdx: number;
  lastConfirm: number;
  halfWidth: number;
}

const clusterPrice = (c: Cluster): number => c.sum / c.touches;

// Full deterministic ordering (no stability reliance — Python sorts identically):
// strongest first, then most recent, then oldest origin, then lowest price.
function rankClusters(a: Cluster, b: Cluster): number {
  if (a.touches !== b.touches) return b.touches - a.touches;
  if (a.lastConfirm !== b.lastConfirm) return b.lastConfirm - a.lastConfirm;
  if (a.firstIdx !== b.firstIdx) return a.firstIdx - b.firstIdx;
  return clusterPrice(a) - clusterPrice(b);
}

export function computeSrLevels(
  dataList: KLineData[],
  cfg: SrLevelsConfig,
  ext?: Pick<SrLevelsExtend, "mtf">,
): { points: SrPoint[]; levels: SrLevel[] } {
  const mtf = ext?.mtf;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfMs && mtf.htfSupport && mtf.htfResistance) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars. Each chart bar takes the most recent CLOSED HTF bar (waitClose), so
    // the HTF pivot-confirmation lag is preserved and no chart bar sees a level
    // from an HTF bar that closes later — same contract as PivotBands.
    const ts = dataList.map((k) => k.timestamp);
    const htfBars = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const sup = alignHtfToChart(ts, htfBars, mtf.htfSupport, mtf.htfMs, true);
    const res = alignHtfToChart(ts, htfBars, mtf.htfResistance, mtf.htfMs, true);
    const points = ts.map((_, i) => ({
      support: sup[i] ?? undefined,
      resistance: res[i] ?? undefined,
    }));
    const htfMs = mtf.htfMs;
    // Map each stashed level's timestamps onto chart bar indices: the zone
    // starts at the first chart bar inside its first pivot's HTF bar; its last
    // touch anchors to the final chart bar of the confirming HTF bar (whose
    // close approximates the HTF confirm close, for the broken-level check).
    const levels: SrLevel[] = (mtf.htfLevels ?? []).map((lv) => {
      const first = ts.findIndex((t) => t >= lv.firstTs);
      const afterLast = ts.findIndex((t) => t >= lv.lastTs + htfMs);
      return {
        price: lv.price,
        halfWidth: lv.halfWidth,
        touches: lv.touches,
        firstIdx: first < 0 ? 0 : first,
        lastIdx: Math.max(0, (afterLast < 0 ? ts.length : afterLast) - 1),
      };
    });
    return { points, levels };
  }

  const len = dataList.length;
  const n = Math.max(1, Math.floor(cfg.pivotLen) || 1);
  const points: SrPoint[] = new Array(len);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const atr = atrSeries(dataList, SR_ATR_LEN);

  // Pivot extremes keyed by the bar where they CONFIRM (i + n). A bar can
  // confirm both sides; the high is applied first (fixed cross-runtime order).
  const highAt = new Map<number, number>();
  const lowAt = new Map<number, number>();
  for (let i = 0; i < len; i++) {
    if (isPivotAt(highs, i, n, n, "high", true)) highAt.set(i + n, i);
    if (isPivotAt(lows, i, n, n, "low", true)) lowAt.set(i + n, i);
  }

  const clusters: Cluster[] = [];

  // majorAt's selection is recomputed lazily, not once per bar. It can only
  // change two ways: a touch mutates the pool (invalidate below), or the age
  // window slides past the OLDEST eligible cluster — and eligibility only ever
  // shrinks with i, since a lapsed cluster re-enters only by being touched.
  // So one recompute stays correct through `cachedThrough`, which is what turns
  // a filter+sort+slice of the whole (unbounded) pool per bar into a rare one.
  let cachedMajor: Cluster[] | null = null;
  let cachedThrough = -1;

  const touch = (price: number, pivotIdx: number, confirmIdx: number, tol: number): void => {
    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      const dist = Math.abs(price - clusterPrice(c));
      if (dist <= tol && dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    if (best) {
      best.sum += price;
      best.touches += 1;
      best.lastConfirm = confirmIdx;
      best.halfWidth = tol;
    } else {
      clusters.push({ sum: price, touches: 1, firstIdx: pivotIdx, lastConfirm: confirmIdx, halfWidth: tol });
    }
    cachedMajor = null; // the pool moved: rank and eligibility must be redone
  };

  const recomputeMajor = (i: number): Cluster[] => {
    const cutoff = i - cfg.maxBars;
    const eligible: Cluster[] = [];
    let oldestConfirm = Infinity;
    for (const c of clusters) {
      if (c.touches < cfg.minTouches || c.lastConfirm < cutoff) continue;
      eligible.push(c);
      if (c.lastConfirm < oldestConfirm) oldestConfirm = c.lastConfirm;
    }
    eligible.sort(rankClusters);
    cachedMajor = eligible.slice(0, Math.max(0, cfg.maxLevels));
    // The first bar this selection could change by age alone: one past the bar
    // the oldest eligible cluster ages out on. Nothing eligible = nothing to
    // expire, so only a touch can dirty it.
    cachedThrough =
      oldestConfirm === Infinity ? Number.MAX_SAFE_INTEGER : oldestConfirm + cfg.maxBars;
    return cachedMajor;
  };

  const majorAt = (i: number): Cluster[] =>
    cachedMajor !== null && i <= cachedThrough ? cachedMajor : recomputeMajor(i);

  for (let i = 0; i < len; i++) {
    const tolAtr = atr[i];
    if (tolAtr != null) {
      const tol = tolAtr * cfg.atrMult;
      const h = highAt.get(i);
      if (h !== undefined) touch(highs[h], h, i, tol);
      const l = lowAt.get(i);
      if (l !== undefined) touch(lows[l], l, i, tol);
    }
    const close = dataList[i].close;
    let support: number | undefined;
    let resistance: number | undefined;
    for (const c of majorAt(i)) {
      const p = clusterPrice(c);
      if (p <= close) {
        if (support === undefined || p > support) support = p;
      } else if (resistance === undefined || p < resistance) {
        resistance = p;
      }
    }
    points[i] = { support, resistance };
  }

  const levels: SrLevel[] = (len ? majorAt(len - 1) : []).map((c) => ({
    price: clusterPrice(c),
    halfWidth: c.halfWidth,
    touches: c.touches,
    firstIdx: c.firstIdx,
    lastIdx: c.lastConfirm,
  }));

  return { points, levels };
}

// ---------------------------------------------------------------------------
// Chart template
// ---------------------------------------------------------------------------

/** Draw-only zone styling (Style tab). opacity is the BASE fill alpha of a
 * minTouches-strength zone; the touch-count ramp builds on it (see zoneAlpha). */
export interface SrZoneStyle {
  supColor: string;
  resColor: string;
  opacity: number;
  // Draw broken levels (price closed through since the last touch) at half
  // opacity. Off = every zone renders at full strength regardless.
  dimBroken: boolean;
}

export const SR_ZONE_STYLE_DEFAULTS: SrZoneStyle = {
  supColor: "#26A69A",
  resColor: "#EF5350",
  opacity: 0.1,
  dimBroken: true,
};

/** One major level computed on HTF bars, stashed with TIMESTAMPS (not HTF bar
 * indices) so calc can map it onto whatever chart bars are loaded. */
export interface SrMtfLevel {
  price: number;
  halfWidth: number;
  touches: number;
  firstTs: number; // open timestamp of the first member pivot's HTF extreme bar
  lastTs: number; // open timestamp of the HTF bar where the last touch confirmed
}

export interface SrLevelsExtend {
  // Draw a dashed line through each zone's center price (default off — the
  // translucent band alone reads cleaner).
  showMidline?: boolean;
  // Zone colors / base opacity (Style tab); partial, resolved over defaults.
  zoneStyle?: Partial<SrZoneStyle>;
  // Multi-timeframe: series + levels computed on a higher timeframe and aligned
  // onto the chart bars inside calc (no lookahead). Set by the MTF coordinator
  // (applySrLevelsTimeframe); calc re-aligns on scroll-back.
  mtf?: {
    timeframe: string | null;
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfMs?: number; // HTF bar duration (ms)
    htfSupport?: Array<number | undefined>; // per-HTF-bar nearest support
    htfResistance?: Array<number | undefined>; // per-HTF-bar nearest resistance
    htfLevels?: SrMtfLevel[]; // major levels at the last closed HTF bar
  };
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  hideLegendValue?: boolean;
}

/** Resolve an instance's zone style over the defaults. */
export function srZoneStyleOf(ext: SrLevelsExtend | undefined): SrZoneStyle {
  return { ...SR_ZONE_STYLE_DEFAULTS, ...(ext?.zoneStyle ?? {}) };
}

/** calc result row. The full level list rides on the LAST row only (draw reads
 * it from indicator.result); every other row carries just the rule operands. */
export interface SrLevelsPoint extends SrPoint {
  levels?: SrLevel[];
}

/** A level is BROKEN when the latest close sits on the opposite side of the
 * level from where the close was at the level's last touch — the level failed
 * to hold since it last reacted. A close exactly at the level counts as the
 * upper side, matching the support classification's `price <= close`.
 * Drawing-only (broken zones dim); not a rule operand, so no backend port. */
export function isLevelBroken(price: number, lastIdx: number, closes: number[]): boolean {
  return isLevelBrokenAt(price, closes[closes.length - 1], closes[lastIdx]);
}

/** The same break test from the only two closes it reads. The draw path runs
 * this per level per FRAME, so it must never walk (or copy) the whole series;
 * an absent close counts as below the level, as indexing off the end did. */
export function isLevelBrokenAt(
  price: number,
  lastClose: number | undefined,
  closeAtLastIdx: number | undefined,
): boolean {
  const side = (c: number | undefined): number => (c !== undefined && c >= price ? 1 : -1);
  return side(lastClose) !== side(closeAtLastIdx);
}

/** Zone fill opacity grows with touch count so stronger levels read darker:
 * base alpha at minTouches, +0.04 per extra touch, capped at 3× the base. */
export function zoneAlpha(touches: number, minTouches: number, base: number): number {
  return Math.min(base * 3, base + 0.04 * (touches - minTouches));
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `${hex}${a}`;
}

function drawSrLevels(params: IndicatorDrawParams<SrLevelsPoint, unknown, unknown>): boolean {
  const { ctx, chart, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as SrLevelsPoint[];
  const last = result[result.length - 1];
  if (!last?.levels?.length) return true;
  const cfg = parseSrConfig(indicator.calcParams);
  const ext = indicator.extendData as SrLevelsExtend | undefined;
  const showMidline = ext?.showMidline === true;
  const zoneStyle = srZoneStyleOf(ext);
  const dataList = chart.getDataList();
  const lastClose = dataList.length ? dataList[dataList.length - 1].close : undefined;
  // bounding.width spans the whole pane INCLUDING the y-axis strip on the
  // right (the fills deliberately run under it); the ×N tags must not, or the
  // axis overlay hides them.
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const tagRight = bounding.width - axisWidth - 4;

  ctx.save();
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  for (const lv of last.levels) {
    // Green when the zone sits at/below the latest close (acting support),
    // red when above it (acting resistance) — a broken level re-tints.
    const isSupport = lastClose === undefined || lv.price <= lastClose;
    const color = isSupport ? zoneStyle.supColor : zoneStyle.resColor;
    // A level price has closed through since its last touch dims to half —
    // still on the chart (it may reclaim), but visibly weaker than one holding.
    const broken =
      zoneStyle.dimBroken &&
      dataList.length > 0 &&
      isLevelBrokenAt(lv.price, lastClose, dataList[lv.lastIdx]?.close);
    const dim = broken ? 0.5 : 1;
    const x0 = Math.max(0, xAxis.convertToPixel(lv.firstIdx));
    const yTop = yAxis.convertToPixel(lv.price + lv.halfWidth);
    const yBot = yAxis.convertToPixel(lv.price - lv.halfWidth);
    const yMid = yAxis.convertToPixel(lv.price);
    const w = bounding.width - x0;
    if (w <= 0) continue;
    ctx.fillStyle = hexWithAlpha(color, zoneAlpha(lv.touches, cfg.minTouches, zoneStyle.opacity) * dim);
    ctx.fillRect(x0, yTop, w, Math.max(1, yBot - yTop));
    if (showMidline) {
      ctx.strokeStyle = hexWithAlpha(color, 0.9 * dim);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, yMid);
      ctx.lineTo(bounding.width, yMid);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Touch-count tag at the right edge.
    const label = `×${lv.touches}`;
    ctx.fillStyle = hexWithAlpha(color, 0.95 * dim);
    ctx.textAlign = "right";
    ctx.fillText(label, tagRight, yMid - 7);
  }
  ctx.restore();
  return true; // zones replace the default figure lines
}

const SR_LEVELS_FIGURES = [
  { key: "support", title: "Support: ", type: "line" },
  { key: "resistance", title: "Resistance: ", type: "line" },
];

const SR_LEVELS_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(SR_ZONE_STYLE_DEFAULTS.supColor, "solid"), // support
  fullLine(SR_ZONE_STYLE_DEFAULTS.resColor, "solid"), // resistance
];

// SR Levels: clustered-pivot support/resistance zones.
// calcParams = [pivotLen, atrMult, minTouches, maxLevels, maxBars].
export const SR_LEVELS_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "S/R Levels",
  series: "price",
  precision: 2,
  calcParams: [15, 0.5, 2, 8, 500],
  figures: SR_LEVELS_FIGURES,
  styles: { lines: SR_LEVELS_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, levels } = computeSrLevels(
      dataList,
      parseSrConfig(ind.calcParams),
      (ind.extendData ?? {}) as SrLevelsExtend,
    );
    const out = points as SrLevelsPoint[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], levels };
    return out;
  },
  draw: (params) => drawSrLevels(params as IndicatorDrawParams<SrLevelsPoint, unknown, unknown>),
};
