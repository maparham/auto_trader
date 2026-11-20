// "Follow chart's L button" for Trendlines: a pane with extendData.logFollow
// has its Log Scale (calcParams slot 33) set by the chart's L toggle. Opt-in
// per pane, because Log Scale changes the lines rules and alerts read, so one
// toolbar click must never move a pane that did not ask for it.
//
// The calc never reads logFollow: slot 33 stays the one value the backend
// sees, written here through the Settings form's own path (applyDebugChanges).
// Synced on an L toggle and when a pane starts following, never on a timer,
// so two cells sharing one saved config cannot fight over it.
import type { Chart } from "klinecharts";
import { indTypeOf } from "../lib/customIndicators";
import { parseTrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import type { TrendlinesExtend } from "../lib/indicators/trendlines";
import { applyDebugChanges } from "./useTrendlineDebug";

/** Per chart: reads its L toggle. Registered by ChartCore. */
const LOG_SOURCE = new WeakMap<object, () => boolean>();

export function setChartLogSource(chart: object, read: () => boolean): void {
  LOG_SOURCE.set(chart, read);
}

/** The chart's L toggle; off for a chart that registered none. */
export function chartLogOn(chart: object): boolean {
  return LOG_SOURCE.get(chart)?.() ?? false;
}

export function followsChartLog(ext: unknown): boolean {
  return (ext as TrendlinesExtend | undefined)?.logFollow === true;
}

export interface LogFollowBase {
  scope: string;
  epic: string;
  brokerId: string;
}

/** Set Log Scale on every following Trendlines pane of `chart` (or only
 * `only`) to the chart's L state. Panes already in line are left alone. */
export function syncLogFollow(chart: Chart, base: LogFollowBase, only?: { paneId: string; name: string }): void {
  const on = chartLogOn(chart);
  for (const ind of chart.getIndicators()) {
    if (only && (ind.paneId !== only.paneId || ind.name !== only.name)) continue;
    if (indTypeOf({ name: ind.name, extendData: ind.extendData }) !== "TRENDLINES") continue;
    if (!followsChartLog(ind.extendData)) continue;
    const cur = parseTrendlinesConfig(ind.calcParams, ind.extendData).logScale === 1;
    if (cur === on) continue;
    applyDebugChanges(
      { chart, ...base, paneId: ind.paneId, name: ind.name },
      [{ field: "logScale", from: cur ? 1 : 0, to: on ? 1 : 0, pool: false }],
    );
  }
}
