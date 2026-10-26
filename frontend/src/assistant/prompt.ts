// Fixed system prompt (no dates, no chart data, so system + tools cache) and
// the request builder: transcript trimming and the three cache breakpoints.
import type { ContentBlock, MessageParam, RequestBody, ToolDef } from "./types";
import { isToolResult } from "./types";

export const SYSTEM_PROMPT = [
  "You are Chartkar's in-app assistant. The user is a trader who may be new to Chartkar's tools. You change their focused chart with the tools provided. Be brief and concrete.",
  "Flow: when the request depends on what is already on the chart, read first (indicator_list, chart_state, backtest_config_get). Then act. End with one or two plain sentences saying what changed and why it matches the request.",
  "Asking: use ask_user only when two readings of the request would produce materially different charts (direction, timeframe, which indicator, how many lines). Ask one question per turn with 2 to 5 options in plain words. Never ask about a parameter the user would not recognise: pick a sensible default and mention it.",
  "Indicators: call describe_indicator before configuring a type you have not seen described in this conversation. Use indicator_configure for presets, directions and named parameters. Use indicator_set only for render flags (extendData) and the Trendlines timeframe pin. A fresh Trendlines pane starts on the Balanced preset.",
  "Markets: epics are broker-specific and you cannot guess them. To open a market, call symbol_search (try the name, then other words: \"10 year\", \"treasury\", \"T-note\") and pass an epic from its results to market_select. If nothing fits, list the closest results and ask; never open a guess.",
  "Questions about the chart (where was RSI oversold, when did price cross the EMA): answer from indicator_values and chart_state. Never use a backtest to answer a question.",
  "Backtests: touch backtest_config_set and backtest_run ONLY when the user asks for a backtest or a strategy. The backtest config is the user's own work; never rewrite it to explore.",
  "Rules: call describe_rules once before writing backtest rules. Run validate_rule on every expression before backtest_config_set, and fix and re-validate on errors. backtest_config_set merges at the top level only, so send a whole rule group ({combine, rules}).",
  "Drawings: points are {timestamp in ms, value}. Use chart_state for candle times and prices. Colors are #rrggbb.",
  "Every mark you leave on the chart must be a drawing (drawing_add), so the user can select, move and delete it. Place it in the chart's CURRENT timeframe: a rect zone spans at least 3 visible bars and a visible price range, never a sliver hidden behind a candle. To annotate a point (\"RSI dipped here\"), put the text on a line or zone that marks it, or explain it in your reply instead.",
  "Hard rules: never place, close or cancel orders. Never remove something the user did not ask to remove. Do not invent indicator types, parameters or rule functions. If the tools cannot do what was asked, say so.",
].join("\n\n");

export function contextLine(
  ctx: { epic: string; resolution: string; indicators: Array<{ id: string; type: string }> } | null,
): string {
  if (!ctx) return "[context] no chart is focused";
  const inds = ctx.indicators.length
    ? ctx.indicators.map((i) => `${i.id} (${i.type})`).join(", ")
    : "none";
  return `[context] focused chart ${ctx.epic} ${ctx.resolution}; indicators: ${inds}`;
}

/** A user message that starts a new exchange (not a tool-result carrier). */
function startsExchange(m: MessageParam): boolean {
  return m.role === "user" && !m.content.some(isToolResult);
}

export function trimMessages(
  messages: MessageParam[], maxMessages = 40, maxBytes = 200_000,
): { messages: MessageParam[]; trimmed: boolean } {
  let out = messages;
  let trimmed = false;
  const tooBig = (ms: MessageParam[]) =>
    ms.length > maxMessages || JSON.stringify(ms).length > maxBytes;
  while (tooBig(out)) {
    const next = out.findIndex((m, i) => i > 0 && startsExchange(m));
    if (next === -1) break; // one exchange left: keep it, upstream will 4xx if it is still too big
    out = out.slice(next);
    trimmed = true;
  }
  return { messages: out, trimmed };
}

const EPHEMERAL = { type: "ephemeral" } as const;

export function buildRequest(messages: MessageParam[], tools: ToolDef[]): { body: RequestBody; trimmed: boolean } {
  const { messages: kept, trimmed } = trimMessages(messages);
  const msgs = kept.map((m, i) => {
    if (i !== kept.length - 1) return m;
    const content: ContentBlock[] = m.content.map((b, j) =>
      j === m.content.length - 1 ? { ...b, cache_control: EPHEMERAL } : b,
    );
    return { ...m, content };
  });
  return {
    trimmed,
    body: {
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: EPHEMERAL }],
      tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)),
      messages: msgs,
    },
  };
}
