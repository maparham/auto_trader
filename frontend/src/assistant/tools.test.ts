// @vitest-environment jsdom
// jsdom (not the suite's default `node` env): tools.ts imports VALID_TYPES from
// agent/actions/indicators.ts, which pulls in klinecharts, which touches `window`
// at module-load time (same reason chart.test.ts / indicators.test.ts need it).
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, registerAction } from "../agent/registry";
import {
  TOOL_TO_ACTION, LOCAL_TOOLS, actionFor, buildTools, prepareInput, budgetResult, RESULT_CAP,
} from "./tools";

function fake(name: string, description = `${name} does a thing.`) {
  registerAction({
    name, description, kind: "write",
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async () => null,
  });
}

describe("assistant tools", () => {
  beforeEach(() => {
    clearRegistryForTest();
    for (const a of Object.values(TOOL_TO_ACTION)) fake(a);
    fake("order.place");
    fake("sweep.start");
    fake("drawing.clear");
  });

  it("maps every allowlisted action both ways and refuses the rest", () => {
    for (const [tool, action] of Object.entries(TOOL_TO_ACTION)) {
      expect(tool).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(actionFor(tool)).toBe(action);
    }
    expect(actionFor("order_place")).toBeNull();
    expect(actionFor("ask_user")).toBeNull();
  });

  it("excludes dealing, sweep and drawing.clear", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).not.toContain("order_place");
    expect(names).not.toContain("sweep_start");
    expect(names).not.toContain("drawing_clear");
  });

  it("includes the six local tools", () => {
    const names = buildTools().map((t) => t.name);
    for (const t of LOCAL_TOOLS) expect(names).toContain(t);
    expect(LOCAL_TOOLS).toHaveLength(6);
  });

  it("closes schemas and keeps required", () => {
    const t = buildTools().find((x) => x.name === "indicator_remove")!;
    expect(t.input_schema).toMatchObject({
      type: "object", required: ["id"], additionalProperties: false,
    });
  });

  it("strips bridge-only sentences from descriptions", () => {
    clearRegistryForTest();
    fake("drawing.list", "Lists drawings. Pair with chart.screenshot for the visual.");
    const t = buildTools().find((x) => x.name === "drawing_list")!;
    expect(t.description).toBe("Lists drawings.");
    for (const tool of buildTools()) {
      expect(tool.description).not.toMatch(/ui_wait|handle|screenshot/i);
    }
  });

  it("caps chart_state bars", () => {
    expect(prepareInput("chart_state", {})).toEqual({ bars: 60 });
    expect(prepareInput("chart_state", { bars: 900 })).toEqual({ bars: 200 });
    expect(prepareInput("indicator_list", { a: 1 })).toEqual({ a: 1 });
  });

  it("summarises backtest results", () => {
    const res = {
      metrics: { netPnl: 12 },
      trades: [{ entry_time: 1, exit_time: 2 }, { entry_time: 3, exit_time: 4 }],
      analysis: { rolling: [], monthly: [] },
    };
    expect(JSON.parse(budgetResult("backtest_run", res))).toEqual({
      metrics: { netPnl: 12 }, tradeCount: 2, firstTradeAt: 1, lastTradeAt: 4,
      analysisKeys: ["rolling", "monthly"],
    });
  });

  it("truncates oversized results", () => {
    const out = budgetResult("drawing_list", { blob: "x".repeat(RESULT_CAP * 2) });
    expect(out.length).toBeLessThanOrEqual(RESULT_CAP + 20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
