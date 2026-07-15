// Resolving an on-chart indicator/drawing into a self-contained rule operand
// recipe, as picked via the strategy-side ChartOperandPicker. A recipe is a
// snapshot: once copied it stands alone, so editing/deleting the chart
// instance never changes the rule.
//
// Covers the app's custom indicator types minus SESSIONS (which has no price
// line and nothing to click-select) and the straight-line drawing family. Anything
// else (klinecharts stock built-ins, channels, fibs, vertical lines) is unsupported
// and the copy action is greyed out with a reason.

import type { KLineData } from "klinecharts";
import { recipeKey, type IndicatorRecipe, type DrawingRecipe, type SeriesRecipe, type SeriesIndicatorType, type DrawingKind, type SeriesOperand } from "./backtestConfig";
import { LINE_KEYS } from "./backtestSeries";
import { maLegendLabel, templateMaKind } from "./indicators/ma";
import { normalizeMaKind } from "./mtf";
import { PREV_HL_PERIODS } from "./indicators/prevHl";
import { DIVERGENCE_KINDS, RSI_DIVERGENCE_DEFAULTS, type DivergenceKind, type RsiExtend } from "./customIndicators";

/** Custom indicator types copyable into a rule (SESSIONS deferred). */
const SUPPORTED_INDICATORS = new Set<string>(["EMA", "MA", "LR", "VWAP", "AVWAP", "PREV_HL", "RSI", "PIVOT_BANDS", "PIVOT_ANALYSIS", "SLOPE"]);
/** Straight-line drawings evaluable as a per-bar price series. */
const SUPPORTED_DRAWINGS = new Set<string>([
  "segment", "rayLine", "straightLine", "horizontalStraightLine", "priceLine",
]);

/** extendData keys that are bookkeeping / render-state, not compute inputs — dropped
 * from the recipe snapshot so the hash is stable and the copied line always computes
 * (e.g. lineHidden would blank a style-hidden line's output). */
const NON_COMPUTE_EXTEND_KEYS = new Set<string>([
  "indType", "userVisible", "visibility", "mtf", "hideLegendValue", "lineHidden", "envelope",
]);

export function isSupportedIndicatorType(indType: string): boolean {
  return SUPPORTED_INDICATORS.has(indType);
}
export function isSupportedDrawingName(name: string): boolean {
  return SUPPORTED_DRAWINGS.has(name);
}

/** Why an unsupported indicator can't be copied (menu tooltip). */
export function indicatorCopyDisabledReason(indType: string): string {
  return `${indType} isn't supported in rules yet`;
}
export function drawingCopyDisabledReason(name: string): string {
  if (name === "priceChannelLine" || name.includes("channel")) return "Channels aren't supported in rules yet";
  if (name.includes("fibonacci") || name.startsWith("fib")) return "Fibonacci tools aren't supported in rules yet";
  if (name.includes("vertical")) return "A vertical line is a time, not a price — it can't be a rule operand";
  return "This drawing isn't supported in rules yet";
}

