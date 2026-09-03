// Slope-state coloring for the moving-average family (EMA/MA/VWAP/AVWAP):
// classify the plotted main line per bar as rising / falling / flat and let a
// custom draw stroke each segment in that state's style. Config lives in
// extendData.slopeColor per instance; absent/disabled changes nothing.
//
// Slope is %/bar over a lookback of N bars (the spec's portable definition —
// NOT lib/indicators/slope.ts's %/hr vocabulary):
//   slope[i] = (v[i] − v[i−N]) / |v[i−N]| / N × 100
// Warm-up (i < N), missing values, and a zero denominator yield undefined —
// drawn with the flat/base look.
// `import type` (not `import { type ... }`): the inline form survives bundling
// as a side-effect `import "klinecharts"`, which touches `window` at module
// load; this form is erased outright, so this module stays node-safe (see
// slope.ts's identical note re: parity fixture generation on Node).
import type { IndicatorDrawParams } from "klinecharts";
import { UP, DOWN } from "../chartTheme";

export type SlopeState = -1 | 0 | 1; // falling | flat | rising

export interface SlopeStateStyle {
  color: string; // hex or rgba
  size?: number; // px; absent → main line's resolved width
  style?: "solid" | "dashed" | "dotted"; // absent → solid
}

export interface SlopeColorConfig {
  enabled: boolean;
  len: number; // lookback N, min 1
  flatBandPct: number; // ± flat band in %/bar, min 0
  up: SlopeStateStyle;
  down: SlopeStateStyle;
  flat: SlopeStateStyle;
}

const FLAT_DEFAULT = "#9598A1"; // matches slope.ts's ZERO_LINE neutral grey

export function defaultSlopeColor(): SlopeColorConfig {
  return {
    enabled: false,
    len: 1,
    flatBandPct: 0.1,
    up: { color: UP },
    down: { color: DOWN },
    flat: { color: FLAT_DEFAULT },
  };
}

export function slopeStates(
  values: Array<number | undefined>,
  len: number,
  flatBandPct: number,
): Array<SlopeState | undefined> {
  const n = Math.max(1, Math.floor(len));
  return values.map((v, i) => {
    const prev = values[i - n];
    if (i < n || v == null || prev == null || prev === 0) return undefined;
    const slope = ((v - prev) / Math.abs(prev) / n) * 100;
    if (Math.abs(slope) <= flatBandPct) return 0;
    return slope > 0 ? 1 : -1;
  });
}

export interface SegmentRun {
  state: SlopeState;
  from: number;
  to: number;
}

/** Batch index segments [i-1, i] (for i in (from, to)) into runs of equal
 *  state, each segment styled by its NEWER endpoint's state; undefined
 *  (warm-up) renders as flat. `from`/`to` follow chart.getVisibleRange(). */
export function segmentRuns(
  states: Array<SlopeState | undefined>,
  from: number,
  to: number,
): SegmentRun[] {
  const runs: SegmentRun[] = [];
  for (let i = Math.max(from, 1); i < to && i < states.length; i++) {
    const s: SlopeState = states[i] ?? 0;
    const last = runs[runs.length - 1];
    if (last && last.state === s && last.to === i - 1) last.to = i;
    else runs.push({ state: s, from: i - 1, to: i });
  }
  return runs;
}

const DASH: Record<NonNullable<SlopeStateStyle["style"]>, number[]> = {
  solid: [],
  dashed: [4, 4],
  dotted: [1, 3],
};

/** Custom draw for slope-colored MAs. mainKey is the slope-colored figure
 *  ("ma" for EMA/MA, "vwap" for VWAP/AVWAP). Disabled → return false: the
 *  default figure rendering runs untouched, at zero cost. Enabled → return
 *  true (suppresses ALL default figure lines — proven contract, see
 *  slope.ts's drawSlope) and paint: every OTHER figure line in its normal
 *  resolved style (smoothing / envelope / bands), then the main line per
 *  state-run. Uses only xAxis/yAxis.convertToPixel + bounding-derived values
 *  (never chart.convertToPixel), so the inset wrapper's axis substitution
 *  (inset.ts) keeps working when this indicator lives in the inset band. */
export function makeSlopeColorDraw(mainKey: string) {
  return (
    params: IndicatorDrawParams<Record<string, unknown>, unknown, unknown>,
  ): boolean => {
    const { ctx, chart, indicator, xAxis, yAxis } = params;
    const ext = (indicator.extendData ?? {}) as { slopeColor?: SlopeColorConfig };
    const sc = ext.slopeColor;
    if (!sc?.enabled) return false;

    const result = (indicator.result ?? []) as Array<
      Record<string, unknown> & { slopeState?: SlopeState }
    >;
    const { from, to } = chart.getVisibleRange();
    const overrides = indicator.styles?.lines ?? [];
    const defaults = chart.getStyles().indicator?.lines ?? [];
    const figures = (indicator.figures ?? []) as Array<{ key: string }>;
    const mainIdx = Math.max(
      0,
      figures.findIndex((f) => f.key === mainKey),
    );
    const resolvedMainSize = overrides[mainIdx]?.size ?? defaults[mainIdx]?.size ?? 1;

    ctx.save();

    // 1. Non-main figure lines, normal styles (smoothing / envelope / bands).
    figures.forEach((f, fi) => {
      if (f.key === mainKey) return;
      const color = overrides[fi]?.color ?? defaults[fi]?.color;
      if (!color) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = overrides[fi]?.size ?? defaults[fi]?.size ?? 1;
      // klinecharts' own LineType is only "dashed" | "solid" (no "dotted") —
      // that vocabulary belongs to slopeColor's OWN SlopeStateStyle, painted
      // separately below for the main line.
      const st = overrides[fi]?.style ?? defaults[fi]?.style;
      const dv = overrides[fi]?.dashedValue ?? defaults[fi]?.dashedValue ?? [4, 4];
      ctx.setLineDash(st === "dashed" ? dv : []);
      let started = false;
      ctx.beginPath();
      for (let i = Math.max(from, 0); i < to && i < result.length; i++) {
        const v = result[i]?.[f.key];
        if (typeof v !== "number") {
          started = false;
          continue;
        }
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(v);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // 2. Main line, per-state runs.
    const styleOf = (s: SlopeState): SlopeStateStyle =>
      s === 1 ? sc.up : s === -1 ? sc.down : sc.flat;
    const states = result.map((p) => p?.slopeState);
    for (const run of segmentRuns(states, from, to)) {
      const st = styleOf(run.state);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.size ?? resolvedMainSize;
      ctx.setLineDash(DASH[st.style ?? "solid"]);
      let started = false;
      ctx.beginPath();
      for (let i = run.from; i <= run.to; i++) {
        const v = result[i]?.[mainKey];
        if (typeof v !== "number") {
          started = false;
          continue;
        }
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(v);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    return true;
  };
}
