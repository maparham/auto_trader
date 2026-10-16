// Turns a live chart indicator into an alert draft, or null to hide the
// entry. Shared by the legend bell and the indicator menu. Whether the pane's
// settings can be alerted on is the server's call (POST /api/alerts/describe,
// shown in the dialog), not this file's.
import type { Chart } from "klinecharts";
import { alertInstanceOf, alertTimeframeOf, isAlertableType } from "../lib/indicatorAlertInstance";
import { getIndicator } from "../lib/indicators";
import { indTypeOf } from "../lib/indicators/shared";
import { parseTf } from "../lib/timeframe";
import type { IndicatorAlertDraft } from "../lib/signals";

export function buildIndicatorAlertDraft(args: {
  chart: Chart; paneId: string; name: string; scope: string; epic: string; broker: string;
  precision: number; resolution: string; quoteOnly: boolean;
}): { draft: IndicatorAlertDraft } | null {
  const ind = getIndicator(args.chart, args.paneId, args.name);
  if (!ind) return null;
  const type = indTypeOf(ind);
  if (!isAlertableType(type)) return null;
  try {
    if (parseTf(args.resolution).unit === "SECOND") return null;
  } catch {
    return null;
  }
  const ext = ind.extendData as Record<string, unknown> | undefined;
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision,
      instance: alertInstanceOf(type, ind.calcParams as unknown[], ext),
      chartTimeframe: alertTimeframeOf(ext, args.resolution),
      link: { scope: args.scope, instanceId: args.name }, quoteOnly: args.quoteOnly,
    },
  };
}
