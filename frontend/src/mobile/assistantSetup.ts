// The AI assistant on the phone (spec: 2026-11-20-mobile-assistant-design.md).
// The assistant's loop (assistant/session.ts) runs tools through the agent
// action registry against "the focused chart"; desktop App registers the
// actions and points the providers at its focused cell. The phone shows one
// chart at a time, so this does the same for it. Its cell id names the chart
// (scope and symbol, mobileCellId): each chart gets its own chat and undo,
// and a chip tap mid-turn makes the chat wait, as a cell switch does on
// desktop.
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

/** The phone chart's cell id. The epic is part of it because charts with no
 * saved view share one fallback scope. */
export function mobileCellId(scope: string, epic: string): string {
  return `mobile:${scope}|${epic}`;
}
/** How long market.select waits for the new chart to mount. */
export const MARKET_SELECT_WAIT_MS = 10_000;

/** The mounted chart, when it is the one for the symbol shown. Between a
 * symbol change and the new chart's onReady, mobileChartCtx still holds the
 * old chart: its epic (or scope) no longer matches, so this answers null. */
function liveChart(): (MobileChartCtx & { epic: string; scope: string; cellId: string }) | null {
  const ctx = mobileChartCtx.value;
  const sym = mobileSymbol.value;
  const scope = mobileChartScope.value;
  if (!ctx || !sym || !scope || scope.epic !== sym.epic) return null;
  if (ctx.epic !== sym.epic || ctx.controller.scope !== scope.scope) return null;
  return { ...ctx, epic: sym.epic, scope: scope.scope, cellId: mobileCellId(scope.scope, sym.epic) };
}

/** The shown chart's cell id, or null while none is mounted. */
export function currentMobileCellId(): string | null {
  return liveChart()?.cellId ?? null;
}

/** Resolves once the chart for `epic` has mounted (its onReady ran). */
function waitForChart(epic: string, signal?: AbortSignal): Promise<void> {
  const ready = () => liveChart()?.epic === epic;
  return new Promise((resolve, reject) => {
    if (ready()) return resolve();
    if (signal?.aborted) return reject(new ActionError("STOPPED", "stopped"));
    const done = (err?: Error) => {
      clearTimeout(timer);
      unsubs.forEach((u) => u());
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => done(new ActionError("STOPPED", "stopped"));
    const check = () => {
      if (ready()) done();
    };
    const timer = setTimeout(
      () => done(new ActionError("NOT_OPENED", `${epic} did not open on the chart`)),
      MARKET_SELECT_WAIT_MS,
    );
    const unsubs = [mobileChartCtx.subscribe(check), mobileChartScope.subscribe(check), mobileSymbol.subscribe(check)];
    signal?.addEventListener("abort", onAbort);
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
        handler: async (args, ctx) => {
          const epic = args.epic as string;
          await showMobileEpic(epic, (args.precision as number) ?? 2);
          await waitForChart(epic, ctx?.signal);
          return { epic, cellId: currentMobileCellId() };
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
        cellId: live.cellId,
        resolution: period.resolution,
        broker: mobileBroker(),
        setPeriod: (p) => mobilePeriod.set(p),
      };
    });
    setFocusedDrawingsProvider(() => {
      const live = liveChart();
      return live ? { overlays: live.controller.overlays, epic: live.epic, cellId: live.cellId } : null;
    });
  }
  if (!isDemoMode()) void fetchAssistantStatus();
}
