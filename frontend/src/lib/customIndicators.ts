// Custom indicators not built into klinecharts: VWAP and Anchored VWAP (AVWAP).
// Registered globally (registerIndicator) so they appear in our indicator menu
// like any built-in. Both plot on the price (candle) pane.
//
// VWAP  = cumΣ(typical·vol) / cumΣ(vol), typical = (h+l+c)/3, from the first bar.
// AVWAP = same, but accumulation starts at an ANCHOR timestamp (calcParams[0]).
//         Default anchor 0 → first bar (≡ VWAP) until the user sets one.

import {
  registerIndicator,
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type IndicatorTooltipData,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { maSeries, alignHtfToChart, priceOf, type MaOptions, type PriceSource } from "./mtf";
import { hexToRgba } from "./lineStyle";

// Per-indicator legend behavior, attached to every indicator at creation
// (Toolbar.createIndicatorOn). klinecharts only exposes per-indicator legend
// control through this hook.
//
// EVERY indicator legend is now rendered as crisp DOM (TradingView layers DOM text
// over its canvas; klinecharts' canvas text was blurry): <ChartLegend> for the candle
// pane and <SubPaneLegend> for the sub-panes (Volume/MACD/RSI/…). klinecharts gates
// the candle-pane *indicator* rows by indicator.tooltip.showRule — a single global
// switch that ALSO governs sub-pane legends, so we can't just turn it off. Instead we
// return an EMPTY name + values + icons for every indicator here: klinecharts skips a
// row entirely when both name and values are empty (IndicatorTooltipView
// .drawIndicatorTooltip), so the canvas draws nothing and the DOM legends own it all —
// no blurry duplicate in any pane.
// The real indicator TYPE (EMA/MA/AVWAP/RSI/…). For multi-instance indicators the
// klinecharts `name` is a unique per-instance id (e.g. "EMA#a1b2"); the type lives
// in extendData.indType. Built-ins added straight by klinecharts name (RSI/MACD)
// have no indType, so fall back to the name. This is THE function to branch on
// anywhere logic used to compare `ind.name === 'EMA'` etc.
export function indTypeOf(
  ind: { name: string; extendData?: unknown } | Indicator,
): string {
  const t = (ind.extendData as { indType?: string } | undefined)?.indType;
  return typeof t === "string" && t ? t : ind.name;
}

export function legendTooltipSource(): IndicatorTooltipData {
  // EVERY indicator's legend is now crisp DOM (<ChartLegend> for the candle pane,
  // <SubPaneLegend> for Volume/MACD/RSI/etc.), so the canvas draws no legend for any
  // of them. Returning empty name + values makes klinecharts skip the whole tooltip
  // row (IndicatorTooltipView.drawIndicatorTooltip), avoiding a blurry duplicate.
  return { name: "", calcParamsText: "", values: [], icons: [] } as IndicatorTooltipData;
}

interface VwapPoint {
  vwap?: number;
  // Band lines, present only for enabled bands (calc omits the key otherwise, so
  // klinecharts draws no line). Up/dn are the upper/lower of each multiplier.
  up1?: number;
  dn1?: number;
  up2?: number;
  dn2?: number;
  up3?: number;
  dn3?: number;
}

// AVWAP band configuration carried on extendData (set by the settings modal).
// `mode` picks the band width formula; `bands[k]` enables multiplier k with its
// factor. Mirrors TradingView's "Bands Settings".
export type BandMode = "stdev" | "percentage";
export interface BandSetting {
  on: boolean;
  mult: number;
}
export interface AvwapExtend {
  source?: PriceSource; // default hlc3 (standard VWAP typical price)
  bandMode?: BandMode; // default "stdev"
  bands?: [BandSetting, BandSetting, BandSetting];
  // Per-line show/hide (Style tab, TradingView-style). Keyed by figure key
  // (vwap/up1/dn1/…); calc OMITS a hidden line's output key so klinecharts draws
  // nothing for it. Default (absent) = every line visible.
  lineHidden?: Record<string, boolean>;
  hideLegendValue?: boolean;
}

export const AVWAP_DEFAULT_BANDS: [BandSetting, BandSetting, BandSetting] = [
  { on: true, mult: 1 }, // TV ships band #1 enabled
  { on: false, mult: 2 },
  { on: false, mult: 3 },
];

// Default per-figure line styles for AVWAP. The bands must read as the VWAP's
// ENVELOPE, not as separate AVWAP lines — so all band lines share the VWAP's
// orange hue (TradingView convention), dashed and thinner, distinguished by
// multiplier only via opacity (band #1 boldest, #3 faintest). FULL SmoothLineStyle
// entries — klinecharts' line drawer reads style/smooth/dashedValue, so a partial
// entry crashes it (same trap the settings modal's lineOverrides guards against).
const fullLine = (color: string, style: LineType): SmoothLineStyle => ({
  style,
  size: 1,
  color,
  dashedValue: [3, 3],
  smooth: false,
});
// VWAP orange at decreasing alpha for the three band multipliers, so a band reads
// as a fainter echo of the AVWAP line rather than an independent indicator.
const BAND_C1 = "rgba(255, 150, 0, 0.9)";
const BAND_C2 = "rgba(255, 150, 0, 0.6)";
const BAND_C3 = "rgba(255, 150, 0, 0.4)";
const AVWAP_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", LineType.Solid), // vwap
  fullLine(BAND_C1, LineType.Dashed), // up1
  fullLine(BAND_C1, LineType.Dashed), // dn1
  fullLine(BAND_C2, LineType.Dashed), // up2
  fullLine(BAND_C2, LineType.Dashed), // dn2
  fullLine(BAND_C3, LineType.Dashed), // up3
  fullLine(BAND_C3, LineType.Dashed), // dn3
];

