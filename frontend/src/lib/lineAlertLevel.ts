// A line alert's level at the chart's newest bar, when the chart shows the
// alert's own timeframe (bars there are the alert's bars, so the slope is
// per chart bar). The reference bar first, then the anchors if the chart
// has not loaded that far back.
import type { LineAlertParams } from "./alertsApi";

export function lineLevelNow(
  p: Pick<LineAlertParams, "tRef" | "pRef" | "slope" | "anchors">,
  times: readonly number[],
): number | null {
  const last = times.length - 1;
  for (const [t, price] of [
    [p.tRef, p.pRef],
    [p.anchors.t2, p.anchors.p2],
    [p.anchors.t1, p.anchors.p1],
  ]) {
    const j = times.lastIndexOf(t);
    if (j >= 0) return price + p.slope * (last - j);
  }
  return null;
}
