// Turns a right-clicked trendline into a line-alert draft (or the reason it
// cannot have one). The menu entry in useTrendlineMenu reads this.
import { alertTimeframeOf } from "../lib/alertableIndicators";
import { isNativeTf, parseTf } from "../lib/timeframe";
import type { TrendlineSegment } from "../lib/indicators/trendlineMarks";
import type { LineAlertDraft } from "../lib/signals";

/** null = hide the entry (a seconds chart). */
export function buildLineAlertDraft(args: {
  seg: TrendlineSegment; ext: Record<string, unknown> | undefined; resolution: string;
  scope: string; instanceId: string; epic: string; broker: string; precision: number;
}): { draft: LineAlertDraft } | { reason: string } | null {
  // A pinned pane's lines live on the pin's bars, whatever the chart shows.
  const timeframe = alertTimeframeOf(args.ext, args.resolution);
  try {
    if (parseTf(timeframe).unit === "SECOND") return null;
  } catch {
    return null;
  }
  if (!isNativeTf(timeframe)) return { reason: "Alerts on this timeframe are coming later" };
  const line = args.seg.alertLine?.() ?? null;
  if (!line) return { reason: "This line can't take an alert yet" };
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision, timeframe, line,
      link: { scope: args.scope, instanceId: args.instanceId, lineKey: args.seg.key },
    },
  };
}