// Volume-weighted VWAP + standard-deviation/percentage bands, accumulated from
// startIndex. The band stdev is the volume-weighted deviation of the source price
// from the running VWAP: variance = Σ(p²·vol)/Σvol − vwap², clamped at 0 (FP drift
// makes it slightly negative on near-flat data, and sqrt(NaN) would blank lines).
export function vwapFrom(
  dataList: KLineData[],
  startIndex: number,
  ext: AvwapExtend,
): VwapPoint[] {
  const source = ext.source ?? "hlc3";
  const mode = ext.bandMode ?? "stdev";
  const bands = ext.bands ?? AVWAP_DEFAULT_BANDS;
  const hidden = ext.lineHidden ?? {};
  const out: VwapPoint[] = [];
  let cumPV = 0;
  let cumPPV = 0; // Σ(price²·vol), for the volume-weighted variance
  let cumV = 0;
  for (let i = 0; i < dataList.length; i++) {
    if (i < startIndex) {
      out.push({});
      continue;
    }
    const k = dataList[i];
    const price = priceOf(k, source);
    const vol = k.volume ?? 0;
    cumPV += price * vol;
    cumPPV += price * price * vol;
    cumV += vol;
    // VWAP is undefined without traded volume. Most Capital CFD/forex epics report
    // 0 volume (backend reads `lastTradedVolume or 0.0`) and tick candles are always
    // volume 0, so cumV stays 0 — emit NOTHING rather than fall back to the raw
    // price, which used to plot VWAP as the price line with collapsed bands and read
    // as a working indicator. Once any bar carries volume, cumV > 0 and VWAP plots.
    if (cumV <= 0) {
      out.push({});
      continue;
    }
    // Compute vwap unconditionally (bands need it for vwap ± width), but only
    // EMIT the vwap line key when it isn't hidden — a hidden line omits its key
    // so klinecharts draws nothing (and the drag handle / legend value drop too).
    const vwap = cumPV / cumV;
    const point: VwapPoint = {};
    if (!hidden.vwap) point.vwap = vwap;
    // Band width: stdev (volume-weighted) or a flat percentage of the VWAP.
    const stdev =
      mode === "stdev" && cumV > 0
        ? Math.sqrt(Math.max(0, cumPPV / cumV - vwap * vwap))
        : 0;
    const keys: Array<["up1" | "up2" | "up3", "dn1" | "dn2" | "dn3"]> = [
      ["up1", "dn1"],
      ["up2", "dn2"],
      ["up3", "dn3"],
    ];
    for (let b = 0; b < 3; b++) {
      if (!bands[b]?.on) continue;
      const width = mode === "stdev" ? bands[b].mult * stdev : vwap * (bands[b].mult / 100);
      const [upKey, dnKey] = keys[b];
      if (!hidden[upKey]) point[upKey] = vwap + width;
      if (!hidden[dnKey]) point[dnKey] = vwap - width;
    }
    out.push(point);
  }
  return out;
}

interface MaPoint {
  ma?: number;
  // Optional smoothing MA layered on top of the base line (TV plots it
  // separately, never overwriting `ma`). Undefined when smoothing is "none".
  smoothingMa?: number;
}

// Per-instance config for the TV-style moving averages, carried on the
// indicator's extendData (set by the settings modal / MTF coordinator). When
// `mtf.timeframe` is set, the higher-timeframe series + bar starts are stored
// here and aligned onto the live chart bars inside calc — so scroll-back fills
// in automatically (calc re-runs against the longer dataList).
export interface MaExtend extends MaOptions {
  mtf?: {
    timeframe: string | null;
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfSeries?: Array<number | undefined>; // MA value per HTF bar
    htfMs?: number; // HTF bar duration (ms)
  };
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  // Lives here so applyMaTimeframe (which rewrites extendData) preserves it.
  hideLegendValue?: boolean;
}

// EMA/MA figures: the base line plus a separate smoothing-MA line (TV plots the
// smoothing MA as its own curve, never replacing the base). The smoothingMa
// figure auto-blanks when smoothing is "none" (its value is undefined on every
// bar), so the figure list stays static.
const MA_FIGURES = (label: "EMA" | "MA") => [
  { key: "ma", title: `${label}: `, type: "line" },
  { key: "smoothingMa", title: `${label} MA: `, type: "line" },
];
// Base keeps klinecharts' first default color (orange) so existing charts are
// unchanged; the smoothing MA is TV's yellow so it reads as a distinct overlay.
const MA_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", LineType.Solid), // ma (base)
  fullLine("#FFB300", LineType.Dashed), // smoothingMa
];

// ---------------------------------------------------------------------------
// Linear Regression Channel (TradingView "LR") — a least-squares line fit over
// the LAST `length` bars plus an upper/lower channel at ±mult·σ. Unlike the
// moving averages above this is NOT a per-bar rolling value: it's a single line
// fit over one fixed window (the most recent `length` bars), so every bar
// BEFORE the window is blank. Recomputes as new bars arrive / on scroll-back.
// ---------------------------------------------------------------------------
interface LrPoint {
  lr?: number; // regression line
  up?: number; // upper channel (lr + mult·σ)
  dn?: number; // lower channel (lr − mult·σ)
}

interface LrExtend {
  source?: PriceSource; // default close (TV default for LR)
  hideLegendValue?: boolean;
  // Per-line show/hide (Style tab), keyed by figure key (lr/up/dn).
  lineHidden?: Record<string, boolean>;
}

// LR base orange (matches the VWAP/MA palette) with the channel bands at lower
// opacity so they read as the regression's envelope, not separate lines.
const LR_C = "#FF9600";
const LR_BAND = "rgba(255, 150, 0, 0.6)";
const LR_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(LR_C, LineType.Solid), // lr
  { ...fullLine(LR_BAND, LineType.Solid), dashedValue: [0, 0] }, // up (solid, faint)
  { ...fullLine(LR_BAND, LineType.Solid), dashedValue: [0, 0] }, // dn
];

