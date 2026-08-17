// How much empty room the candle pane's price axis leaves above and below the
// data ("fit mode"), and the double-click cycle that picks it.
//
// klinecharts turns the y-axis `gap` into extra range: it grows the fitted
// extremes by `range * top` / `range * bottom` (YAxisImp.createRangeImp), so
// the candles occupy 1 / (1 + top + bottom) of the pane height. Its default
// {top: 0.2, bottom: 0.1} spends 23% of the pane on margins — deliberate
// headroom for the last-price tag and overlays, but it can read as a squeezed
// chart when you want the shape of a move.
//
// Gap is the right seam for "fill the pane" because it composes with auto-fit:
// the axis keeps re-fitting as you scroll or new bars arrive, so the candles
// stay filled. A one-shot zoom-to-fill would go stale on the next bar.
//
// A value >= 1 means PIXELS to klinecharts, not a fraction — both modes stay
// well below 1.

const CANDLE_PANE_ID = "candle_pane";

/**
 * Where the price-axis double-click cycle currently sits.
 *
 * `default` and `refit` render identically (klinecharts' own margins); they
 * differ only in what the NEXT double-click does. `default` is the resting
 * state — a fresh chart, or one just reset by the toolbar "A" — where a
 * double-click still means the familiar "re-fit the axis". Having re-fit, the
 * cycle is armed (`refit`), so the next double-click stretches.
 */
export type PriceFitMode = "default" | "refit" | "stretched";

export interface FitGap {
  top: number;
  bottom: number;
}

/** klinecharts' own candle-pane margins — what the default modes must reproduce. */
export const DEFAULT_FIT_GAP: FitGap = { top: 0.2, bottom: 0.1 };

/** Stretched: candles fill ~93% of the pane, leaving a sliver for the price tag. */
export const STRETCHED_FIT_GAP: FitGap = { top: 0.04, bottom: 0.04 };

export function fitGap(mode: PriceFitMode): FitGap {
  return mode === "stretched" ? STRETCHED_FIT_GAP : DEFAULT_FIT_GAP;
}

/**
 * The mode a price-axis double-click should land on.
 *
 * First double-click re-fits to the default margins, the second stretches, and
 * from there they alternate. A manual scale in between (axis drag or wheel,
 * which clears klinecharts' auto-fit flag) restarts that sequence: the next
 * double-click undoes the scaling and re-arms rather than jumping to stretched.
 */
export function nextFitMode({
  autoFitted,
  mode,
}: {
  autoFitted: boolean;
  mode: PriceFitMode;
}): PriceFitMode {
  return autoFitted && mode === "refit" ? "stretched" : "refit";
}

/** The one read this module needs — `Chart` satisfies it; tests pass a stub. */
interface YAxisReadable {
  getYAxes(filter: { paneId: string }): unknown[];
}

/**
 * Whether the candle pane's y-axis is still auto-fitting — i.e. the user has
 * not dragged or wheeled it into a hand-set range.
 *
 * Deliberately klinecharts' own flag rather than the app's `autoScale` signal:
 * autoScale flips off on a PRESS over the axis column (ChartCore's onAxisDown),
 * and a double-click is preceded by two presses, so reading it here would
 * report "manually scaled" on every double-click and the cycle could never
 * leave the default fit. AxisImp clears its flag in setRange, which is the
 * actual scaling. The flag is not on the published YAxis type (it lives on
 * AxisImp), hence the structural read; a build that ever drops it degrades to
 * "auto-fitted", which keeps the cycle working.
 */
export function isAutoFitted(chart: YAxisReadable): boolean {
  const axis = chart.getYAxes({ paneId: CANDLE_PANE_ID })[0] as
    | { getAutoCalcTickFlag?: () => boolean }
    | undefined;
  return axis?.getAutoCalcTickFlag?.() ?? true;
}

/** The one write this module needs — `Chart` satisfies it; tests pass a stub. */
interface YAxisOverridable {
  overrideYAxis(yAxis: { paneId: string; gap: FitGap }): void;
}

/**
 * Push a fit mode onto the live chart, re-fitting the candle pane.
 *
 * One `overrideYAxis` does both halves: it merges the gap onto the existing
 * axis (YAxisImp.override merges rather than replaces, so the price-only
 * `createRange` and the log/normal axis kind survive) and resets the axis
 * auto-calc flag (DrawPane.createOrOverrideYAxis calls setAutoCalcTickFlag(true)
 * unconditionally), which discards any manual y-scale and re-fits. No `name` is
 * passed: a NAME that differs recreates the axis from its template, dropping
 * both the gap and the createRange override.
 *
 * overrideYAxis triggers a synchronous repaint that can throw from deep in
 * klinecharts (x-axis tick formatting on a NaN scroll offset, a latent bug
 * unrelated to fitting) AFTER the override is committed — contained here for
 * the same reason applyScalePriceOnly contains it: a throw must not kill the
 * caller mid-signal.
 */
export function applyCandleFit(chart: YAxisOverridable, mode: PriceFitMode): void {
  try {
    chart.overrideYAxis({ paneId: CANDLE_PANE_ID, gap: fitGap(mode) });
  } catch (e) {
    console.error("applyCandleFit", e);
  }
}
