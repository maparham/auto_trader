// Agent indicator actions: manage the focused chart's indicator instances via
// the same code paths the UI uses (addIndicatorInstance / removeIndicatorById
// + persistence), so agent edits persist and mirror like human edits.
import { ActionError, registerAction } from "../registry";
import { focusedChart } from "./chart";
import {
  addIndicatorInstance,
  removeIndicatorById,
  getIndicatorsByPane,
  getIndicator,
} from "../../lib/indicators";
import {
  saveIndicators,
  saveIndicatorConfig,
  loadIndicatorConfigs,
} from "../../lib/persist/artifacts";
import { BASE_TEMPLATES } from "../../lib/customIndicators";
import { ALL_PERIODS, periodByResolution } from "../../lib/feed";
import { applyTrendlinesTimeframe } from "../../lib/mtfCoordinator";
import { parseTrendlinesConfig } from "../../lib/indicators/trendlinesOutputs";

// Everything this action can add: the custom templates plus a curated
// allowlist of klinecharts native indicator types known to work through this
// action. This is NOT the same list the indicator sidebar offers (that UI
// calls getSupportedIndicators()); it's deliberately narrower.
const BUILTIN_TYPES = ["MACD", "BOLL", "VOL", "KDJ", "SAR", "BBI"];
const VALID_TYPES = [...Object.keys(BASE_TEMPLATES), ...BUILTIN_TYPES].sort();

