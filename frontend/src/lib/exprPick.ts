// "Pick from chart": turn ONE clicked on-chart indicator into the expression
// token a rule row should receive. The mapping itself is chartIndicatorToExprToken
// (pure); this module is the chart-side normalisation in front of it.
//
// The one thing that needs normalising is the Slope pane's ACCELERATION
// companion. It is a separate klinecharts instance — type "SLOPE_ACCEL", id
// "<parent>__accel", config copied from its parent — but the expression language
// has no such instance: acceleration is an OUTPUT of the parent ("SLOPE.accel0").
// So a click there is rewritten to the PARENT (its id, its live settings, which
// are the source of truth the copy is derived from) with output "accel". Without
// this the whole acceleration path is unreachable from the UI even though every
// layer beneath it supports it.
import type { Chart, Indicator } from "klinecharts";
import { chartIndicatorToExprToken } from "./exprChartToken";
import { ACCEL_SUFFIX, getIndicatorById } from "./indicators";
import { indTypeOf } from "./customIndicators";

/** A click published on `indicatorPickResult`: the instance, plus which of its
 * lines was hit when the click landed on a curve (absent for a legend-row
 * click, which names no line — line 0 is the sensible default there). */
export interface PickedIndicator {
  paneId: string;
  name: string;
  lineIndex?: number;
}

export function pickedIndicatorToken(chart: Chart, sel: PickedIndicator): string | null {
  const isAccel = sel.name.endsWith(ACCEL_SUFFIX);
  // The instance a rule would name: the parent for an accel companion click.
  const instanceId = isAccel ? sel.name.slice(0, -ACCEL_SUFFIX.length) : sel.name;
  const src: Indicator | null = getIndicatorById(chart, instanceId);
  if (!src) return null; // removed mid-pick, or an orphaned companion
  return chartIndicatorToExprToken(
    // The companion's own type ("SLOPE_ACCEL") is not a type the bridge answers
    // to; the parent's is.
    isAccel ? "SLOPE" : indTypeOf(src),
    (src.calcParams ?? []).map(Number),
    src.extendData,
    { instanceId, lineIndex: sel.lineIndex, output: isAccel ? "accel" : "slope" },
  );
}
