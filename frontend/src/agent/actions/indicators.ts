// Agent indicator actions: manage the focused chart's indicator instances via
// the same code paths the UI uses (addIndicatorInstance / removeIndicatorById
// + persistence), so agent edits persist and mirror like human edits.
import { ActionError, registerAction } from "../registry";
import { focusedChart } from "./chart";
import {
  addIndicatorInstance,
  removeIndicatorById,
  getIndicatorsByPane,
} from "../../lib/indicators";
import {
  saveIndicators,
  saveIndicatorConfig,
  loadIndicatorConfigs,
} from "../../lib/persist/artifacts";
import { BASE_TEMPLATES } from "../../lib/customIndicators";

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
    description: "Patch an indicator instance's calcParams (see indicator.list for ids).",
    kind: "write",
    params: {
      type: "object",
      properties: {
        id: { type: "string" },
        calcParams: { type: "array", description: "new numeric params" },
      },
      required: ["id", "calcParams"],
    },
    handler: async (args) => {
      const { chart, scope, cellId } = focusedChart();
      const id = String(args.id);
      const calcParams = (args.calcParams as unknown[]).map(Number);
      if (calcParams.some((n) => !Number.isFinite(n))) {
        throw new ActionError("INVALID_ARGS", "calcParams: numbers required");
      }
      let paneId: string | null = null;
      for (const [pid, inds] of getIndicatorsByPane(chart)) {
        if (inds.has(id)) { paneId = pid; break; }
      }
      if (!paneId) throw new ActionError("NOT_FOUND", `no indicator with id ${id}`);
      chart.overrideIndicator({ paneId, name: id, calcParams });
      const saved = loadIndicatorConfigs(scope)[id] ?? {};
      saveIndicatorConfig(scope, id, { ...saved, calcParams });
      return { id, calcParams, cellId };
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
