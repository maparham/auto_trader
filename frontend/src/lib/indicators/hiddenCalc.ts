// One gate, applied where indicator templates are REGISTERED: an indicator that
// is not on screen does not compute.
//
// klinecharts re-runs calc for every registered indicator on every tick, over the
// whole loaded series, and its own `visible` flag gates only the DRAW pass -- a
// hidden detector (Trendlines, SR Levels, FVG, candle patterns) therefore kept
// costing full price for nothing. The flag covers both hide routes: the legend
// eye and a visibility model that excludes the current resolution.
//
// A hidden instance is genuinely idle -- nothing recomputes in the background --
// so the first calc after an unhide is a full one, even for the types that keep a
// per-instance session cache.
//
// Unhiding needs no trigger of its own. klinecharts deep-clones _prevIndicator on
// every override(), so `prev.figures !== current.figures` always holds and the
// default shouldUpdate asks for a calc on ANY overrideIndicator call -- the write
// that flips `visible` back on IS the recalc. What a hidden instance cannot get
// back by itself is its HTF stash and its Trendlines compute floor, which is what
// refreshMtfOnVisibilityChange (lib/mtfCoordinator.ts) is for.
import type { Indicator, IndicatorTemplate, KLineData } from "klinecharts";

type AnyTemplate = Omit<IndicatorTemplate, "name">;

/** Wrap a template's calc so a hidden instance returns its PRIOR rows untouched.
 *
 * Prior rows rather than []: calcImp assigns whatever calc returns to
 * `indicator.result`, so returning the same array changes nothing at all, where
 * [] would actively wipe an indicator that is merely out of sight (the agent
 * bridge's chart.state reads .result, and so does the legend readout). The rows
 * stop growing while hidden, and a symbol or timeframe switch leaves them
 * describing a series the chart no longer shows -- which is why both of those
 * readers report nothing for a hidden instance rather than its frozen rows. */
export function hiddenAware<T extends AnyTemplate>(tmpl: T): T {
  const calc = tmpl.calc;
  if (typeof calc !== "function") return tmpl;
  return {
    ...tmpl,
    calc: (dataList: KLineData[], ind: Indicator) =>
      ind.visible === false ? ind.result : calc(dataList, ind),
  } as T;
}
