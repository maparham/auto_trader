// Turns a live chart indicator into an alert draft (or the reason it cannot
// have one). Shared by the legend bell and the indicator menu.
import type { Chart } from "klinecharts";
import { checkAlertable, MAIN_LINE_KEY } from "../lib/alertableIndicators";
import { getIndicator } from "../lib/indicators";
import { indTypeOf } from "../lib/indicators/shared";
import type { IndicatorAlertDraft } from "../lib/signals";

/** null = hide the entry (no such indicator, or not an alertable type). */
export function buildIndicatorAlertDraft(args: {
  chart: Chart; paneId: string; name: string; scope: string; epic: string; broker: string;
  precision: number; resolution: string; quoteOnly: boolean;
}): { draft: IndicatorAlertDraft } | { reason: string } | null {
  const ind = getIndicator(args.chart, args.paneId, args.name);
  if (!ind) return null;
  const data = args.chart.getDataList();
  const hasVolume = data.slice(-50).some((k) => (k.volume ?? 0) > 0);
  const check = checkAlertable(
    indTypeOf(ind), ind.calcParams as unknown[], ind.extendData as Record<string, unknown>,
    args.resolution, hasVolume,
  );
  if (!check.ok) return "reason" in check ? { reason: check.reason } : null;
  const result = (ind.result ?? []) as Array<Record<string, number | undefined>>;
  const key = MAIN_LINE_KEY[check.identity.indicator];
  let lastValue: number | null = null;
  for (let i = result.length - 1; i >= 0; i--) {
    const v = result[i]?.[key];
    if (typeof v === "number" && Number.isFinite(v)) { lastValue = v; break; }
  }
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision, identity: check.identity,
      timeframe: args.resolution, link: { scope: args.scope, instanceId: args.name },
      lastValue, quoteOnly: args.quoteOnly,
    },
  };
}
