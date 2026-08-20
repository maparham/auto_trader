import type { Chart, Indicator, IndicatorFigure, IndicatorTemplate } from "klinecharts";
import { BASE_TEMPLATES, indTypeOf, type CustomIndicatorType } from "../customIndicators";
import { DASH_DASHED, hexToRgba, rgbaToHexAlpha } from "../lineStyle";
import { canonicalInstance, type IndicatorInstance } from "../persist";

// Inset display for the pane indicators whose templates we own (RSI/ATR/SLOPE):
// the instance is created on candle_pane and paints into a shared band across the
// pane's bottom instead of opening its own sub-pane, so the candles keep the full
// height and the price axis keeps every tick.
//
// This file is pure geometry + domain math up top; the klinecharts-facing parts
// (template factory, draw wrapper, legend helpers) live below it.

/** Pane indicator TYPES that can be inset. Only types whose templates we author:
 *  a klinecharts built-in (MACD/VOL/KDJ) renders through figures bound to the
 *  pane's y-axis, and its template is not readable (no getIndicatorClass). */
export const INSET_CAPABLE: ReadonlySet<string> = new Set(["RSI", "ATR", "SLOPE"]);

/** Precision an inset instance reports. The pane's tick precision is the MIN over
 *  its indicators (klinecharts createRangeImp), so a high value here means the
 *  price axis keeps its own precision. The real precision is read back off the
 *  base template for the legend and the in-band label. */
export const INSET_PRECISION = 8;

export const INSET_BAND_FRACTION = 0.28;
export const INSET_BAND_MIN_PX = 56;
// The band is user-resizable (drag its top edge), so these bound what a drag can
// ask for. The ceiling used to be 0.4 as a taste rule; a drag that refuses at 40%
// reads as broken, so the ceiling is now the point past which the band would stop
// being an inset (it still leaves a fifth of the pane to the candles).
export const INSET_BAND_MIN_FRACTION = 0.08;
export const INSET_BAND_MAX_FRACTION = 0.8;

export function clampBandFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return INSET_BAND_FRACTION;
  return Math.min(INSET_BAND_MAX_FRACTION, Math.max(INSET_BAND_MIN_FRACTION, fraction));
}

// The band height is per CHART, not per module: a grid layout runs several charts
// through this one file, and a module-level number would make every cell resize
// together. Weak so a closed cell's entry goes with its chart.
const bandFractions = new WeakMap<object, number>();

/** This chart's band height as a fraction of the candle pane's main height. */
export function insetBandFraction(chart: object | null | undefined): number {
  return (chart && bandFractions.get(chart)) ?? INSET_BAND_FRACTION;
}

export function setInsetBandFraction(chart: object | null | undefined, fraction: number): void {
  if (chart) bandFractions.set(chart, clampBandFraction(fraction));
}

/** The fraction a drag of `dy` pixels from a band that was `startHeight` tall asks
 *  for. Down (positive dy) shrinks the band, since it is anchored to the pane's
 *  bottom edge and the drag grabs its TOP. */
export function bandFractionFromDrag(
  paneHeight: number,
  startHeight: number,
  dy: number,
): number {
  if (!(paneHeight > 0)) return INSET_BAND_FRACTION;
  return clampBandFraction((startHeight - dy) / paneHeight);
}

export interface InsetRect {
  top: number; // pane-local y of the band's top edge
  height: number;
}

/** The shared band, anchored to the pane's bottom edge. The max-fraction cap is
 *  applied last and always, so a short pane gets a proportionally short band
 *  rather than one taller than its pane. */
export function insetBandRect(
  bounding: { height: number },
  fraction: number = INSET_BAND_FRACTION,
): InsetRect {
  const paneH = Math.max(0, bounding.height);
  const height = Math.max(
    0,
    Math.min(
      Math.max(paneH * fraction, INSET_BAND_MIN_PX),
      paneH * INSET_BAND_MAX_FRACTION,
    ),
  );
  const h = Math.floor(height);
  return { top: paneH - h, height: h };
}

export interface InsetBandBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The band in CHART-ROOT pixels (what the DOM layers over it need): its legend
 *  card, its resize handle. Null when this chart has no visible inset instance, so
 *  the callers render nothing rather than an empty strip. */
export function insetBandBox(chart: Chart): InsetBandBox | null {
  // Any inset instance, visible or not: a hidden one still has a row on the band's
  // card, and that row's eye icon is the only way to bring it back.
  if (!chart.getIndicators({ paneId: "candle_pane" }).some(isInsetInstance)) return null;
  const size = chart.getSize("candle_pane", "main");
  if (!size) return null;
  const rect = insetBandRect({ height: size.height }, insetBandFraction(chart));
  if (rect.height <= 0) return null;
  return {
    top: Math.round(size.top + rect.top),
    left: Math.round(size.left),
    width: Math.round(size.width),
    height: rect.height,
  };
}