function sanitizeExtend(extendData: unknown): Record<string, unknown> | undefined {
  if (!extendData || typeof extendData !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extendData as Record<string, unknown>)) {
    if (!NON_COMPUTE_EXTEND_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Build an indicator recipe from a selected chart instance. `line` defaults to 0
 * (the primary curve); the selection model tracks the instance, not a sub-curve.
 * Captures the instance's MTF timeframe (if any) as the returned `timeframe`. */
export function indicatorToRecipe(
  indType: string,
  calcParams: number[],
  extendData: unknown,
  line = 0,
): { recipe: IndicatorRecipe; timeframe?: string } | null {
  if (!isSupportedIndicatorType(indType)) return null;
  const recipe: IndicatorRecipe = {
    source: "indicator",
    indicatorType: indType as SeriesIndicatorType,
    calcParams: calcParams.map(Number),
    line,
  };
  if (indType === "RSI" && line >= 1) {
    // A divergence output (line ≥ 1): the recipe carries ONLY what changes the
    // detected pivots — the price source (parity: the RSI curve the pivots sit on)
    // plus the pivot/range params, resolved over the defaults. The per-kind on/off
    // flags, style, and smoothing are deliberately dropped so two RSIs differing
    // only in those produce the SAME divergence seriesKey and dedup.
    const rext = (extendData ?? {}) as RsiExtend;
    const d = { ...RSI_DIVERGENCE_DEFAULTS, ...(rext.divergence ?? {}) };
    recipe.extend = {
      ...(rext.source ? { source: rext.source } : {}),
      divergence: { lookbackLeft: d.lookbackLeft, lookbackRight: d.lookbackRight, rangeMin: d.rangeMin, rangeMax: d.rangeMax },
    };
  } else {
    const extend = sanitizeExtend(extendData);
    // Canonicalize a default maType away: the settings modal persists the
    // template's own kind onto untouched EMA/MA instances, and leaving it in
    // the snapshot would hash the SAME curve to a different seriesKey than an
    // operand picked before the modal was ever opened.
    if (extend && (indType === "EMA" || indType === "MA")) {
      const tk = templateMaKind(indType);
      if (normalizeMaKind(extend.maType, tk) === tk) delete extend.maType;
    }
    // Canonicalization can empty the snapshot; absent beats {} for the hash.
    if (extend && Object.keys(extend).length > 0) recipe.extend = extend;
  }
  const mtf = (extendData as { mtf?: { timeframe?: string | null } } | undefined)?.mtf;
  const timeframe = mtf?.timeframe ?? undefined;
  return { recipe, timeframe: timeframe || undefined };
}

/** Build a drawing recipe from a selected overlay. Points may carry timestamp,
 * dataIndex, or both — every anchor is resolved to an absolute timestamp here
 * (against `candles`, extrapolating past the last bar) so later TF switches can't
 * corrupt the geometry. */
export function drawingToRecipe(
  name: string,
  points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>,
  candles: KLineData[],
): DrawingRecipe | null {
  if (!isSupportedDrawingName(name)) return null;
  const resolveTs = timestampResolver(candles);
  const anchors: Array<{ timestamp: number; value: number }> = [];
  for (const p of points) {
    const t = p.timestamp ?? (p.dataIndex != null ? resolveTs(p.dataIndex) : undefined);
    if (t == null || p.value == null || !Number.isFinite(p.value)) continue;
    anchors.push({ timestamp: t, value: p.value });
  }
  if (!anchors.length) return null;
  return { source: "drawing", drawingKind: name as DrawingKind, anchors };
}

/** dataIndex -> absolute timestamp against the loaded candles; extrapolates with
 * the bar spacing for indices at/after the last bar (klinecharts leaves those
 * points dataIndex-only, with no timestamp). */
function timestampResolver(candles: KLineData[]): (dataIndex: number) => number | undefined {
  const n = candles.length;
  const barMs = n >= 2 ? candles[1].timestamp - candles[0].timestamp : 60_000;
  return (dataIndex: number) => {
    if (dataIndex >= 0 && dataIndex < n) return candles[dataIndex].timestamp;
    if (n === 0) return undefined;
    if (dataIndex < 0) return candles[0].timestamp + dataIndex * barMs;
    return candles[n - 1].timestamp + (dataIndex - (n - 1)) * barMs;
  };
}

/** A short human label for the copied operand's chip / exit reason. */
export function recipeLabel(recipe: SeriesRecipe): string {
  if (recipe.source === "drawing") {
    const DRAW_LABELS: Record<string, string> = {
      segment: "Trendline",
      rayLine: "Ray",
      straightLine: "Line",
      horizontalStraightLine: "Horizontal line",
      priceLine: "Horizontal line",
    };
    return DRAW_LABELS[recipe.drawingKind] ?? "Drawing";
  }
  const t = recipe.indicatorType;
  // Types whose calcParams aren't a meaningful "(length)" label.
  if (t === "PIVOT_BANDS") return "Pivot Bands";
  if (t === "PIVOT_ANALYSIS") return "Pivots High/Low [LuxAlgo]";
  if (t === "SLOPE") return "MA Slope";
  if (t === "VWAP" || t === "AVWAP" || t === "PREV_HL") return t === "PREV_HL" ? "Prev H/L" : t;
  const params = recipe.calcParams.filter((n) => Number.isFinite(n));
  // EMA/MA instances can be flipped to a volume-weighted kind in settings; the
  // chip should say what actually computes. maLegendLabel keeps the never-
  // flipped rule: a plain MA(20) chip reads "MA(20)", not "SMA(20)", matching
  // the chart legend for the same instance.
  const base =
    t === "EMA" || t === "MA"
      ? maLegendLabel((recipe.extend as { maType?: unknown } | undefined)?.maType, templateMaKind(t))
      : t;
  return params.length ? `${base}(${params.join(", ")})` : base;
}

/** One selectable output line of an indicator instance. `base` marks the primary
 * line whose chip label carries NO output suffix (kept unsuffixed to avoid
 * doubling, e.g. "EMA(9)" rather than "EMA(9): Value"). `chipLabel`, when set,
 * is used verbatim as the operand chip label — opting out of the generic
 * "parent: child" composition — for types whose parent name doesn't encode the
 * distinguishing param (e.g. SLOPE: "MA Slope 9" rather than "MA Slope: Slope MA 9"). */
export interface OutputChoice {
  lineIndex: number;
  label: string;
  base?: boolean;
  chipLabel?: string;
}

// Picker labels for the RSI divergence outputs, by kind (composed as a base/suffix,
// e.g. "RSI(14): Bullish divergence" in chartOperandSources).
const RSI_DIV_LABELS: Record<DivergenceKind, string> = {
  bullish: "Bullish divergence",
  bearish: "Bearish divergence",
  hiddenBullish: "Hidden bullish divergence",
  hiddenBearish: "Hidden bearish divergence",
};

// Human labels for the PREV_HL boundary lines, by output key.
const PREV_HL_LABELS: Record<string, string> = {
  rollingHigh: "Rolling High", rollingLow: "Rolling Low",
  dayHigh: "Day High", dayLow: "Day Low",
  weekHigh: "Week High", weekLow: "Week Low",
  anchorHigh: "Anchor High", anchorLow: "Anchor Low",
};

/** The instance's ACTIVE output lines, mirroring exactly what computeIndicatorRecipe
 * (backtestSeries.ts) can resolve — so a picked line always reproduces a real curve.
 * `[]` for unsupported types. Reads the RAW extendData (which still carries the
 * render-state keys lineHidden/smoothing/anchorTs that the recipe snapshot strips). */
export function indicatorOutputs(indType: string, extendData: unknown, calcParams: number[]): OutputChoice[] {
  if (!isSupportedIndicatorType(indType)) return [];
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as Record<string, unknown>;
  switch (indType) {
    case "EMA":
    case "MA": {
      const sm = ext.smoothing as { type?: string; length?: number } | undefined;
      const out: OutputChoice[] = [{ lineIndex: 0, label: "Value", base: true }];
      if (sm && sm.type !== "none" && (sm.length ?? 0) > 0) out.push({ lineIndex: 1, label: "Smoothing" });
      return out;
    }
    case "LR": {
      const hidden = (ext.lineHidden ?? {}) as Record<string, boolean>;
      const keys = LINE_KEYS.LR; // ["lr","up","dn"]
      const labels: Record<string, string> = { lr: "Regression", up: "Upper", dn: "Lower" };
      const out: OutputChoice[] = [];
      keys.forEach((k, i) => {
        if (!hidden[k]) out.push(i === 0 ? { lineIndex: 0, label: labels.lr, base: true } : { lineIndex: i, label: labels[k] });
      });
      return out.length ? out : [{ lineIndex: 0, label: labels.lr, base: true }];
    }
    case "PREV_HL": {
      const hidden = (ext.lineHidden ?? {}) as Record<string, boolean>;
      const anchorTs = Number(ext.anchorTs) || 0;
      const keys = LINE_KEYS.PREV_HL;
      const out: OutputChoice[] = [];
      for (const b of PREV_HL_PERIODS) {
        if (b.kind === "anchor" && anchorTs <= 0) continue;
        for (const key of [b.hi, b.lo]) {
          if (hidden[key]) continue;
          out.push({ lineIndex: keys.indexOf(key), label: PREV_HL_LABELS[key] });
        }
      }
      return out;
    }
    // RSI: the value line PLUS all four confirmed-divergence event outputs. Always
    // all four regardless of the instance's divergence flags — the compute
    // force-detects the chosen kind either way (divergence-operands design).
    case "RSI":
      return [
        { lineIndex: 0, label: "Value", base: true },
        ...DIVERGENCE_KINDS.map((k, i) => ({ lineIndex: i + 1, label: RSI_DIV_LABELS[k] })),
      ];
    // Pivot Bands: both step-lines, always present (no per-line style-hide). Neither
    // is "primary", so mirror PREV_HL — no base line, both suffixed.
    case "PIVOT_BANDS":
      return [
        { lineIndex: 0, label: "Pivot High" },
        { lineIndex: 1, label: "Pivot Low" },
      ];
    // Pivots High/Low Analysis: the two forward-carried levels plus the most
    // recent swing's Δ%/Δt. Order matches LINE_KEYS.PIVOT_ANALYSIS. No base line.
    case "PIVOT_ANALYSIS":
      return [
        { lineIndex: 0, label: "Pivot High" },
        { lineIndex: 1, label: "Pivot Low" },
        { lineIndex: 2, label: "Δ% (last pivot)" },
        { lineIndex: 3, label: "Δt (last pivot)" },
      ];
    // VWAP/AVWAP resolve only line 0 in computeIndicatorRecipe.
    case "VWAP":
    case "AVWAP":
      return [{ lineIndex: 0, label: "Value", base: true }];
    case "SLOPE": {
      // Rate-only outputs in four fixed blocks relative to K. See the matching
      // `line` encoding in backtestSeries.ts's computeIndicatorRecipe and the
      // warm-up in backtestConfig.ts's operandBaseLen: all three must agree.
      const lengths = (Array.isArray(calcParams) ? calcParams : []).map(Number)
        .filter((v) => Number.isFinite(v) && v !== 0).slice(0, 5);
      const ls = lengths.length ? lengths : [9];
      const K = ls.length;
      const sm = ext.smoothing as { type?: string; length?: number } | undefined;
      const smOn = !!sm && sm.type !== "none" && (sm.length ?? 0) > 1;
      const aSm = ext.accelSmoothing as { type?: string; length?: number } | undefined;
      const aSmOn = !!aSm && aSm.type !== "none" && (aSm.length ?? 0) > 1;
      // The parent label ("MA Slope") carries no length, so the chip fuses the
      // length in ("MA Slope 9") rather than reading "MA Slope: Slope MA 9".
      const slopes = ls.map((len, i) => ({ lineIndex: i, label: `Slope MA ${len}`, chipLabel: `MA Slope ${len}` }));
      const smoothed = smOn
        ? ls.map((len, i) => {
            const suffix = `${String(sm!.type).toUpperCase()} ${sm!.length}`;
            return { lineIndex: K + i, label: `Slope MA ${len} · ${suffix}`, chipLabel: `MA Slope ${len} · ${suffix}` };
          })
        : [];
      const accel = ext.showAccel
        ? ls.map((len, i) => ({ lineIndex: 2 * K + i, label: `Accel MA ${len}`, chipLabel: `MA Accel ${len}` }))
        : [];
      const accelSmoothed = ext.showAccel && aSmOn
        ? ls.map((len, i) => {
            const suffix = `${String(aSm!.type).toUpperCase()} ${aSm!.length}`;
            return { lineIndex: 3 * K + i, label: `Accel MA ${len} · ${suffix}`, chipLabel: `MA Accel ${len} · ${suffix}` };
          })
        : [];
      return [...slopes, ...smoothed, ...accel, ...accelSmoothed];
    }
    default:
      return [];
  }
}

/** One on-chart instance/drawing, as passed to `chartOperandSources` — the
 * fields the picker enumeration reads off a klinecharts overlay/indicator. */
export type RawChartSource =
  | { kind: "indicator"; id: string; paneId: string; indType: string; calcParams: number[]; extendData: unknown }
  | { kind: "drawing"; id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>; candles: KLineData[]; text?: string; color?: string };

/** What the caller must poke to highlight the matching on-chart element while a picker
 * row is hovered — a drawing overlay (by id → `overlays.hoverDrawing`) or an indicator
 * curve (by pane+name → `controller.curveHover`). */
export type EmphasisTarget =
  | { kind: "drawing"; id: string }
  | { kind: "indicator"; paneId: string; name: string };

export interface PickerOutput extends OutputChoice { operand: SeriesOperand }
export interface ChartOperandSource {
  id: string;
  baseLabel: string;
  /** The drawing's on-chart line color, for a picker swatch. Undefined for indicators
   * (already distinguished by their params). */
  color?: string;
  /** The on-chart element to emphasize while this row is hovered. */
  emphasis?: EmphasisTarget;
  disabled?: boolean;
  disabledReason?: string;
  outputs: PickerOutput[];
}

/** Append the drawing's custom text so two same-type drawings read differently, e.g.
 * `Trendline 'daily uptrend'`. No text ⇒ the bare type label. */
function drawingLabel(base: string, text?: string): string {
  return text ? `${base} '${text}'` : base;
}

/** Turn one on-chart instance/drawing into a picker row with a ready-built operand
 * per active output. Pure — all chart access happens in enumerateChartOperands. */
export function chartOperandSources(raw: RawChartSource): ChartOperandSource {
  if (raw.kind === "drawing") {
    const emphasis: EmphasisTarget = { kind: "drawing", id: raw.id };
    if (!isSupportedDrawingName(raw.name)) {
      return { id: raw.id, baseLabel: drawingLabel(raw.name, raw.text), color: raw.color, emphasis, disabled: true, disabledReason: drawingCopyDisabledReason(raw.name), outputs: [] };
    }
    const recipe = drawingToRecipe(raw.name, raw.points, raw.candles);
    if (!recipe) {
      return { id: raw.id, baseLabel: drawingLabel(raw.name, raw.text), color: raw.color, emphasis, disabled: true, disabledReason: "This drawing has no anchors yet", outputs: [] };
    }
    const label = drawingLabel(recipeLabel(recipe), raw.text);
    const operand: SeriesOperand = { kind: "series", seriesKey: recipeKey(recipe), label, recipe };
    return { id: raw.id, baseLabel: label, color: raw.color, emphasis, outputs: [{ lineIndex: 0, label, base: true, operand }] };
  }
  const emphasis: EmphasisTarget = { kind: "indicator", paneId: raw.paneId, name: raw.id };
  if (!isSupportedIndicatorType(raw.indType)) {
    return { id: raw.id, baseLabel: raw.indType, emphasis, disabled: true, disabledReason: indicatorCopyDisabledReason(raw.indType), outputs: [] };
  }
  const outputs = indicatorOutputs(raw.indType, raw.extendData, raw.calcParams);
  // baseLabel comes from a line-0 recipe (recipeLabel ignores `line`).
  const built0 = indicatorToRecipe(raw.indType, raw.calcParams, raw.extendData, 0);
  const baseLabel = built0 ? recipeLabel(built0.recipe) : raw.indType;
  const rows: PickerOutput[] = [];
  for (const o of outputs) {
    const built = indicatorToRecipe(raw.indType, raw.calcParams, raw.extendData, o.lineIndex);
    if (!built) continue;
    const label = o.chipLabel ?? (o.base ? baseLabel : `${baseLabel}: ${o.label}`);
    const operand: SeriesOperand = {
      kind: "series", seriesKey: recipeKey(built.recipe), label, recipe: built.recipe,
      ...(built.timeframe ? { timeframe: built.timeframe } : {}),
    };
    rows.push({ ...o, operand });
  }
  return { id: raw.id, baseLabel, emphasis, outputs: rows };
}