function computeLr(
  dataList: KLineData[],
  length: number,
  mult: number,
  ext: LrExtend,
): LrPoint[] {
  const source = ext.source ?? "close";
  const hidden = ext.lineHidden ?? {};
  const out: LrPoint[] = dataList.map(() => ({}));
  const n = Math.min(length, dataList.length);
  if (n < 2) return out; // need at least 2 points to fit a line
  const start = dataList.length - n;
  // Least-squares fit y = a + b·x over x = 0..n-1 (x is the bar's offset within
  // the window). Closed-form slope/intercept; then σ = RMS of residuals.
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = priceOf(dataList[start + i], source);
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const y = priceOf(dataList[start + i], source);
    const fit = intercept + slope * i;
    sse += (y - fit) * (y - fit);
  }
  const sigma = Math.sqrt(sse / n);
  const width = mult * sigma;
  for (let i = 0; i < n; i++) {
    const lr = intercept + slope * i;
    const point: LrPoint = {};
    if (!hidden.lr) point.lr = lr;
    if (!hidden.up) point.up = lr + width;
    if (!hidden.dn) point.dn = lr - width;
    out[start + i] = point;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Previous-period High/Low (TradingView "Previous Day/Week/Month HL"):
// stepped horizontal lines at the high and low of the most recent COMPLETED
// day / week / month — plus an INTERVAL boundary keyed to the chart's own bar
// timeframe, so the indicator works on any TF (e.g. "previous N 1H bars"). A
// constant value across a period's bars renders as the flat line TV draws; the
// level steps to the new aggregate when a fresh period begins. Each boundary
// aggregates over the previous N periods via a selectable function (max/min by
// default, or avg/median).
// ---------------------------------------------------------------------------
interface PrevHlPoint {
  rollingHigh?: number;
  rollingLow?: number;
  dayHigh?: number;
  dayLow?: number;
  weekHigh?: number;
  weekLow?: number;
  anchorHigh?: number;
  anchorLow?: number;
}

// How the previous N periods' highs (and lows) collapse into one level:
//  - "extreme": highest high / lowest low (the default, classic prev-period H/L)
//  - "avg":     mean of the highs / mean of the lows
//  - "median":  median of the highs / median of the lows (outlier-robust)
export type PrevHlAgg = "extreme" | "avg" | "median";

// Unit for the single ROLLING-range boundary. The nested time units (1 hr = 60 min,
// 24 hr = 1 day, …) all live on ONE rolling axis, so they're one control with a unit
// selector — "rolling 1 hour" ≡ "rolling 60 minutes". "bars" = the chart's own bars
// (absorbs the old Interval boundary: rolling, measured in bars).
type PrevHlRollingUnit = "bars" | "minute" | "hour" | "day" | "week";

// Whether the rolling clock-span counts closed-market time (time units only):
//  - "trading":  skip gaps — the span is N units of TRADING time (= a fixed bar
//                count), so it reaches a full N units back even across a weekend/
//                overnight. Stable bar count regardless of gaps.
//  - "wallclock": consume gaps — the span is N units of REAL elapsed time, so near
//                a session open it reaches across the gap and catches fewer bars.
type PrevHlGapMode = "trading" | "wallclock";

export interface PrevHlExtend {
  hideLegendValue?: boolean;
  // Per-line show/hide (Style tab), keyed by figure key (rollingHigh/dayLow/…).
  // calc OMITS a hidden line's key so klinecharts draws nothing for it — this is
  // how the per-boundary rolling/day/week + High/Low toggles take effect.
  lineHidden?: Record<string, boolean>;
  // Per-instance timezone OVERRIDE (Inputs tab). An IANA zone name buckets this
  // instance's day/week boundaries in that zone regardless of the chart axis;
  // absent (or "chart") follows the global chart timezone (indicatorTz). The
  // rolling boundary doesn't use the calendar zone.
  tz?: string;
  // Lookback length per boundary (Inputs tab), keyed by kind. For day/week it's a
  // count of previous COMPLETED (skip-empty, anchored) periods; for rolling it's the
  // number of `rollingUnit`s in the sliding window. Absent or <1 → 1.
  lengths?: Partial<Record<PeriodKind, number>>;
  // Aggregation function per boundary (Inputs tab). Absent → "extreme".
  aggs?: Partial<Record<PeriodKind, PrevHlAgg>>;
  // Rolling-range unit + gap handling (Inputs tab). Defaults: hour, trading.
  rollingUnit?: PrevHlRollingUnit;
  gapMode?: PrevHlGapMode;
  // Anchored boundary: the cumulative High/Low since this anchor time (epoch ms).
  // 0/absent = unplaced (no line). Length/agg don't apply — it's max-high/min-low
  // from the anchor onward. The typed date-time is interpreted in the instance's tz.
  anchorTs?: number;
}

// The boundary kinds, paired with their high/low figure keys. Order = figure order
// in the template + the Style-tab rows. Two orthogonal concepts:
//  - "rolling": a sliding trailing window of `length` × `rollingUnit` (bars or a
//               time unit). The general lookback — never resets.
//  - "day"/"week": ANCHORED, skip-empty calendar periods — the previous trading day/
//               week, flat across the current period and stepping at its boundary.
//  - "anchor": the cumulative high/low since a user-picked date-time (extendData
//               .anchorTs). Like an Anchored VWAP but for high/low; no line before it.
const PREV_HL_PERIODS: PrevHlBoundary[] = [
  { kind: "rolling", hi: "rollingHigh", lo: "rollingLow" },
  { kind: "day", hi: "dayHigh", lo: "dayLow" },
  { kind: "week", hi: "weekHigh", lo: "weekLow" },
  { kind: "anchor", hi: "anchorHigh", lo: "anchorLow" },
];

// Period boundaries are bucketed in the CHART'S timezone (the same IANA zone the
// time axis renders in — settings.timezone, or the browser zone when unset), so
// "previous day" steps exactly where the visible date label changes on the axis.
// ChartCore keeps this in sync via setIndicatorTimezone() whenever the user
// changes the timezone, and forces PREV_HL instances to recompute. Distinct keys
// are grouped in data order, so "previous day" is the prior day that actually HAS
// bars — weekends/holidays are skipped rather than leaving an empty calendar gap.
type PeriodKind = "rolling" | "day" | "week" | "anchor";

// The resolved IANA zone (never "") used to bucket bars. Defaults to the browser
// zone so the indicator is correct even before ChartCore pushes the chart's zone.
let indicatorTz: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

// Cache one formatter per zone (constructing Intl.DateTimeFormat per bar is slow).
// Keyed by zone so a per-instance override and the global chart zone can coexist.
// Each yields wall-clock Y/M/D + weekday in its zone for any timestamp.
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = tzFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour12: false,
    });
    tzFormatters.set(zone, fmt);
  }
  return fmt;
}

// Resolve an override zone ("" / "chart" / undefined → the global chart zone) to a
// concrete IANA name. An invalid name falls back to the chart zone.
function resolvePrevHlZone(tz: string | undefined): string {
  if (!tz || tz === "chart") return indicatorTz;
  try {
    // Validate: an unknown timeZone throws here.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return indicatorTz;
  }
}

// The IANA zone's UTC offset (ms) at instant `ts`: format `ts` in the zone, read it
// back as if UTC, and take the difference. Used to convert a typed wall-clock anchor
// to/from epoch ms in the instance's zone.
function tzOffsetMs(zone: string, ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ts);
  const m: Record<string, string> = {};
  for (const x of parts) m[x.type] = x.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - ts;
}

