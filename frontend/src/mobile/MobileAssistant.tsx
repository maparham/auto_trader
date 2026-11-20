// The phone's AI assistant (spec: 2026-11-20-mobile-assistant-design.md): a
// sparkle button above the pencil opens the desktop AssistantPanel over the
// lower part of the chart, so the chart stays in view while it changes. Each
// chart has its own chat (currentMobileCellId), as each cell does on desktop;
// chats are never pruned, since the phone has no list of its open cells and a
// chat waiting on another chart must survive. Shown only when the
// server says the assistant is set up (admin only, never in the demo).
import { useEffect, useState, useSyncExternalStore } from "react";
import { assistantConfigured } from "../assistant/api";
import { lazyChunk } from "../components/lazyChunk";
import { isDemoMode } from "../lib/demoMode";
import { useBackClose } from "./backStack";
import { mobileChartCtx, mobileChartScope, mobilePeriod, mobileSymbol } from "./mobileChartState";
import { currentMobileCellId, installMobileAssistant } from "./assistantSetup";

const AssistantPanel = lazyChunk(() => import("../AssistantPanel"));
const subscribeChart = (fn: () => void) => {
  const offs = [mobileChartCtx.subscribe(fn), mobileChartScope.subscribe(fn), mobileSymbol.subscribe(fn)];
  return () => offs.forEach((off) => off());
};
// The phone registers no backtest tools, so its suggestions stay on the chart.
const MOBILE_EXAMPLES = [
  "Add rising trendlines on the daily",
  "Show me where RSI was oversold last month",
  "Add a 50 and 200 EMA",
];

export default function MobileAssistant() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isDemoMode()) installMobileAssistant();
  }, []);
  const configured = useSyncExternalStore(
    (fn) => assistantConfigured.subscribe(fn),
    () => assistantConfigured.value,
  );
  const symbol = useSyncExternalStore(
    (fn) => mobileSymbol.subscribe(fn),
    () => mobileSymbol.value,
  );
  const cellId = useSyncExternalStore(subscribeChart, currentMobileCellId);
  const period = useSyncExternalStore(
    (fn) => mobilePeriod.subscribe(fn),
    () => mobilePeriod.value,
  );
  useBackClose(open, () => setOpen(false));
  if (isDemoMode() || !configured) return null;
  if (!open) {
    return (
      <button className="m-assistant-fab" aria-label="Assistant" onClick={() => setOpen(true)}>
        ✦
      </button>
    );
  }
  return (
    <div className="m-assistant">
      <AssistantPanel
        cellId={cellId}
        examples={MOBILE_EXAMPLES}
        chart={symbol && period ? { epic: symbol.epic, resolution: period.resolution } : null}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
