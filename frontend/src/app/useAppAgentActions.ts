// The app-level agent bridge actions (market.select, tab.list,
// panel.backtest.open). They close over App's live refs, so they're
// registered from App rather than agent/index.ts.
import { useEffect } from "react";
import { registerAction } from "../agent/registry";
import { openBacktestSettings } from "../lib/signals";
import type { ChartTab } from "../lib/persist";
import type { Ref } from "./types";

// Agent UI Bridge: the app-level actions close over App's handlers, so they're
// registered from a mount effect rather than agent/index.ts. Module flag guards
// StrictMode's double effect run; a Vite HMR reload of THIS module resets it and
// registerAction throws on a duplicate name, hence the try/catch at the call site.
let appAgentActionsRegistered = false;

export function useAppAgentActions(
  jumpToEpicRef: Ref<(epic: string, precisionGuess?: number) => Promise<unknown>>,
  tabsRef: Ref<ChartTab[]>,
  activeIdRef: Ref<string>,
) {
  useEffect(() => {
    if (appAgentActionsRegistered) return;
    appAgentActionsRegistered = true;
    try {
      registerAction({
        name: "market.select",
        description: "Focus (or open) a chart tab showing this epic",
        kind: "write",
        params: {
          type: "object",
          properties: {
            epic: { type: "string" },
            precision: { type: "number", description: "price precision guess, default 2" },
          },
          required: ["epic"],
        },
        handler: async (args) =>
          jumpToEpicRef.current(args.epic as string, (args.precision as number) ?? 2),
      });
      registerAction({
        name: "tab.list",
        description: "Open chart tabs with the epics they show and which one is active",
        kind: "read",
        params: { type: "object", properties: {} },
        handler: async () =>
          tabsRef.current.map((t) => ({
            id: t.id,
            layout: t.layout,
            active: t.id === activeIdRef.current,
            activeCellId: t.activeCellId,
            cells: t.cells.map((c) => ({ id: c.id, epic: c.symbol.epic, period: c.period })),
          })),
      });
      registerAction({
        name: "panel.backtest.open",
        description: "Open the backtest settings panel",
        kind: "write",
        params: { type: "object", properties: {} },
        handler: async () => { openBacktestSettings(); return { opened: true }; },
      });
    } catch (e) {
      // A duplicate-name throw here (HMR reload of this module) must not take
      // the app down on mount.
      console.debug("agent: app actions already registered (HMR?)", e);
    }
    // Registered once; the handlers read App's refs, which never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
