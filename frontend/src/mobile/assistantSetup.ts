// The AI assistant on the phone (spec: 2026-11-20-mobile-assistant-design.md).
// The assistant's loop (assistant/session.ts) runs tools through the agent
// action registry against "the focused chart"; desktop App registers the
// actions and points the providers at its focused cell. The phone has one
// chart, so this does the same for it, under the fixed cell id "mobile".
//
// Only the chart, indicator and drawing actions are registered, plus a phone
// market.select: the assistant's tool list is built from the registry, so
// backtest, sweep, dealing and tab tools never reach the model here.
import { ActionError, registerAction } from "../agent/registry";
import { registerChartActions, setFocusedChartProvider } from "../agent/actions/chart";
import { registerDrawingActions, setFocusedDrawingsProvider } from "../agent/actions/drawings";
import { registerIndicatorActions } from "../agent/actions/indicators";
import { fetchAssistantStatus } from "../assistant/api";
import { isDemoMode } from "../lib/demoMode";
import {
  mobileBroker,
  mobileChartCtx,
  mobileChartScope,
  mobilePeriod,
  mobileSymbol,
  showMobileEpic,
  type MobileChartCtx,
} from "./mobileChartState";

export const MOBILE_CELL_ID = "mobile";
/** How long market.select waits for the new chart to mount. */
export const MARKET_SELECT_WAIT_MS = 10_000;

/** The mounted chart, when it is the one for the symbol shown. Between a
 * symbol change and the new chart's onReady, mobileChartCtx still holds the
 * old chart: its scope no longer matches, so this answers null. */
function liveChart(): (MobileChartCtx & { epic: string; scope: string }) | null {
  const ctx = mobileChartCtx.value;
  const sym = mobileSymbol.value;
  const scope = mobileChartScope.value;
  if (!ctx || !sym || !scope || scope.epic !== sym.epic) return null;
  if (ctx.controller.scope !== scope.scope) return null;
  return { ...ctx, epic: sym.epic, scope: scope.scope };
}

/** Resolves once the chart for `epic` has mounted (its onReady ran). */
function waitForChart(epic: string): Promise<void> {
  const ready = () => liveChart()?.epic === epic;
  return new Promise((resolve, reject) => {
    if (ready()) return resolve();
    const unsubs: (() => void)[] = [];
    const done = (err?: Error) => {
      clearTimeout(timer);
      unsubs.forEach((u) => u());
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (ready()) done();
    };
    unsubs.push(mobileChartCtx.subscribe(check), mobileChartScope.subscribe(check), mobileSymbol.subscribe(check));
    const timer = setTimeout(
      () => done(new ActionError("NOT_OPENED", `${epic} did not open on the chart`)),
      MARKET_SELECT_WAIT_MS,
    );
  });
}

let installed = false;

/** Register the phone's assistant actions and providers. Idempotent. */
export function installMobileAssistant(): void {
  if (!installed) {
    installed = true;
    try {
      registerDrawingActions();
      registerChartActions();
      registerIndicatorActions();
      registerAction({
        name: "market.select",
        description: "Open this epic on the chart",
        kind: "write",
        params: {
          type: "object",
          properties: {
            epic: { type: "string" },
            precision: { type: "number", description: "price precision guess, default 2" },
          },
          required: ["epic"],
        },
        handler: async (args) => {
          const epic = args.epic as string;
          await showMobileEpic(epic, (args.precision as number) ?? 2);
          await waitForChart(epic);
          return { epic, cellId: MOBILE_CELL_ID };
        },
      });
    } catch (e) {
      // A duplicate name (HMR reload of this module) must not take the app down.
      console.debug("mobile assistant: actions already registered", e);
    }
    setFocusedChartProvider(() => {
      const live = liveChart();
      const period = mobilePeriod.value;
      if (!live || !period) return null;
      return {
        chart: live.chart,
        controller: live.controller,
        scope: live.scope,
        epic: live.epic,
        cellId: MOBILE_CELL_ID,
        resolution: period.resolution,
        broker: mobileBroker(),
        setPeriod: (p) => mobilePeriod.set(p),
      };
    });
    setFocusedDrawingsProvider(() => {
      const live = liveChart();
      return live ? { overlays: live.controller.overlays, epic: live.epic, cellId: MOBILE_CELL_ID } : null;
    });
  }
  if (!isDemoMode()) void fetchAssistantStatus();
}
