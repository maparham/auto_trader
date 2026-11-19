// Alerts on an indicator as a whole (a divergence or candle-pattern event,
// Trendlines' nearest line: IndicatorAlert.whole) have no curve or level to
// put a bell on, so the legend row of the indicator they follow carries it.
// Only alerts linked to this cell, and only while the indicator alerts on the
// chart's timeframe here (its pin's, when pinned), as the curve bells do.
import type { Chart } from "klinecharts";
import type { IndicatorAlert } from "../lib/alertsApi";
import { alertTimeframeOf } from "../lib/indicatorAlertInstance";
import { getIndicatorById } from "../lib/indicators";

// `firedAt` marks a fired "once" alert still in History (a gray bell).
export type LegendAlertBell = { id: string; label: string; firedAt?: number };

/** Indicator name to the whole-indicator alerts its legend row shows. */
export function wholeAlertBells(
  chart: Chart,
  alerts: ReadonlyArray<IndicatorAlert & { firedAt?: number }>,
  scope: string,
  resolution: string,
): Map<string, LegendAlertBell[]> {
  const out = new Map<string, LegendAlertBell[]>();
  for (const a of alerts) {
    const link = a.params.link;
    if (!a.whole || !link || link.scope !== scope) continue;
    const ind = getIndicatorById(chart, link.instanceId);
    if (!ind) continue;
    const ext = ind.extendData as Record<string, unknown> | undefined;
    if (a.params.timeframe !== alertTimeframeOf(ext, resolution)) continue;
    const list = out.get(link.instanceId) ?? [];
    list.push({ id: a.id, label: a.label ?? a.params.output, ...(a.firedAt != null ? { firedAt: a.firedAt } : {}) });
    out.set(link.instanceId, list);
  }
  return out;
}

/** A stable signature of a bell map, so a caller can keep the old map (and
 * skip a render) when an alerts bump changed nothing the legend shows. */
export function bellsSig(bells: ReadonlyMap<string, LegendAlertBell[]>): string {
  return [...bells]
    .map(([name, list]) => `${name}:${list.map((b) => `${b.id}=${b.label}=${b.firedAt ?? ""}`).join(",")}`)
    .join("|");
}
