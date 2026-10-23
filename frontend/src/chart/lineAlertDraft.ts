// Turns a right-clicked trendline into a line-alert draft (or the reason it
// cannot have one). The menu entry in useTrendlineMenu reads this.
import { lineGate } from "../lib/pickedLines";
import type { TrendlineSegment } from "../lib/indicators/trendlineMarks";
import type { LineAlertDraft } from "../lib/signals";

/** null = hide the entry (a seconds chart). */
export function buildLineAlertDraft(args: {
  seg: TrendlineSegment; ext: Record<string, unknown> | undefined; resolution: string;
  scope: string; instanceId: string; epic: string; broker: string; precision: number;
}): { draft: LineAlertDraft } | { reason: string } | null {
  // A pinned pane's lines live on the pin's bars, whatever the chart shows.
  const gate = lineGate(args.seg, args.ext, args.resolution);
  if (!gate.ok) {
    // Seconds and unparseable timeframes hide the menu entry; others show a reason
    if (gate.kind === "seconds" || gate.kind === "unparseable") return null;
    // Non-native and no-geometry cases show reasons
    const messages: Record<Exclude<typeof gate.kind, "seconds" | "unparseable">, string> = {
      nonNative: "Alerts on this timeframe are coming later",
      noGeometry: "This line can't take an alert yet",
    };
    return { reason: messages[gate.kind as "nonNative" | "noGeometry"] };
  }
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision, timeframe: gate.timeframe, line: gate.geometry,
      link: { scope: args.scope, instanceId: args.instanceId, lineKey: args.seg.key },
    },
  };
}