export function registerIndicatorActions(): void {
  registerAction({
    name: "indicator.list",
    description: "Active indicator instances on the focused chart (id, type, calcParams). Read-only.",
    kind: "read",
    params: { type: "object", properties: {} },
    handler: async () => {
      const { controller, scope, epic, cellId } = focusedChart();
      const configs = loadIndicatorConfigs(scope);
      return {
        epic, cellId,
        indicators: controller.indicators.value.map((i) => ({
          id: i.id, type: i.type, inset: i.inset,
          calcParams: configs[i.id]?.calcParams,
        })),
      };
    },
  });

  registerAction({
    name: "indicator.add",
    description:
      `Add an indicator to the focused chart in one call. type: one of ${VALID_TYPES.join(", ")}. calcParams sets the periods (e.g. RSI [14], EMA [21]). Returns the instance id.`,
    kind: "write",
    params: {
      type: "object",
      properties: {
        type: { type: "string", description: "indicator type, e.g. RSI" },
        calcParams: { type: "array", description: "numeric params, e.g. [14]" },
        inset: {
          type: "boolean",
          description:
            "draw inside the candle pane's bottom band instead of opening a sub-pane; only RSI/ATR/SLOPE support this, ignored for other types",
        },
      },
      required: ["type"],
    },
    handler: async (args) => {
      const { chart, controller, scope, epic, cellId, resolution } = focusedChart();
      const type = String(args.type);
      if (!VALID_TYPES.includes(type)) {
        throw new ActionError("INVALID_ARGS", `unknown indicator type: ${type} (one of ${VALID_TYPES.join(", ")})`);
      }
      const calcParams = Array.isArray(args.calcParams)
        ? (args.calcParams as unknown[]).map(Number).filter(Number.isFinite)
        : undefined;
      const inst = addIndicatorInstance(chart, scope, epic, type, {
        config: calcParams ? { calcParams } : undefined,
        forceHidden: controller.indicatorsHidden.value,
        resolution,
        inset: args.inset === true,
      });
      if (!inst) throw new ActionError("ADD_FAILED", `could not add ${type}`);
      const next = [...controller.indicators.value, inst];
      controller.indicators.set(next);
      saveIndicators(scope, next);
      return { id: inst.id, type: inst.type, epic, cellId };
    },
  });

  registerAction({
    name: "indicator.set",
    description:
      "Patch an indicator instance (see indicator.list for ids). Any of: calcParams (numeric params), extendData (shallow-merged onto the live extendData, e.g. Trendlines render flags such as showCrossings or dimOpacity), timeframe (pin a Trendlines instance to a higher timeframe: DAY or 1D; \"chart\" unpins). Persists like the settings modal.",
    kind: "write",
    params: {
      type: "object",
      properties: {
        id: { type: "string" },
        calcParams: { type: "array", description: "new numeric params" },
        extendData: { type: "object", description: "fields merged onto the instance's extendData" },
        timeframe: {
          type: "string",
          description: "TRENDLINES only: a resolution (DAY) or label (1D) at or above the chart's, or \"chart\" to unpin",
        },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const { chart, controller, scope, epic, cellId, broker } = focusedChart();
      const id = String(args.id);
      const calcParams = Array.isArray(args.calcParams)
        ? (args.calcParams as unknown[]).map(Number)
        : undefined;
      if (calcParams?.some((n) => !Number.isFinite(n))) {
        throw new ActionError("INVALID_ARGS", "calcParams: numbers required");
      }
      const patch =
        args.extendData !== undefined
          ? (args.extendData as Record<string, unknown> | null)
          : undefined;
      if (patch !== undefined && (patch === null || typeof patch !== "object" || Array.isArray(patch))) {
        throw new ActionError("INVALID_ARGS", "extendData: an object of fields is required");
      }
      // undefined = not asked; null = unpin; string = a resolution to pin to.
      let timeframe: string | null | undefined;
      if (args.timeframe !== undefined) {
        const wanted = String(args.timeframe);
        if (wanted === "chart") timeframe = null;
        else {
          const period =
            periodByResolution(wanted) ??
            ALL_PERIODS.find((p) => p.label.toLowerCase() === wanted.toLowerCase());
          if (!period) {
            throw new ActionError(
              "INVALID_ARGS",
              `unknown timeframe: ${wanted} (chart, or one of ${ALL_PERIODS.map((p) => p.label).join(", ")})`,
            );
          }
          timeframe = period.resolution;
        }
      }
      if (!calcParams && !patch && timeframe === undefined) {
        throw new ActionError("INVALID_ARGS", "nothing to set: give calcParams, extendData or timeframe");
      }
      let paneId: string | null = null;
      for (const [pid, inds] of getIndicatorsByPane(chart)) {
        if (inds.has(id)) { paneId = pid; break; }
      }
      if (!paneId) throw new ActionError("NOT_FOUND", `no indicator with id ${id}`);
      const type = controller.indicators.value.find((i) => i.id === id)?.type;
      if (timeframe !== undefined && type !== "TRENDLINES") {
        throw new ActionError("INVALID_ARGS", `timeframe: only TRENDLINES pins through this action (${id} is ${type ?? "unknown"})`);
      }
      const live = getIndicator(chart, paneId, id);
      const saved = loadIndicatorConfigs(scope)[id] ?? {};
      // The extend patch lands first: a pin re-detects the lines and reads
      // its render flags off the live instance.
      if (patch) {
        chart.overrideIndicator({
          paneId, name: id,
          extendData: { ...((live?.extendData as object) ?? {}), ...patch },
        });
      }
      // A pinned Trendlines instance detects on the higher timeframe's own
      // bars, so new params have to go back through the coordinator: a bare
      // calcParams override would leave the stashed HTF detection as it was.
      const pinned = (live?.extendData as { mtf?: { timeframe?: string | null } } | undefined)?.mtf?.timeframe ?? null;
      const rewalk = timeframe !== undefined ? timeframe : calcParams && type === "TRENDLINES" && pinned ? pinned : undefined;
      if (rewalk !== undefined) {
        const cp = calcParams ?? saved.calcParams ?? (live?.calcParams as unknown[] | undefined);
        const liveExt = getIndicator(chart, paneId, id)?.extendData;
        await applyTrendlinesTimeframe(
          chart, epic, id, paneId,
          parseTrendlinesConfig(cp, liveExt), rewalk, broker,
        );
      } else if (calcParams) {
        chart.overrideIndicator({ paneId, name: id, calcParams });
      }
      const ext: Record<string, unknown> = {
        ...((saved.extendData as Record<string, unknown> | undefined) ?? {}),
        ...(patch ?? {}),
      };
      if (timeframe !== undefined) {
        const prev = ext.mtf as { waitClose?: boolean } | undefined;
        if (timeframe) ext.mtf = { timeframe, ...(prev?.waitClose === false ? { waitClose: false } : {}) };
        else delete ext.mtf;
      }
      saveIndicatorConfig(scope, id, {
        ...saved,
        ...(calcParams ? { calcParams } : {}),
        extendData: Object.keys(ext).length ? ext : undefined,
      });
      return { id, cellId, calcParams: calcParams ?? saved.calcParams, extendData: ext };
    },
  });

  registerAction({
    name: "indicator.remove",
    description: "Remove one indicator instance from the focused chart by id.",
    kind: "write",
    params: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (args) => {
      const { chart, controller, scope, cellId } = focusedChart();
      const id = String(args.id);
      const cur = controller.indicators.value;
      if (!cur.some((i) => i.id === id)) {
        throw new ActionError("NOT_FOUND", `no indicator with id ${id}`);
      }
      removeIndicatorById(chart, scope, id);
      const next = cur.filter((i) => i.id !== id);
      controller.indicators.set(next);
      saveIndicators(scope, next);
      return { removed: id, cellId };
    },
  });
}