// Epoch ms → "YYYY-MM-DDTHH:mm" wall-clock in the instance's zone, for a datetime-
// local input. tz is the extendData.tz ("chart"/IANA/undefined). Empty when unplaced.
export function prevHlAnchorToInput(anchorTs: number, tz: string | undefined): string {
  if (!(anchorTs > 0)) return "";
  const zone = resolvePrevHlZone(tz);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(anchorTs);
  const m: Record<string, string> = {};
  for (const x of parts) m[x.type] = x.value;
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}`;
}

// "YYYY-MM-DDTHH:mm" wall-clock (in the instance's zone) → epoch ms. Two offset
// passes settle DST transitions. Empty/invalid → 0 (unplaced).
export function prevHlInputToAnchor(input: string, tz: string | undefined): number {
  if (!input) return 0;
  const zone = resolvePrevHlZone(tz);
  const [d, t] = input.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (t ?? "00:00").split(":").map(Number);
  if (!y || !mo || !da) return 0;
  let ts = Date.UTC(y, mo - 1, da, h || 0, mi || 0);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo - 1, da, h || 0, mi || 0) - tzOffsetMs(zone, ts);
  return ts;
}

// Set the zone PREV_HL buckets in (resolved IANA name; "" → browser zone). Called
// by ChartCore on timezone change. Returns true if the zone actually changed, so
// the caller only forces a recompute when needed.
export function setIndicatorTimezone(tz: string): boolean {
  let resolved = tz;
  if (!resolved) {
    try {
      resolved = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      resolved = "UTC";
    }
  }
  if (resolved === indicatorTz) return false;
  indicatorTz = resolved;
  return true;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

// Zone-local Y/M/D/weekday for a timestamp, via the cached formatter for `zone`.
function zonedParts(ts: number, zone: string): { y: number; m: number; d: number; wd: number } {
  const parts = zoneFormatter(zone).formatToParts(ts);
  let y = 0;
  let m = 0;
  let d = 0;
  let wd = 0;
  for (const p of parts) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
    else if (p.type === "weekday") wd = WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { y, m, d, wd };
}

// Bucket key for the ANCHORED count-mode boundaries (day/week). The rolling boundary
// is a sliding window computed separately, so it never reaches here.
function periodKey(ts: number, kind: "day" | "week", zone: string): number {
  const { y, m, d, wd } = zonedParts(ts, zone);
  switch (kind) {
    case "day":
      // A unique ordinal for the zone-local calendar day (proleptic-ish): the
      // exact value is irrelevant, only that it's distinct per day and equal for
      // all bars of the same zone-local day.
      return y * 10000 + m * 100 + d;
    case "week": {
      // ISO week starting Monday: the Monday's UTC-epoch-day, derived from the
      // zone-local day-of-week. Using a fixed UTC anchor keeps the key stable and
      // comparable; we only need same-week bars to collapse to one key.
      const dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000); // zone-local date as UTC ordinal
      return dayNum - wd; // back up to Monday (wd: Mon=0 … Sun=6)
    }
  }
}

// Collapse one side's values (the window's highs, or its lows) into a single level
// per the chosen function. `wantMax` only matters for "extreme": highs take the max
// (highest high), lows take the min (lowest low).
function aggregate(values: number[], fn: PrevHlAgg, wantMax: boolean): number {
  if (fn === "avg") {
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }
  if (fn === "median") {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // "extreme": highest high (max) for the upper line, lowest low (min) for the lower.
  let acc = wantMax ? -Infinity : Infinity;
  for (const v of values) acc = wantMax ? Math.max(acc, v) : Math.min(acc, v);
  return acc;
}

// The typical bar spacing (ms), as the median positive timestamp delta — robust to
// occasional gaps. 0 when there's too little data to tell.
function estimateBarMs(dataList: KLineData[]): number {
  if (dataList.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < dataList.length; i++) {
    const d = dataList[i].timestamp - dataList[i - 1].timestamp;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
}

type PrevHlBoundary = { kind: PeriodKind; hi: keyof PrevHlPoint; lo: keyof PrevHlPoint };

// ANCHORED count mode (day / week): the window is the last N COMPLETED calendar
// buckets that actually have data — empty buckets are skipped, so a Monday's
// "previous day" is Friday. The level is flat across the current period and steps as
// each bucket finishes (classic previous-day / previous-week high & low).
function computeBucketed(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  n: number,
  fn: PrevHlAgg,
  zone: string,
  hidden: Record<string, boolean>,
): void {
  const kind = p.kind as "day" | "week";
  const window: Array<{ hi: number; lo: number }> = [];
  let curKey: number | null = null;
  let curHi = -Infinity;
  let curLo = Infinity;
  let aggHi: number | undefined;
  let aggLo: number | undefined;
  for (let i = 0; i < dataList.length; i++) {
    const k = dataList[i];
    const key = periodKey(k.timestamp, kind, zone);
    if (curKey === null) {
      curKey = key;
    } else if (key !== curKey) {
      window.push({ hi: curHi, lo: curLo });
      if (window.length > n) window.shift();
      aggHi = window.length ? aggregate(window.map((w) => w.hi), fn, true) : undefined;
      aggLo = window.length ? aggregate(window.map((w) => w.lo), fn, false) : undefined;
      curKey = key;
      curHi = -Infinity;
      curLo = Infinity;
    }
    curHi = Math.max(curHi, k.high);
    curLo = Math.min(curLo, k.low);
    if (aggHi !== undefined && !hidden[p.hi]) out[i][p.hi] = aggHi;
    if (aggLo !== undefined && !hidden[p.lo]) out[i][p.lo] = aggLo;
  }
}

// Milliseconds per rolling time unit. "bars" has no fixed ms (it counts chart bars).
const ROLLING_UNIT_MS: Record<Exclude<PrevHlRollingUnit, "bars">, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// ROLLING mode: a sliding trailing window over the bars BEFORE each bar. The window
// size is `length` × `unit`:
//  - unit "bars": exactly `length` previous chart bars (absorbs the old Interval).
//  - a time unit, "trading" gap mode: a FIXED bar count round(span / barMs) — skips
//    closed time, so the window always holds the same number of real bars
//    (1 hour ≡ 60 minutes ≡ 4 bars on a 15m chart).
//  - a time unit, "wallclock" gap mode: bars whose timestamp falls in [now − span,
//    now) — real elapsed time, so a market gap shrinks how many bars land in it.
function computeRolling(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  length: number,
  unit: PrevHlRollingUnit,
  gapMode: PrevHlGapMode,
  fn: PrevHlAgg,
  hidden: Record<string, boolean>,
  barMs: number,
): void {
  const isBars = unit === "bars";
  const spanMs = isBars ? 0 : length * ROLLING_UNIT_MS[unit];
  const useWallclock = !isBars && gapMode === "wallclock";
  // Bar-count window (bars unit, or a time span in trading mode).
  const barCount = isBars
    ? Math.max(1, Math.floor(length))
    : barMs > 0
      ? Math.max(1, Math.round(spanMs / barMs))
      : 1;
  let left = 0; // wallclock sliding-window left edge
  for (let i = 0; i < dataList.length; i++) {
    let start: number; // first bar of the window (inclusive); window is [start, i)
    if (useWallclock) {
      const cutoff = dataList[i].timestamp - spanMs;
      while (left < i && dataList[left].timestamp < cutoff) left++;
      start = left;
      if (start >= i) continue; // nothing in the trailing span
    } else {
      start = i - barCount;
      if (start < 0) continue; // not enough prior bars yet
    }
    const his: number[] = [];
    const los: number[] = [];
    for (let j = start; j < i; j++) {
      his.push(dataList[j].high);
      los.push(dataList[j].low);
    }
    if (!his.length) continue;
    if (!hidden[p.hi]) out[i][p.hi] = aggregate(his, fn, true);
    if (!hidden[p.lo]) out[i][p.lo] = aggregate(los, fn, false);
  }
}

// ANCHORED-since mode: the cumulative high/low from the anchor timestamp onward —
// max-high and min-low over every bar at/after the anchor (an Anchored-VWAP-style
// running extreme). No line before the anchor. Always max/min (length/agg N/A).
function computeAnchor(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  anchorTs: number,
  hidden: Record<string, boolean>,
): void {
  if (!(anchorTs > 0)) return; // unplaced → no line
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < dataList.length; i++) {
    const k = dataList[i];
    if (k.timestamp < anchorTs) continue;
    hi = Math.max(hi, k.high);
    lo = Math.min(lo, k.low);
    if (!hidden[p.hi]) out[i][p.hi] = hi;
    if (!hidden[p.lo]) out[i][p.lo] = lo;
  }
}

function computePrevHl(dataList: KLineData[], ext: PrevHlExtend): PrevHlPoint[] {
  const hidden = ext.lineHidden ?? {};
  const zone = resolvePrevHlZone(ext.tz);
  const lengths = ext.lengths ?? {};
  const aggs = ext.aggs ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const gapMode: PrevHlGapMode = ext.gapMode ?? "trading";
  const anchorTs = Number(ext.anchorTs) || 0;
  const out: PrevHlPoint[] = dataList.map(() => ({}));
  // Only compute boundaries that have at least one visible line.
  const active = PREV_HL_PERIODS.filter((p) => !hidden[p.hi] || !hidden[p.lo]);
  if (!active.length) return out;
  const barMs = estimateBarMs(dataList);

  for (const p of active) {
    const n = Math.max(1, Math.floor(lengths[p.kind] ?? 1));
    const fn: PrevHlAgg = aggs[p.kind] ?? "extreme";
    if (p.kind === "anchor") {
      computeAnchor(dataList, out, p, anchorTs, hidden);
    } else if (p.kind === "rolling") {
      // A time span shorter than one bar can't form a window (degenerate, e.g.
      // "10 minutes" on a 15m chart) → draw nothing. "bars" is never degenerate.
      if (rollingUnit !== "bars" && barMs > 0 && n * ROLLING_UNIT_MS[rollingUnit] < barMs) continue;
      computeRolling(dataList, out, p, n, rollingUnit, gapMode, fn, hidden, barMs);
    } else {
      // day/week are degenerate when one period is finer than a bar (e.g. "day" on a
      // weekly chart) → draw nothing.
      if (barMs > 0) {
        const unitMs = p.kind === "day" ? 86_400_000 : 604_800_000;
        if (n * unitMs < barMs) continue;
      }
      computeBucketed(dataList, out, p, n, fn, zone, hidden);
    }
  }
  return out;
}


// A millisecond span as a plain phrase, e.g. "1 week", "4 hours", "15 minutes" —
// used to tell the user the minimum lookback at the current timeframe.
function humanDuration(ms: number): string {
  const units: [number, string][] = [
    [604_800_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [u, name] of units) {
    if (ms >= u && ms % u === 0) {
      const n = ms / u;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  for (const [u, name] of units) {
    if (ms >= u) {
      const n = Math.round(ms / u);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? "" : "s"}`;
}