export interface InsetSpec {
  /** Fixed value range, or "auto" to fit the visible data. */
  domain: [number, number] | "auto";
  /** Padding as a fraction of the fitted span. Ignored for a fixed domain. */
  pad: number;
}

// Mirrors the { top: 0.08, bottom: 0.08 } y-axis gap the sub-pane path applies,
// so an auto-scaled inset breathes like its pane version does.
const AUTO: InsetSpec = { domain: "auto", pad: 0.08 };

export const INSET_SPECS: Record<string, InsetSpec> = {
  // Fixed, so the overbought/oversold levels sit at a stable height instead of
  // drifting with the data.
  RSI: { domain: [0, 100], pad: 0 },
  ATR: AUTO,
  SLOPE: AUTO,
};

export function insetSpecOf(type: string): InsetSpec {
  return INSET_SPECS[type] ?? AUTO;
}

/** Concrete [lo, hi] for a spec over the values actually on screen. */
export function resolveDomain(
  spec: InsetSpec,
  values: Array<number | undefined | null>,
): [number, number] {
  if (spec.domain !== "auto") return spec.domain;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Nothing finite on screen (warmup bars only): a unit domain keeps the band
  // drawable and every value clamps to its centre.
  if (lo > hi) return [0, 1];
  const pad = (hi - lo) * spec.pad;
  return [lo - pad, hi + pad];
}

/** Band-LOCAL y (0 = band top) for a value. The caller translates the canvas to
 *  the band, so this never needs to know where the band sits in the pane. */
export function valueToBandY(
  value: number,
  domain: [number, number],
  height: number,
): number {
  const [lo, hi] = domain;
  if (!(hi > lo)) return height / 2;
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  return height - t * height;
}

type IndLike = { name: string; calcParams?: unknown[]; figures?: unknown[]; precision?: number; visible?: boolean; extendData?: unknown };

/** True when this live indicator was created in inset mode. Gates on the explicit
 *  marker applyIndicator writes, NOT on an empty figure list: ProximityHeatmap is
 *  a figure-less candle-pane indicator that is not inset. */
export function isInsetInstance(ind: IndLike | Indicator): boolean {
  return (ind.extendData as { inset?: boolean } | undefined)?.inset === true;
}

/** The authored template an inset instance was cloned from, or null for a type we
 *  do not own. */
export function insetBaseTemplate(ind: IndLike | Indicator): Omit<IndicatorTemplate, "name"> | null {
  return BASE_TEMPLATES[indTypeOf(ind) as CustomIndicatorType] ?? null;
}

/** A template's figure list for the given calcParams. Regenerated rather than read
 *  when the template defines regenerateFigures (SLOPE emits one line per length). */
export function figuresOfTemplate(
  base: Omit<IndicatorTemplate, "name"> | null,
  calcParams: unknown[] = [],
): IndicatorFigure[] {
  if (!base) return [];
  const regen = base.regenerateFigures;
  return ((regen ? regen(calcParams) : base.figures) ?? []) as IndicatorFigure[];
}

/** The figure list an inset instance WOULD have. Derived every call from the base
 *  template and the instance's live calcParams: SLOPE regenerates its figures per
 *  length, and a settings-modal edit goes through overrideIndicator without
 *  re-registering the template, so a stored copy would go stale. */
export function insetFiguresOf(ind: IndLike | Indicator): IndicatorFigure[] {
  return figuresOfTemplate(insetBaseTemplate(ind), ind.calcParams ?? []);
}

/** Figure list for legend purposes: an inset instance's own list is empty by
 *  construction, so fall back to what the base template defines. */
export function legendFiguresOf(ind: IndLike | Indicator): IndicatorFigure[] {
  return isInsetInstance(ind) ? insetFiguresOf(ind) : ((ind.figures ?? []) as IndicatorFigure[]);
}

/** Value precision for legend purposes: an inset instance reports INSET_PRECISION
 *  to keep the price axis honest, so read the real one off the base template. */
export function legendPrecisionOf(ind: IndLike | Indicator): number | undefined {
  return isInsetInstance(ind) ? insetBaseTemplate(ind)?.precision : ind.precision;
}

/** Visible inset instance names, in pane order. Derived per frame rather than
 *  stored, so it cannot drift from what is actually on the pane. Used to pick the
 *  one instance that paints the band chrome and to stack the in-band labels. */
export function insetOrder(chart: Chart): string[] {
  return chart
    .getIndicators({ paneId: "candle_pane" })
    .filter((ind) => isInsetInstance(ind) && ind.visible !== false)
    .map((ind) => ind.name);
}

