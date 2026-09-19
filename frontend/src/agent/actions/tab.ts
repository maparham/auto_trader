// Browser-tab actions that are not about the chart: naming the tab. The
// backend's ui_set_title tool calls tab.title.set and refuses every other UI
// tool on a session until it has run, so an agent-driven tab is always named.
// The robot mark is stamped here, not left to the agent, so the owner can
// tell agent tabs from their own at a glance whatever title the agent picked.
import { ActionError, registerAction } from "../registry";

export const AGENT_TAB_MARK = "🤖";

export function registerTabActions(): void {
  registerAction({
    name: "tab.title.set",
    description:
      "Name this browser tab (document.title) so the owner can tell agent-driven tabs apart. Prefixes a robot mark. Required before other actions; normally invoked through the ui_set_title MCP tool.",
    kind: "write",
    params: {
      type: "object",
      properties: { title: { type: "string", description: "short, specific, e.g. 'US100 4H backtest'" } },
      required: ["title"],
    },
    handler: async (args) => {
      const raw = String(args.title ?? "").trim();
      if (!raw) throw new ActionError("INVALID_ARGS", "title must be a non-empty string");
      const title = raw.startsWith(AGENT_TAB_MARK) ? raw : `${AGENT_TAB_MARK} ${raw}`;
      document.title = title;
      return { title };
    },
  });
}