// Whether any ACTIVE boundary draws nothing at the current bar spacing (its window
// is shorter than one bar) — mirrors the `continue` (skip) conditions in
// computePrevHl. The minimum valid window is one bar, so `minDuration` is the bar's
// own duration as a phrase ("1 week" on a 1W chart). The legend uses this for its
// warning. degenerate=false when nothing is too short (or there's too little data).
export function prevHlDegenerateInfo(
  dataList: KLineData[],
  ext: PrevHlExtend,
): { degenerate: boolean; minDuration: string } {
  const barMs = estimateBarMs(dataList);
  if (!barMs) return { degenerate: false, minDuration: "" };
  const hidden = ext.lineHidden ?? {};
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  let degenerate = false;
  for (const p of PREV_HL_PERIODS) {
    if (hidden[p.hi] && hidden[p.lo]) continue; // boundary fully off → not shown
    if (p.kind === "anchor") continue; // anchored window — never degenerate
    const n = Math.max(1, Math.floor(lengths[p.kind] ?? 1));
    let unitMs: number;
    if (p.kind === "rolling") {
      if (rollingUnit === "bars") continue; // bar-counted → never degenerate
      unitMs = ROLLING_UNIT_MS[rollingUnit];
    } else {
      unitMs = p.kind === "day" ? 86_400_000 : 604_800_000;
    }
    if (n * unitMs < barMs) {
      degenerate = true;
      break;
    }
  }
  return { degenerate, minDuration: humanDuration(barMs) };
}