/** Persisted-list edit for the toggle. Writes `inset: true` or removes the key,
 *  never `false`, so a non-inset payload stays byte-identical to what earlier
 *  builds saved. canonicalInstance owns that rule (key order included) for every
 *  path that rebuilds an instance for persistence. */
export function withInset(
  list: IndicatorInstance[],
  id: string,
  on: boolean,
): IndicatorInstance[] {
  return list.map((inst) =>
    inst.id === id ? canonicalInstance({ ...inst, inset: on }) : inst,
  );
}

/** The registerable template for an inset instance of `type`: the authored base
 *  with its figures emptied, its figure regeneration disabled, its precision
 *  neutralised and its draw replaced. Null for a type we do not own. */
export function insetTemplate(type: string): Omit<IndicatorTemplate, "name"> | null {
  const base = BASE_TEMPLATES[type as CustomIndicatorType];
  if (!base || !INSET_CAPABLE.has(type)) return null;
  return {
    ...base,
    figures: [],
    // klinecharts calls this on every calcParams change and would refill `figures`,
    // putting the values straight back into the price axis's range math.
    regenerateFigures: null,
    // klinecharts folds these into the PANE's range independently of the figure
    // list, so an inherited min/max would clamp the price axis even with no figures.
    minValue: null,
    maxValue: null,
    precision: INSET_PRECISION,
    draw: drawInset(type),
  } as Omit<IndicatorTemplate, "name">;
}

// Band chrome: a faint ground plus a hairline lid, so the region reads as a band
// rather than as curves floating over the candles.
const BAND_FILL_ALPHA = 0.06;
const BAND_EDGE_ALPHA = 0.22;
// The band sits ON TOP of the candles, so its curves are drawn slightly
// translucent. This SCALES whatever alpha the stored color carries rather than
// replacing it: the Style tab's color picker writes hex + opacity as an rgba()
// string, and overwriting that alpha made a line the user set to 40% render at 90%
// in the band while staying 40% in its own sub-pane, so toggling inset visibly
// changed the opacity the user had chosen.
const LINE_ALPHA = 0.9;
const BAND_DEFAULT_COLOR = "#888888";

