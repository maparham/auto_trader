// The assistant's tool surface: an allowlist over the agent action registry
// (same handlers the MCP bridge drives) plus five assistant-only tools that
// run locally (assistant/describe.ts, assistant/session.ts).
import { listActions } from "../agent/registry";
import { VALID_TYPES } from "../agent/actions/indicators";
import type { ToolDef } from "./types";

export const TOOL_TO_ACTION: Record<string, string> = {
  chart_state: "chart.state",
  chart_timeframe_set: "chart.timeframe.set",
  chart_range_set: "chart.range.set",
  market_select: "market.select",
  tab_list: "tab.list",
  indicator_list: "indicator.list",
  indicator_add: "indicator.add",
  indicator_set: "indicator.set",
  indicator_remove: "indicator.remove",
  drawing_list: "drawing.list",
  drawing_add: "drawing.add",
  drawing_remove: "drawing.remove",
  backtest_config_get: "backtest.config.get",
  backtest_config_set: "backtest.config.set",
  backtest_run: "backtest.run",
  backtest_result: "backtest.result",
};
const ACTION_TO_TOOL = Object.fromEntries(Object.entries(TOOL_TO_ACTION).map(([t, a]) => [a, t]));

export const LOCAL_TOOLS = [
  "ask_user", "describe_indicator", "indicator_configure", "describe_rules", "validate_rule",
] as const;

export function actionFor(tool: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_TO_ACTION, tool) ? TOOL_TO_ACTION[tool] : null;
}

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  backtest_run:
    "Run a backtest with the current configuration on the focused chart and return a summary of its metrics. It can take a while.",
  chart_state:
    "Numeric state of the focused chart: epic, resolution, broker, visible time range, active indicators (id/type), a drawings summary and the last N visible candles (OHLCV). Read-only.",
};
const BRIDGE_ONLY = /ui_wait|handle|screenshot/i;

/** Drop sentences written for the MCP bridge (handles, ui_wait, screenshots). */
function cleanDescription(desc: string): string {
  return desc
    .split(/(?<=\.)\s+/)
    .filter((s) => !BRIDGE_ONLY.test(s))
    .join(" ")
    .trim();
}

const LOCAL_DEFS: ToolDef[] = [
  {
    name: "ask_user",
    description:
      "Ask the user ONE clarifying question with 2 to 5 short options, when two readings of the request would give materially different charts. The user's pick (or their own words) comes back as this tool's result.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["question", "options"],
      properties: {
        question: { type: "string" },
        options: {
          type: "array", minItems: 2, maxItems: 5,
          items: {
            type: "object", additionalProperties: false, required: ["label"],
            properties: { label: { type: "string" }, description: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "describe_indicator",
    description:
      "Describe an indicator type's settings: each input's key, label, default, range and tip, plus its presets and directions. Call before configuring a type you have not seen described.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["type"],
      properties: { type: { type: "string", enum: VALID_TYPES } },
    },
  },
  {
    name: "indicator_configure",
    description:
      "Change an indicator instance's numeric settings by name: apply a preset, a direction, and/or params keyed by the keys describe_indicator returned. Merges onto the live settings.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        preset: { type: "string" },
        direction: { type: "string" },
        params: { type: "object", additionalProperties: { type: "number" } },
      },
    },
  },
  {
    name: "describe_rules",
    description:
      "The backtest rule language: indicators, wrappers, crosses, candle fields, timeframes, conditions, patterns, and the focused chart's panes usable as <id>.<output>. Call once before writing rules.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "validate_rule",
    description: "Check one rule expression. Returns ok, errors with positions, and warmupBars.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["expr"],
      properties: { expr: { type: "string" }, isExit: { type: "boolean" } },
    },
  },
];

export function buildTools(): ToolDef[] {
  const out: ToolDef[] = [];
  for (const a of listActions()) {
    const tool = ACTION_TO_TOOL[a.name];
    if (!tool) continue;
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [k, p] of Object.entries(a.params.properties)) properties[k] = { ...p };
    if (tool === "indicator_add" && properties.type) properties.type.enum = VALID_TYPES;
    out.push({
      name: tool,
      description: DESCRIPTION_OVERRIDES[tool] ?? cleanDescription(a.description),
      input_schema: {
        type: "object", properties, required: a.params.required ?? [], additionalProperties: false,
      },
    });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  return [...out, ...LOCAL_DEFS];
}

export function prepareInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === "chart_state") {
    const bars = Number(input.bars ?? 60);
    return { ...input, bars: Math.min(Number.isFinite(bars) ? bars : 60, 200) };
  }
  return input;
}

export const RESULT_CAP = 8192;

interface BacktestLike {
  metrics?: unknown;
  trades?: Array<{ entry_time?: number; exit_time?: number }>;
  analysis?: Record<string, unknown>;
}

export function budgetResult(tool: string, value: unknown): string {
  let v = value;
  if ((tool === "backtest_run" || tool === "backtest_result") && v && typeof v === "object") {
    const r = v as BacktestLike;
    const trades = r.trades ?? [];
    v = {
      metrics: r.metrics ?? null,
      tradeCount: trades.length,
      firstTradeAt: trades[0]?.entry_time ?? null,
      lastTradeAt: trades[trades.length - 1]?.exit_time ?? null,
      analysisKeys: Object.keys(r.analysis ?? {}),
    };
  }
  const s = JSON.stringify(v ?? null);
  return s.length <= RESULT_CAP ? s : `${s.slice(0, RESULT_CAP)}…[truncated]`;
}
