import type {
  Chart,
  AxisCreateRangeParams,
  AxisCreateRangeCallback,
  AxisRange,
} from "klinecharts";

// "Scale price chart only": fit the candle pane's y-axis to the visible candle
// highs/lows alone, ignoring indicator curves that would otherwise inflate the
// range. v9 shipped this as a patched YAxisImp.calcRange; v10 exposes it as a
// supported `createRange` override, so no patch is needed.
//
// Two facts about v10's createRangeImp (dist/index.esm.js) drive this file:
//
//   1. The `defaultRange` handed to us is the RAW min/max of everything on the
//      pane (candles + indicator figures), with NO gap applied. The framework
//      applies the pane's gap (candle default { top: 0.2, bottom: 0.1 }) AFTER
//      our callback returns. So we must return raw extremes, never pre-gapped,
//      or the gap is applied twice and the viewport jumps when the flag toggles.
//
//   2. Only `realFrom` / `realTo` from our return are load-bearing. The
//      framework recomputes `realRange`, then `from` / `to` / `displayFrom` /
//      `displayTo` from realFrom/realTo via the axis's realValueToValue /
//      realValueToDisplayValue. minSpan expansion and "nice" tick rounding also
//      happen downstream (createTicksImp), so returning raw realFrom/realTo
//      bypasses nothing load-bearing. We still fill the other fields to satisfy
//      the AxisRange type.
//
// The realFrom/realTo must be in the axis's REAL space. On a normal axis that
// is linear price; on a logarithmic axis it is log10(price). The log transform
// normally lives inside the log axis template's own createRange, which our
// override replaces, so we re-derive it by delegating to the axis's public
// `valueToRealValue` (identity for normal, log10 for log). This keeps both the
// price-only-ON and price-only-OFF states correct on either axis type and
// avoids reimplementing (and drifting from) klinecharts' log math.

const CANDLE_PANE_ID = "candle_pane";

/**
 * Shared candle-pane range builder.
 * @param priceOnly when true, fit to visible candle highs/lows only; when false,
 *   reproduce the axis's native full-range fit (candles + indicators).
 */
function candleCreateRange(
  { chart, paneId, defaultRange }: AxisCreateRangeParams,
  priceOnly: boolean,
): AxisRange {
  // Linear price extremes we want the axis to span. Default to the full range
  // the framework already computed (correct for the price-only-OFF state).
  let lo = defaultRange.from;
  let hi = defaultRange.to;

  if (priceOnly) {
    const data = chart.getDataList();
    const { from, to } = chart.getVisibleRange();
    let min = Number.MAX_SAFE_INTEGER;
    let max = Number.MIN_SAFE_INTEGER;
    for (let i = Math.max(0, from); i < Math.min(to, data.length); i++) {
      const bar = data[i];
      if (!bar) continue;
      min = Math.min(min, bar.low);
      max = Math.max(max, bar.high);
    }
    // No visible candles (e.g. before the first data load): defer to the
    // framework's default so the axis still has a sane range.
    if (min > max) return defaultRange;
    lo = min;
    hi = max;
  }

  // Delegate the value -> real-value transform to the live axis so we match its
  // type (linear or log). If the axis is unavailable (e.g. in unit tests), fall
  // back to identity, which is correct for a normal axis.
  const axis = chart.getYAxes?.({ paneId: paneId ?? CANDLE_PANE_ID })?.[0];
  const toReal = axis?.valueToRealValue;
  const realFrom = toReal ? toReal(lo, { range: defaultRange }) : lo;
  const realTo = toReal ? toReal(hi, { range: defaultRange }) : hi;

  return {
    from: lo,
    to: hi,
    range: hi - lo,
    realFrom,
    realTo,
    realRange: realTo - realFrom,
    displayFrom: lo,
    displayTo: hi,
    displayRange: hi - lo,
  };
}

/** Candle-pane y-range from visible candle highs/lows only (ignores indicator curves). */
export function priceOnlyCreateRange(params: AxisCreateRangeParams): AxisRange {
  return candleCreateRange(params, true);
}

/**
 * Axis-aware "off" range: the framework's default full-pane fit, but routed
 * through the axis transform so it stays correct on a log axis. A plain
 * `(p) => p.defaultRange` passthrough would feed linear values to a log axis
 * and render garbage, so we must reproduce the native fit ourselves.
 */
const defaultCreateRange: AxisCreateRangeCallback = (params) =>
  candleCreateRange(params, false);

/** Install or remove the candle-pane price-only override depending on the flag. */
export function applyScalePriceOnly(chart: Chart, enabled: boolean): void {
  // No `name`: this merges createRange onto the existing axis, preserving its
  // kind (normal/logarithm) set by the log toggle, and re-fits (overrideYAxis
  // resets the auto-calc flag). A log toggle recreates the axis and drops this
  // override, so ChartCore re-applies on logScale change.
  //
  // overrideYAxis triggers a synchronous repaint that can throw from deep in
  // klinecharts (x-axis tick formatting on a NaN scroll offset, a latent bug
  // unrelated to this feature; same throw the invert-scale effect guards). We
  // contain it here so a throw can't kill the caller: the init seed runs before
  // setChartReady, so an escaping throw there would leave the cell dead.
  try {
    chart.overrideYAxis({
      paneId: CANDLE_PANE_ID,
      createRange: enabled ? priceOnlyCreateRange : defaultCreateRange,
    });
  } catch (e) {
    console.error("applyScalePriceOnly", e);
  }
}
