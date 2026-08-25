// "Pick from chart": turn ONE clicked on-chart indicator into the expression
// token a rule row should receive. The mapping itself is chartIndicatorToExprToken
// (pure); this module is the chart-side normalisation in front of it.
//
// The two things that need normalising are the Slope pane's ACCELERATION
// companion and the Pivot Bands pane's BARS-SINCE companion. It is a separate klinecharts instance — type "SLOPE_ACCEL", id
// "<parent>__accel", config copied from its parent — but the expression language
// has no such instance: acceleration is an OUTPUT of the parent ("SLOPE.accel9").
// So a click there is rewritten to the PARENT (its id, its live settings, which
// are the source of truth the copy is derived from) with output "accel". Without
// this the whole acceleration path is unreachable from the UI even though every
// layer beneath it supports it.
import type { Chart, Indicator } from "klinecharts";
import { chartIndicatorToExprToken } from "./exprChartToken";
import { ACCEL_SUFFIX, BARS_SINCE_SUFFIX, getIndicatorById } from "./indicators";
import { indTypeOf } from "./customIndicators";

/** A click published on `indicatorPickResult`: the instance, plus which of its
 * lines was hit when the click landed on a curve (absent for a legend-row
 * click, which names no line — line 0 is the sensible default there). */
export interface PickedIndicator {
  paneId: string;
  name: string;
  lineIndex?: number;
  /** The legend figure the click landed on (e.g. ATR's "atrPct" readout);
   * absent for curve hits and plain row clicks. */
  figureKey?: string;
}

export function pickedIndicatorToken(chart: Chart, sel: PickedIndicator): string | null {
  // Pivot Bands' bars-since companion is the same story as accel: a separate
  // instance ("<parent>__barsSince") whose curves are OUTPUTS of the parent
  // ("PIVOT_BANDS.barsSinceHigh"). It is an internal pane, so it has no DOM
  // legend card and a click can only ever be a CURVE hit — lineIndex is the only
  // signal, and it is fed to the parent's mapping as the figure key.
  const barsSince = sel.name.endsWith(BARS_SINCE_SUFFIX);
  if (barsSince) {
    const parentId = sel.name.slice(0, -BARS_SINCE_SUFFIX.length);
    const parent = getIndicatorById(chart, parentId);
    if (!parent) return null; // removed mid-pick, or an orphaned companion
    return chartIndicatorToExprToken(
      "PIVOT_BANDS",
      (parent.calcParams ?? []).map(Number),
      parent.extendData,
      {
        instanceId: parentId,
        figureKey: sel.figureKey ?? (sel.lineIndex === 1 ? "barsSinceLow" : "barsSinceHigh"),
      },
    );
  }
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
    { instanceId, lineIndex: sel.lineIndex, output: isAccel ? "accel" : "slope", figureKey: sel.figureKey },
  );
}
