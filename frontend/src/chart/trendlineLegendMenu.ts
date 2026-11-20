// The Trendlines-only entries of the indicator menu (legend row right-click,
// ⋯ button, curve right-click): Log Scale, Follow Chart's L, Debug mode and,
// while debug is on, its layer toggles. Each one writes through the path its Settings field
// uses, so the menu and the form never disagree.
import type { Chart } from "klinecharts";
import type { MenuItem } from "../ContextMenu";
import { loadIndicatorConfigs, saveIndicatorConfig } from "../lib/persist";
import { overrideExtend } from "../lib/overrideExtend";
import { parseTrendlinesConfig, TRENDLINES_EXTEND_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import type { TrendlinesExtend } from "../lib/indicators/trendlines";
import { applyDebugChanges, type ApplyCtx } from "./useTrendlineDebug";
import { followsChartLog, syncLogFollow } from "./trendlineLogFollow";

/** Debug-tab layers, in the Settings order. Persisted like the form does. */
const DEBUG_LAYERS: ReadonlyArray<{ key: keyof typeof TRENDLINES_EXTEND_DEFAULTS; label: string }> = [
  { key: "debugShowFailed", label: "Failed a filter" },
  { key: "debugShowOutranked", label: "Outranked by a nearer line" },
  { key: "debugShowForced", label: "Built from your line's points" },
  { key: "debugShowDrawn", label: "Drawn" },
  { key: "showStrength", label: "Show strength rank" },
];

/** Write one render-only extendData flag to the saved config and the live
 * instance, the way the Settings form's Ok does for that field. */
function setExtendFlag(chart: Chart, scope: string, paneId: string, name: string, key: string, value: boolean): void {
  const saved = loadIndicatorConfigs(scope)[name] ?? {};
  saveIndicatorConfig(scope, name, { ...saved, extendData: { ...(saved.extendData ?? {}), [key]: value } });
  overrideExtend(chart, paneId, name, { [key]: value });
}

export function trendlineMenuItems(ctx: ApplyCtx): MenuItem[] {
  const { chart, scope, paneId, name } = ctx;
  const ind = chart.getIndicators({ paneId, name })[0] as
    | { calcParams?: unknown[]; extendData?: TrendlinesExtend }
    | undefined;
  if (!ind) return [];
  const ext = ind.extendData;
  const log = parseTrendlinesConfig(ind.calcParams, ext).logScale === 1;
  const debug = ext?.debug === true;
  const follow = followsChartLog(ext);
  const items: MenuItem[] = [
    {
      label: "Log Scale",
      checked: log,
      // While it follows, the L button is what sets it.
      disabled: follow,
      disabledReason: follow ? "Set by the chart's L button" : undefined,
      // The coordinator path the Settings form and debug Apply use, so a
      // pinned timeframe re-fetches and the saved config follows.
      onClick: () => {
        applyDebugChanges(ctx, [{ field: "logScale", from: log ? 1 : 0, to: log ? 0 : 1, pool: false }]);
      },
    },
    {
      label: "Follow Chart's L",
      checked: follow,
      onClick: () => {
        setExtendFlag(chart, scope, paneId, name, "logFollow", !follow);
        // Starting to follow takes the chart's L state at once.
        if (!follow) syncLogFollow(chart, ctx, { paneId, name });
      },
    },
    {
      label: "Debug mode",
      checked: debug,
      // A live gesture, never saved (lib/indicators.ts drops it on restore),
      // exactly as the debug strip's close button turns it off.
      onClick: () => {
        chart.overrideIndicator({ paneId, name, extendData: { ...((ext as object) ?? {}), debug: !debug } });
      },
    },
  ];
  if (!debug) return items;
  for (const { key, label } of DEBUG_LAYERS) {
    const set = (ext as Record<string, unknown> | undefined)?.[key];
    const on = typeof set === "boolean" ? set : (TRENDLINES_EXTEND_DEFAULTS[key] as boolean);
    items.push({ label, checked: on, onClick: () => setExtendFlag(chart, scope, paneId, name, key, !on) });
  }
  return items;
}