// A compact summary of the ACTIVE boundaries' lookbacks, for the legend row — e.g.
// "12 hours, 1 day, since 2026-02-01 09:30". Skips hidden boundaries and an unplaced
// anchor. Empty when nothing is active.
export function prevHlLegendSummary(ext: PrevHlExtend): string {
  const hidden = ext.lineHidden ?? {};
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const on = (hi: string, lo: string) => !hidden[hi] || !hidden[lo];
  const count = (k: PeriodKind) => Math.max(1, Math.floor(lengths[k] ?? 1));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (on("rollingHigh", "rollingLow")) parts.push(plural(count("rolling"), rollingUnit));
  if (on("dayHigh", "dayLow")) parts.push(plural(count("day"), "day"));
  if (on("weekHigh", "weekLow")) parts.push(plural(count("week"), "week"));
  if (on("anchorHigh", "anchorLow")) {
    const ts = Number(ext.anchorTs) || 0;
    if (ts > 0) parts.push(`since ${prevHlAnchorToInput(ts, ext.tz).replace("T", " ")}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Curve-end labels (generic, all indicators)
// ---------------------------------------------------------------------------
// When an indicator is selected or highlighted, a small DOM pill is drawn at the
// right (or left) end of each plotted curve showing that curve's KEY parameter —
// e.g. Prev HL's day-high/low curves get "1d", week gets "1w", a 4-hour rolling
// window gets "4h". The text is per-figure; the position (side + vertical align)
// is configured per instance in the settings modal and lives on extendData under
// the generic `curveLabels` key. Enabled by default.

export type CurveLabelSide = "right" | "left";
export type CurveLabelAlign = "above" | "center" | "below";

// A pill's placement: which end of the curve it sits past + its vertical align.
export interface CurveLabelPos {
  side?: CurveLabelSide; // which end of the curve the pill sits past (default right)
  align?: CurveLabelAlign; // vertical placement vs the curve end (default center)
}

interface CurveLabelConfig {
  // Default-ON: treat absent as enabled, but an explicit false must persist (the
  // rehydrate guard in the settings modal writes false rather than deleting).
  enabled?: boolean;
  // When true, labels stay visible permanently; otherwise (default) they show only
  // while the indicator is selected or highlighted (hover/legend).
  always?: boolean;
  // Position is configured SEPARATELY for the High curves and the Low curves, so a
  // user can e.g. put High labels above-right and Low labels below-right.
  high?: CurveLabelPos;
  low?: CurveLabelPos;
  // LEGACY flat fields (pre-split). Read-only back-compat: an old config with a
  // single side/align seeds BOTH high and low. New saves use high/low only.
  side?: CurveLabelSide;
  align?: CurveLabelAlign;
}

export interface ResolvedCurveLabels {
  enabled: boolean;
  always: boolean;
  high: Required<CurveLabelPos>;
  low: Required<CurveLabelPos>;
}

// Read the curve-label config off any indicator's extendData with defaults applied.
// A legacy flat side/align seeds both high and low (so older saved instances keep
// their look); otherwise each defaults to right/center.
export function curveLabelConfig(extendData: unknown): ResolvedCurveLabels {
  const c = (extendData as { curveLabels?: CurveLabelConfig } | undefined)?.curveLabels ?? {};
  const resolve = (pos: CurveLabelPos | undefined): Required<CurveLabelPos> => ({
    side: pos?.side ?? c.side ?? "right",
    align: pos?.align ?? c.align ?? "center",
  });
  return {
    enabled: c.enabled ?? true,
    always: c.always ?? false,
    high: resolve(c.high),
    low: resolve(c.low),
  };
}

// Which placement (high vs low) a figure uses, by its key convention (…High/…Low).
// Indicators without a Low curve fall through to the high placement.
export function curveLabelPosFor(cfg: ResolvedCurveLabels, figKey: string): Required<CurveLabelPos> {
  return /low$/i.test(figKey) ? cfg.low : cfg.high;
}

// Abbreviate a rolling unit, matching the chart's own interval buttons (1m / 4H /
// 3D / 1W — lowercase minute, uppercase H/D/W). "bars" has no interval button, so
// "bar" reads clearest.
const ROLLING_UNIT_ABBR: Record<PrevHlRollingUnit, string> = {
  minute: "m",
  hour: "H",
  day: "D",
  week: "W",
  bars: "bar",
};

// Per-FIGURE key parameter, as a readable tag (e.g. "3D range low", "EMA 20",
// "AVWAP +1σ"). Returns null for figures/indicators that have no meaningful
// per-curve parameter (no pill drawn). This is the one generic seam: a switch on
// indType, each indicator contributing its own mapping. `calcParams` carries the
// per-instance lengths/multipliers (length in [0], mult in [1] where applicable).
export function curveLabel(
  indType: string,
  figKey: string,
  extendData: unknown,
  calcParams?: unknown[],
): string | null {
  switch (indType) {
    case "PREV_HL":
      return prevHlCurveLabel(figKey, extendData as PrevHlExtend);
    case "EMA":
      return maCurveLabel("EMA", figKey, calcParams);
    case "MA":
      return maCurveLabel("MA", figKey, calcParams);
    case "LR":
      return lrCurveLabel(figKey, calcParams);
    case "VWAP":
      return figKey === "vwap" ? "VWAP" : null;
    case "AVWAP":
      return avwapCurveLabel(figKey, extendData as AvwapExtend);
    case "RSI":
      return figKey === "rsi" ? `RSI ${maLen(calcParams, 14)}` : null;
    // klinecharts built-in overlays (no extendData beyond indType). Figure keys are
    // klinecharts' own; lengths in calcParams[0]. None end in "low" → high slot.
    case "SMA":
      return figKey === "sma" ? `SMA ${maLen(calcParams, 12)}` : null;
    case "BBI":
      // BBI averages four periods (3/6/12/24) — too many to spell out, so just "BBI".
      return figKey === "bbi" ? "BBI" : null;
    case "BOLL":
      return bollCurveLabel(figKey, calcParams);
    default:
      return null;
  }
}

// BOLL (Bollinger Bands): basis "BOLL 20"; the ±mult·σ bands as "BOLL 20 upper"/"lower".
function bollCurveLabel(figKey: string, calcParams?: unknown[]): string | null {
  const base = `BOLL ${maLen(calcParams, 20)}`;
  switch (figKey) {
    case "mid":
      return base;
    case "up":
      return `${base} upper`;
    case "dn":
      return `${base} lower`;
    default:
      return null;
  }
}

// Pull a positive integer length/param from calcParams[i], falling back to `def`.
function maLen(calcParams: unknown[] | undefined, def: number, i = 0): number {
  const n = Number(calcParams?.[i]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// EMA/MA: base line gets "EMA 20"; the separate smoothing MA gets "EMA 20 MA".
// (The smoothing line only produces coords when smoothing is on, so a "none"
// smoothing never reaches here.)
function maCurveLabel(label: "EMA" | "MA", figKey: string, calcParams?: unknown[]): string | null {
  const base = `${label} ${maLen(calcParams, label === "EMA" ? 9 : 20)}`;
  if (figKey === "ma") return base;
  if (figKey === "smoothingMa") return `${base} MA`;
  return null;
}

// LR: regression line "LR 100"; the ±mult·σ channel lines as "LR 100 upper"/"lower".
function lrCurveLabel(figKey: string, calcParams?: unknown[]): string | null {
  const base = `LR ${maLen(calcParams, 100)}`;
  switch (figKey) {
    case "lr":
      return base;
    case "up":
      return `${base} upper`;
    case "dn":
      return `${base} lower`;
    default:
      return null;
  }
}

// AVWAP: value line "AVWAP"; each band line "AVWAP ±Nσ" (or "±N%" in percentage
// mode), N being that band's multiplier from extendData.bands.
function avwapCurveLabel(figKey: string, ext: AvwapExtend): string | null {
  if (figKey === "vwap") return "AVWAP";
  const m = /^(up|dn)([123])$/.exec(figKey);
  if (!m) return null;
  const bands = ext.bands ?? AVWAP_DEFAULT_BANDS;
  const band = bands[Number(m[2]) - 1];
  const mult = band?.mult ?? Number(m[2]);
  const unit = ext.bandMode === "percentage" ? "%" : "σ";
  return `AVWAP ${m[1] === "up" ? "+" : "−"}${mult}${unit}`;
}

// Prev HL: each curve's tag spells out its kind + lookback + which extreme — e.g.
// "3D range low" (low of a 3-day rolling window), "prev 1D high" (previous day's
// high), "prev 2W low", "since 02-01 high" (anchored). The kind/length is shared by
// the boundary's High/Low pair; the trailing "high"/"low" comes from the figure key.
function prevHlCurveLabel(figKey: string, ext: PrevHlExtend): string | null {
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const count = (k: PeriodKind) => Math.max(1, Math.floor(lengths[k] ?? 1));
  const p = PREV_HL_PERIODS.find((x) => x.hi === figKey || x.lo === figKey);
  if (!p) return null;
  const side = p.hi === figKey ? "high" : "low";
  let base: string;
  switch (p.kind) {
    case "rolling":
      base = `${count("rolling")}${ROLLING_UNIT_ABBR[rollingUnit]} range`;
      break;
    case "day":
      base = `prev ${count("day")}D`;
      break;
    case "week":
      base = `prev ${count("week")}W`;
      break;
    case "anchor": {
      const ts = Number(ext.anchorTs) || 0;
      if (ts <= 0) return null;
      // Month-day of the anchor (the curve runs from that date); keep it compact.
      base = `since ${prevHlAnchorToInput(ts, ext.tz).slice(5, 10)}`;
      break;
    }
    default:
      return null;
  }
  return `${base} ${side}`;
}

// One hue per boundary so minute/hour/day/week/interval read apart at a glance; the
// High and Low of a period share the hue (TradingView convention), distinguished by
// position. FULL SmoothLineStyle entries (the line drawer crashes on partials).
const PREV_HL_C_ROLLING = "#089981"; // green
const PREV_HL_C_DAY = "#2962ff"; // blue
const PREV_HL_C_WEEK = "#FF9600"; // orange
const PREV_HL_C_ANCHOR = "#E11D74"; // pink
const PREV_HL_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(PREV_HL_C_ROLLING, LineType.Dashed), // rollingHigh
  fullLine(PREV_HL_C_ROLLING, LineType.Dashed), // rollingLow
  fullLine(PREV_HL_C_DAY, LineType.Dashed), // dayHigh
  fullLine(PREV_HL_C_DAY, LineType.Dashed), // dayLow
  fullLine(PREV_HL_C_WEEK, LineType.Dashed), // weekHigh
  fullLine(PREV_HL_C_WEEK, LineType.Dashed), // weekLow
  fullLine(PREV_HL_C_ANCHOR, LineType.Solid), // anchorHigh (solid: a fixed reference)
  fullLine(PREV_HL_C_ANCHOR, LineType.Solid), // anchorLow
];

function computeMa(
  dataList: KLineData[],
  kind: "ema" | "sma",
  length: number,
  ext: MaExtend,
): MaPoint[] {
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars (no lookahead — each bar takes the most recent CLOSED HTF bar).
    const aligned = alignHtfToChart(
      dataList.map((k) => k.timestamp),
      mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData),
      mtf.htfSeries,
      mtf.htfMs,
      true,
    );
    // NOTE: the MTF path carries a single precomputed line (htfSeries = the base
    // MA on the higher timeframe), so the smoothing MA is intentionally NOT shown
    // under MTF. Smoothing applies on the chart-timeframe path below.
    return aligned.map((v) => ({ ma: v ?? undefined }));
  }
  const { base, smoothing } = maSeries(dataList, kind, length, ext);
  return base.map((v, i) => ({
    ma: v ?? undefined,
    smoothingMa: smoothing?.[i] ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// RSI (TradingView "RSI") with optional DIVERGENCE detection. We deliberately
// REPLACE klinecharts' built-in RSI (which ships three lengths [6,12,24]) with a
// single-line, length-14 RSI matching TradingView — AND, unlike a built-in, this
// custom template can carry a `draw` callback so detected divergences are marked
// directly on the RSI plot. Divergence is OFF by default (extendData.divergence.on).
//
// RSI uses Wilder's smoothing (RMA), the same as TradingView's ta.rsi, so the
// curve matches TV rather than klinecharts' built-in. Length in calcParams[0];
// divergence config on extendData (RsiExtend).
// ---------------------------------------------------------------------------
type DivergenceKind = "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";

// One divergence line to draw on the RSI pane: from a previous RSI pivot to the
// confirmed pivot at this bar. Stashed on the right-pivot bar's result point as a
// NON-figure field (klinecharts only reads figure keys, so it ignores `divs`).
interface DivSegment {
  kind: DivergenceKind;
  fromIndex: number; // previous pivot bar (data index)
  fromValue: number; // RSI at the previous pivot
  toIndex: number; // this bar (the confirmed pivot)
  toValue: number; // RSI here
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
}

export interface RsiExtend {
  source?: PriceSource; // price the RSI is computed on (default close, TV default)
  smoothing?: RsiSmoothing; // optional MA of the RSI (+ Bollinger Bands)
  divergence?: Partial<RsiDivergenceConfig>;
  style?: Partial<RsiStyle>; // Style-tab colours/levels for the canvas-drawn elements
  hideLegendValue?: boolean;
}

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
function detectDivergences(
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
  // TradingView's ta.pivothigh/low). `want === "low"` finds a local minimum (ties
  // allowed: no neighbour strictly lower), `"high"` a local maximum.
  const isPivot = (i: number, want: "low" | "high"): boolean => {
    const v = rsi[i];
    if (v === undefined) return false;
    if (i - lbL < 0 || i + lbR >= n) return false;
    for (let j = i - lbL; j <= i + lbR; j++) {
      const w = rsi[j];
      if (w === undefined) return false;
      if (j !== i && (want === "low" ? w < v : w > v)) return false;
    }
    return true;
  };
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
      const hidden = s.kind === "hiddenBullish" || s.kind === "hiddenBearish";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.setLineDash(hidden ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Label outside the pivot: above for bearish (RSI tops), below for bullish.
      ctx.setLineDash([]);
      ctx.fillText(DIV_LABEL[s.kind], x2 + 3, bullish ? y2 + 7 : y2 - 7);
    }
  }
  ctx.restore();
  return false; // keep the default RSI line
}

// Base templates for our custom indicator TYPES, keyed by type. Each is a full
// klinecharts indicator definition MINUS the `name` (the name is assigned per
// instance — either the type itself, or a unique "EMA#abc" id for multi-instance).
// `lib/indicators.ts` clones one of these under a fresh name to add an instance.
//
// EMA / MA: TV-style single-line MAs (length + source + offset + smoothing + MTF)
// that deliberately REPLACE klinecharts' built-in multi-line EMA/MA so the settings
// modal can expose Source/Offset/Timeframe. Length in calcParams[0]; rest on
// extendData (MaExtend).
export type CustomIndicatorType = "EMA" | "MA" | "LR" | "VWAP" | "AVWAP" | "PREV_HL" | "RSI";

export const BASE_TEMPLATES: Record<CustomIndicatorType, Omit<IndicatorTemplate, "name">> = {
  EMA: {
    shortName: "EMA",
    series: IndicatorSeries.Price,
    precision: 2,
    calcParams: [9],
    figures: MA_FIGURES("EMA"),
    styles: { lines: MA_DEFAULT_LINE_STYLES },
    calc: (dataList: KLineData[], ind: Indicator) =>
      computeMa(dataList, "ema", Number(ind.calcParams?.[0]) || 9, (ind.extendData ?? {}) as MaExtend),
  },
  MA: {
    shortName: "MA",
    series: IndicatorSeries.Price,
    precision: 2,
    calcParams: [20],
    figures: MA_FIGURES("MA"),
    styles: { lines: MA_DEFAULT_LINE_STYLES },
    calc: (dataList: KLineData[], ind: Indicator) =>
      computeMa(dataList, "sma", Number(ind.calcParams?.[0]) || 20, (ind.extendData ?? {}) as MaExtend),
  },
  // TV-style Linear Regression Channel: regression line + ±mult·σ channel over the
  // last `length` bars. calcParams = [length, mult]; source/visibility on extendData
  // (LrExtend). Bands share the line's hue (LR_DEFAULT_LINE_STYLES).
  LR: {
    shortName: "LR",
    series: IndicatorSeries.Price,
    precision: 2,
    calcParams: [100, 2],
    figures: [
      { key: "lr", title: "LR: ", type: "line" },
      { key: "up", type: "line" },
      { key: "dn", type: "line" },
    ],
    styles: { lines: LR_DEFAULT_LINE_STYLES },
    calc: (dataList: KLineData[], ind: Indicator) =>
      computeLr(
        dataList,
        Number(ind.calcParams?.[0]) || 100,
        Number(ind.calcParams?.[1]) || 2,
        (ind.extendData ?? {}) as LrExtend,
      ),
  },
  VWAP: {
    shortName: "VWAP",
    series: IndicatorSeries.Price,
    precision: 2,
    figures: [{ key: "vwap", title: "VWAP: ", type: "line" }],
    calc: (dataList: KLineData[]) => vwapFrom(dataList, 0, {}),
  },
  AVWAP: {
    shortName: "AVWAP",
    series: IndicatorSeries.Price,
    precision: 2,
    // calcParams[0] = anchor timestamp (ms). <= 0 means "unplaced": render no line
    // until the user anchors it by clicking a bar (TradingView-style).
    calcParams: [0],
    // Figure 0 is the VWAP line (kept first so the drag handle in ChartCore reads
    // result[idx].vwap). The 6 band lines follow; calc omits the key for disabled
    // bands so klinecharts draws nothing. Source + bands ride on extendData
    // (AvwapExtend); the anchor-param / legend-value hiding live in the shared
    // legendTooltipSource attached at creation. Band titles are blank so they don't
    // clutter the legend value row.
    figures: [
      { key: "vwap", title: "Value: ", type: "line" },
      { key: "up1", type: "line" },
      { key: "dn1", type: "line" },
      { key: "up2", type: "line" },
      { key: "dn2", type: "line" },
      { key: "up3", type: "line" },
      { key: "dn3", type: "line" },
    ],
    styles: { lines: AVWAP_DEFAULT_LINE_STYLES },
    calc: (dataList: KLineData[], indicator: Indicator) => {
      const anchorTs = Number(indicator.calcParams?.[0]) || 0;
      if (anchorTs <= 0) return dataList.map(() => ({})); // unplaced: no line yet
      const idx = dataList.findIndex((k) => k.timestamp >= anchorTs);
      const start = idx < 0 ? dataList.length : idx;
      return vwapFrom(dataList, start, (indicator.extendData ?? {}) as AvwapExtend);
    },
  },
  // Previous Minute/Hour/Day/Week/Interval High/Low: ten stepped horizontal lines.
  // Each boundary's High/Low pair toggles independently via the Style tab (extendData
  // .lineHidden → calc omits the key). Figure titles are blank so the lines don't
  // flood the legend value row (AVWAP-style); the Style tab labels them via a
  // dedicated map (PREV_HL_LINE_LABELS in IndicatorSettings).
  PREV_HL: {
    shortName: "Prev HL",
    series: IndicatorSeries.Price,
    precision: 2,
    figures: [
      { key: "rollingHigh", type: "line" },
      { key: "rollingLow", type: "line" },
      { key: "dayHigh", type: "line" },
      { key: "dayLow", type: "line" },
      { key: "weekHigh", type: "line" },
      { key: "weekLow", type: "line" },
      { key: "anchorHigh", type: "line" },
      { key: "anchorLow", type: "line" },
    ],
    styles: { lines: PREV_HL_DEFAULT_LINE_STYLES },
    calc: (dataList: KLineData[], ind: Indicator) =>
      computePrevHl(dataList, (ind.extendData ?? {}) as PrevHlExtend),
  },
  // Single-line, length-14 RSI (TradingView shape) that REPLACES klinecharts'
  // built-in three-length RSI, plus optional divergence marking via the `draw`
  // callback. Length in calcParams[0]; divergence config on extendData (RsiExtend).
  RSI: {
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
  },
};

// Register each base type under its own name (so a single instance can still use
// the bare type name "EMA", and so the type is always resolvable). Per-instance
// clones are registered on demand by lib/indicators.ts (registerInstanceTemplate).
export function registerCustomIndicators(): void {
  for (const [type, tmpl] of Object.entries(BASE_TEMPLATES)) {
    registerIndicator({ ...tmpl, name: type });
  }
}

// Indicators that overlay the price (candle) pane rather than a sub-pane.
export const OVERLAY_INDICATORS = new Set([
  "MA",
  "EMA",
  "SMA",
  "BOLL",
  "BBI",
  "SAR",
  "VWAP",
  "AVWAP",
  "LR",
  "PREV_HL",
]);
