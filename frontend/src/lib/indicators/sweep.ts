// Sweep (stop hunt): flags candles that trade through a pivot or
// previous-day level and close back on the near side. The math lives in
// ./sweepCompute (node-safe, Python-mirrored); this module only registers
// the template and draws: a tinted box over each flagged candle, a dashed
// segment along the swept level, a solid border on previous-candle reversals,
// a tick once the sweep confirms, and a small
// score chip when bars are wide enough to read it.
import {
  type Indicator,
  type IndicatorDrawParams,
  type IndicatorTemplate,
  type KLineData,
} from "klinecharts";
import { DRAW_CLIP_PAD, clipSegmentToRect } from "./shared";
import { computeSweep, type SweepPoint } from "./sweepCompute";
import { parseSweepConfig } from "./sweepOutputs";

export interface SweepExtend {
  hideLegendValue?: boolean;
  // Off-switch for the "72 pivot" chips over flagged candles. Absent means shown.
  showLabels?: boolean;
  usePrevDay?: boolean;
  useVolume?: boolean;
  usePrevBar?: boolean;
  reversalsOnly?: boolean;
  tz?: string;
}

// Only the price-scaled output is a figure: klinecharts autoscales the
// candle pane over every overlay figure, so 0/1 events or bar counts there
// would crush the price axis (SPIKE's rule). The draw callback paints the
// boxes and returns true, so this figure feeds the legend only.
const SWEEP_FIGURES = [{ key: "sweptLevel", title: "Swept: ", type: "line" }];

const BEAR = "#EF5350";
const BULL = "#26A69A";

function hexWithAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** Whether the sweep flagged at bar `i` confirmed on bar `i + confirmBars`.
 * The side check alone is exact and does NOT need `barsSince === confirmBars`:
 * confirm fires on the first bar that reaches confirmBars after a flag, and
 * any later same-direction OR opposite flag cancels the pending sweep before
 * it can confirm, so a same-side confirm at i + confirmBars can only belong
 * to the sweep flagged at i. Requiring barsSince === confirmBars too drops
 * real confirms when a second sweep happens to flag exactly confirmBars bars
 * later, which resets barsSince to 0 on that very bar. */
export function sweepConfirmedAt(result: SweepPoint[], i: number, confirmBars: number): boolean {
  const bear = result[i]?.bearSweep === 1;
  const bull = result[i]?.bullSweep === 1;
  if (!bear && !bull) return false;
  const c = result[i + confirmBars];
  return !!c && (bear ? c.bearConfirmed === 1 : c.bullConfirmed === 1);
}

function drawSweep(params: IndicatorDrawParams<SweepPoint, unknown, unknown>): boolean {
  const { ctx, chart, indicator, xAxis, yAxis, bounding } = params;
  const result = (indicator.result ?? []) as SweepPoint[];
  if (!result.length) return true;
  const cfg = parseSweepConfig(indicator.calcParams, indicator.extendData);
  const ext = (indicator.extendData ?? {}) as SweepExtend;
  const dataList = chart.getDataList();
  const barPxRaw = xAxis.convertToPixel(1) - xAxis.convertToPixel(0);
  const half = Number.isFinite(barPxRaw) ? Math.abs(barPxRaw) / 2 : 0;
  const labels = ext.showLabels !== false && half * 2 >= 5;
  // A flag past the right edge can still own a level segment that crosses
  // the pane, so the loop reaches one level lifetime past the visible range.
  const vr = chart.getVisibleRange();
  const lo = Math.max(0, vr.from - 1);
  const hi = Math.min(result.length, vr.to + 1 + cfg.levelMaxAge + cfg.pivotRight);
  const xMin = -DRAW_CLIP_PAD;
  const xMax = bounding.width + DRAW_CLIP_PAD;
  const yMin = -DRAW_CLIP_PAD;
  const yMax = bounding.height + DRAW_CLIP_PAD;

  ctx.save();
  for (let i = lo; i < hi; i++) {
    const p = result[i];
    const bear = p.bearSweep === 1;
    if (!bear && p.bullSweep !== 1) continue;
    const k: KLineData | undefined = dataList[i];
    if (!k || p.sweptLevel === undefined) continue;
    const color = bear ? BEAR : BULL;
    const x = xAxis.convertToPixel(i);
    const yLevel = yAxis.convertToPixel(p.sweptLevel);
    // Level segment, from the level's start bar to the sweep bar.
    const seg = clipSegmentToRect(
      xAxis.convertToPixel(p.levelFrom ?? i), yLevel, x, yLevel, xMin, yMin, xMax, yMax,
    );
    if (seg) {
      ctx.strokeStyle = hexWithAlpha(color, 0.8);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(seg[0], seg[1]);
      ctx.lineTo(seg[2], seg[3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (i > vr.to) continue; // only the segment can reach into the pane
    const yHigh = yAxis.convertToPixel(k.high);
    const yLow = yAxis.convertToPixel(k.low);
    const w = Math.max(3, half * 2);
    ctx.fillStyle = hexWithAlpha(color, 0.12 + 0.18 * ((p.score ?? 0) / 100));
    ctx.fillRect(x - w / 2, yHigh - 2, w, Math.max(1, yLow - yHigh) + 4);
    // A previous-candle reversal gets a solid border, so it reads apart from
    // a swing or previous-day sweep.
    if (bear ? p.bearReversal === 1 : p.bullReversal === 1) {
      ctx.strokeStyle = hexWithAlpha(color, 0.9);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w / 2 + 0.5, yHigh - 1.5, w - 1, Math.max(1, yLow - yHigh) + 3);
    }
    // Confirm tick, on the sweep candle, when THIS sweep confirmed.
    if (sweepConfirmedAt(result, i, cfg.confirmBars)) {
      const yTick = bear ? yHigh - 8 : yLow + 8;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 3, yTick);
      ctx.lineTo(x - 1, yTick + 2);
      ctx.lineTo(x + 3, yTick - 2);
      ctx.stroke();
    }
    if (labels) {
      const label = p.src === "day" ? "prev day" : p.src === "bar" ? "prev bar" : "pivot";
      const text = `${Math.round(p.score ?? 0)} ${label}`;
      ctx.font = "600 10px ui-monospace, Menlo, monospace";
      const tw = ctx.measureText(text).width + 8;
      const yBase = bear ? yHigh - 14 : yLow + 24;
      ctx.fillStyle = hexWithAlpha(color, 0.92);
      ctx.beginPath();
      ctx.roundRect(x - tw / 2, yBase - 11, tw, 14, 3);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, x - tw / 2 + 4, yBase);
    }
  }
  ctx.restore();
  return true; // boxes replace the default figure lines
}

// calcParams = [pivotLeft, pivotRight, levelMaxAge, minWickPct, atrLen,
// minRangeAtr, volLen, volZ, minScore, confirmBars].
export const SWEEP_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Stop Hunt",
  series: "price",
  precision: 2,
  calcParams: [5, 5, 150, 50, 14, 1.5, 20, 2, 70, 3],
  figures: SWEEP_FIGURES,
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeSweep(dataList, parseSweepConfig(ind.calcParams, ind.extendData)),
  draw: (params) => drawSweep(params as IndicatorDrawParams<SweepPoint, unknown, unknown>),
};