function paintBandChrome(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = `rgba(128,128,128,${BAND_FILL_ALPHA})`;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = `rgba(128,128,128,${BAND_EDGE_ALPHA})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0.5);
  ctx.lineTo(width, 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Every value on screen for the base template's line figures — what an "auto"
 *  domain fits to. SLOPE's title-less thHi/thLo figures are ordinary line figures,
 *  so the threshold widens the domain here exactly as it widens the sub-pane's
 *  y-axis. */
function visibleValues(
  result: Array<Record<string, unknown>>,
  figures: IndicatorFigure[],
  from: number,
  to: number,
): Array<number | undefined | null> {
  const keys = figures.filter((f) => f.type === "line").map((f) => f.key);
  const out: Array<number | undefined | null> = [];
  for (let i = Math.max(0, from); i < Math.min(to, result.length); i++) {
    const row = result[i];
    if (!row) continue;
    for (const k of keys) out.push(row[k] as number | undefined);
  }
  return out;
}

// A base draw that throws throws EVERY frame, so an unguarded console.error floods
// the console at frame rate. Log each instance's first failure (with its stack) and
// stay quiet for that instance afterwards.
const loggedDrawErrors = new Set<string>();
function logInsetDrawError(name: string, e: unknown): void {
  if (loggedDrawErrors.has(name)) return;
  loggedDrawErrors.add(name);
  console.error("drawInset", name, e);
}

/** The inset draw for `type`: relocate the sub-pane's frame into the band, let the
 *  base template's own draw paint through a substituted y-conversion, then stroke
 *  the figure lines klinecharts is no longer drawing. Returns true (isCover). */
export function drawInset(
  type: string,
  base: Omit<IndicatorTemplate, "name"> | null = BASE_TEMPLATES[type as CustomIndicatorType] ?? null,
): NonNullable<IndicatorTemplate["draw"]> {
  const spec = insetSpecOf(type);
  return (params) => {
    // klinecharts types xAxis/yAxis as full Axis objects and result as D[]; this
    // wrapper only touches convertToPixel and reads rows as plain records, so it
    // restates the params under the narrow shape it actually uses.
    const p = params as unknown as {
      ctx: CanvasRenderingContext2D;
      chart: Chart;
      indicator: Indicator & { result?: Array<Record<string, unknown>> };
      xAxis: { convertToPixel: (v: number) => number };
      yAxis: unknown;
      bounding: { width: number; height: number; left: number; right: number; top: number; bottom: number };
    };
    const { ctx, chart, indicator, xAxis, bounding } = p;
    // The user's own band height for THIS chart (drag on the band's top edge),
    // falling back to the default fraction on a chart that was never resized.
    const rect = insetBandRect(bounding, insetBandFraction(chart));
    if (rect.height <= 0) return true;

    const result = indicator.result ?? [];
    // From the base this wrapper was built with, so an injected test base and the
    // real template take the same path.
    const figures = figuresOfTemplate(base, indicator.calcParams ?? []);
    const { from, to } = chart.getVisibleRange();
    const domain = resolveDomain(spec, visibleValues(result, figures, from, to));
    const toY = (v: number) => valueToBandY(v, domain, rect.height);

    ctx.save();
    try {
      ctx.translate(0, rect.top);
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, rect.height);
      ctx.clip();

      // One instance paints the band chrome for the whole frame: the first one in
      // pane order, so the ground and lid are drawn once and every curve lands on
      // top of them.
      if (insetOrder(chart)[0] === indicator.name) paintBandChrome(ctx, bounding.width, rect.height);

      // The base draw was written against yAxis.convertToPixel and bounding.height
      // in its own pane. Both are substituted here, and the canvas is already
      // translated, so it paints inside the band without knowing it moved.
      //
      // ONLY this call is guarded: a base template is foreign code, but a throw out
      // of our own painting below is a bug we want to see, not swallow frame after
      // frame into a silently blank band.
      let covered: boolean;
      try {
        covered =
          base?.draw?.({
            ...p,
            yAxis: { ...(p.yAxis as object), convertToPixel: toY },
            bounding: { ...bounding, height: rect.height, top: 0, bottom: rect.height },
            // `never` rather than a structural cast: the substituted yAxis is a stub
            // of klinecharts' YAxis carrying only the one method every base draw calls.
          } as never) === true;
      } catch (e) {
        // Skip the rest of this instance's paint rather than layering our lines over
        // whatever half-drawn state the base left. The finally still restores the
        // canvas, so the next indicator on this pane starts from a clean frame.
        logInsetDrawError(indicator.name, e);
        return true;
      }

      // klinecharts runs its own figure loop only when draw() returned false — the
      // `if (!isCover)` in index.esm.js — and this wrapper stands in for that loop,
      // so it honors isCover identically. SLOPE's draw returns true because it has
      // already painted every line itself (slope0 colored by direction, thHi/thLo
      // dashed); stroking them again here would overpaint it with flat colors.
      if (!covered) paintInsetLines(ctx, indicator, figures, result, from, to, xAxis, toY);
    } finally {
      ctx.restore();
    }
    return true;
  };
}

/** Stroke the base template's line figures. Stands in for the figure loop that
 *  klinecharts skips because this wrapper returns isCover, so it is called ONLY
 *  when the base draw did not itself return isCover — a base that did has already
 *  painted those lines its own way. */
function paintInsetLines(
  ctx: CanvasRenderingContext2D,
  indicator: Indicator,
  figures: IndicatorFigure[],
  result: Array<Record<string, unknown>>,
  from: number,
  to: number,
  xAxis: { convertToPixel: (v: number) => number },
  toY: (v: number) => number,
): void {
  let lineIdx = 0;
  ctx.save();
  for (const fig of figures) {
    if (fig.type !== "line") continue;
    // ONE read of the per-line style entry per figure, taken before the index
    // advances — width, dash and color all describe the SAME line. The Style tab
    // writes {color,size,style,dashedValue} here; each falls back to what this
    // band drew before the tab offered the controls (1px, solid, grey).
    const ls = indicator.styles?.lines?.[lineIdx];
    lineIdx++;
    ctx.lineWidth = ls?.size ?? 1;
    // klinecharts has no "dotted" LineType: the picker stores dotted as a dashed
    // line with a short on/long off dashedValue (lineStyle.toKLineStyle), so both
    // dash flavours ride in on dashedValue and need no branch of their own. Set
    // unconditionally so a solid figure can't inherit the previous one's pattern.
    ctx.setLineDash(ls?.style === 'dashed' ? (ls.dashedValue ?? DASH_DASHED) : []);
    const { hex, alpha } = rgbaToHexAlpha(ls?.color ?? BAND_DEFAULT_COLOR, BAND_DEFAULT_COLOR);
    ctx.strokeStyle = hexToRgba(hex, alpha * LINE_ALPHA);
    ctx.beginPath();
    let open = false;
    for (let i = Math.max(0, from); i < Math.min(to, result.length); i++) {
      const v = result[i]?.[fig.key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        open = false;
        continue;
      }
      const x = xAxis.convertToPixel(i);
      const y = toY(v);
      if (open) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      open = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}
