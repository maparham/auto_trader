// The equity curve: the EQUITY indicator and its per-bar series, plus the
// walk-forward equity and fold-band points.
import { registerIndicator } from "klinecharts";
import type { WfoScheme } from "../../api";

export const EQUITY_INDICATOR = "EQUITY";

/** Map a native-bar equity series onto whatever bars are currently loaded,
 * using equity-at-bar-close semantics so the curve renders correctly on ANY
 * timeframe — not just the native one it was run on.
 *
 * For each displayed bar we carry forward the equity value of the last native
 * point that falls BEFORE the next bar's open — i.e. the equity as of this
 * bar's close. Bars before the first point stay blank; bars after the last
 * point stay blank (so a coarser view never draws a flat line extending to the
 * live edge). On the native timeframe this reproduces the old exact per-bar
 * match; on a coarser timeframe it downsamples to bar-close; on a finer one it
 * steps at native granularity.
 *
 * `bars` and `points` are both ascending by time; `points` are
 * `[timestampMs, value]`. Pure + exported for tests. */
export function equityForBars(
  bars: readonly { timestamp: number }[],
  points: readonly (readonly [number, number])[],
): { equity?: number }[] {
  if (points.length === 0) return bars.map(() => ({}));
  const lastTs = points[points.length - 1][0];
  let pi = 0;
  let carried: number | undefined;
  return bars.map((bar, idx) => {
    const nextTs = idx + 1 < bars.length ? bars[idx + 1].timestamp : Infinity;
    // Consume every native point strictly inside this bar (up to the next bar's
    // open); the last one is this bar's closing equity.
    while (pi < points.length && points[pi][0] < nextTs) {
      carried = points[pi][1];
      pi++;
    }
    if (carried === undefined || bar.timestamp > lastTs) return {};
    return { equity: carried };
  });
}

export function registerBacktestIndicators(): void {
  registerIndicator<{ equity?: number }>({
    name: EQUITY_INDICATOR,
    shortName: "Equity",
    series: 'normal',
    precision: 2,
    figures: [{ key: "equity", title: "Equity: ", type: "line" }],
    // Read THIS instance's equity series off its extendData — never a module
    // global, so each cell's EQUITY pane plots its own backtest (see
    // runAndRender). equityForBars re-anchors the native-bar series onto the
    // currently-loaded bars, so the curve is correct on any timeframe.
    calc: (dataList, indicator) => {
      const points = indicator.extendData as Array<[number, number]> | undefined;
      if (!points) return dataList.map<{ equity?: number }>(() => ({}));
      return equityForBars(dataList, points);
    },
  });
}

/** The stitched equity series as ascending `[timestampMs, value]` pairs, picking
 * the compounded (`equity_scaled`) or summed (`equity`) series per `compounded`.
 * The backend emits `[unixSeconds, equity]`; this carries the ×1000 unit
 * conversion so equityForBars can re-anchor it onto the loaded bars. Pure +
 * exported for tests. */
export function wfoEquityPoints(scheme: WfoScheme, compounded: boolean): Array<[number, number]> {
  const series = compounded ? scheme.stitched.equity_scaled : scheme.stitched.equity;
  return series.map(([s, v]) => [s * 1000, v]);
}

/** The fold shading bands: every SECOND fold's out-of-sample test span, as
 * `{ from, to }` in ms. Alternating (folds 0, 2, 4, …) so adjacent test windows
 * read as distinct tinted stripes rather than one continuous block. Pure +
 * exported for tests. */
export function wfoFoldBandPoints(scheme: WfoScheme): Array<{ from: number; to: number }> {
  const bands: Array<{ from: number; to: number }> = [];
  scheme.folds.forEach((f, i) => {
    if (i % 2 === 0) bands.push({ from: f.test_from * 1000, to: f.test_to * 1000 });
  });
  return bands;
}
