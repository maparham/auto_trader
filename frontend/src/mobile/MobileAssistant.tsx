// The phone's AI assistant (spec: 2026-11-20-mobile-assistant-design.md): a
// sparkle button above the pencil opens the desktop AssistantPanel over the
// lower part of the chart, so the chart stays in view while it changes. One
// chat, since the phone has one chart (cell id "mobile"). Shown only when the
// server says the assistant is set up (admin only, never in the demo).
import { useEffect, useState, useSyncExternalStore } from "react";
import { assistantConfigured } from "../assistant/api";
import { lazyChunk } from "../components/lazyChunk";
import { isDemoMode } from "../lib/demoMode";
import { useBackClose } from "./backStack";
import { mobilePeriod, mobileSymbol } from "./mobileChartState";
import { installMobileAssistant, MOBILE_CELL_ID } from "./assistantSetup";

const AssistantPanel = lazyChunk(() => import("../AssistantPanel"));
const CELL_IDS = [MOBILE_CELL_ID];

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
        cellId={MOBILE_CELL_ID}
        cellIds={CELL_IDS}
        chart={symbol && period ? { epic: symbol.epic, resolution: period.resolution } : null}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
