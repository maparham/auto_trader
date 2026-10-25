// @vitest-environment jsdom
// jsdom (not the suite's default `node` env): undo.ts imports ./tools, which
// imports VALID_TYPES from agent/actions/indicators.ts, which pulls in
// klinecharts, which touches `window` at module-load time (same reason
// tools.test.ts / describe.test.ts need it).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const focus = { cellId: "c1", epic: "US100", resolution: "HOUR", scope: "s1" };
let liveInstances: Array<{ id: string; type: string; calcParams: number[]; extendData?: unknown }> = [];

vi.mock("../agent/actions/chart", () => ({
  focusedChart: () => ({ ...focus, chart: {}, controller: { indicators: { value: liveInstances } } }),
  agentPeriod: (s: string) => ({ resolution: s === "1D" ? "DAY" : s }),
}));
vi.mock("../agent/actions/drawings", () => ({
  focusedDrawings: () => ({ overlays: drawings, epic: focus.epic, cellId: focus.cellId }),
}));
vi.mock("../lib/indicators", () => ({ liveExprInstances: () => liveInstances }));
vi.mock("../lib/notify", () => ({ toast: vi.fn() }));

const drawings = {
  getDrawing: vi.fn((id: string) => (id === "d1" ? { name: "segment", points: [], styles: { line: { size: 3 } }, lock: false, visible: true, zLevel: 0, extendData: {} } : null)),
  placeDrawing: vi.fn(() => "d9"),
};

import { clearRegistryForTest, registerAction } from "../agent/registry";
import { executeTool, undoTurn } from "./undo";

const ctx = { progress: () => {}, signal: new AbortController().signal };
const calls: Array<[string, unknown]> = [];

function reg(name: string, result: (args: Record<string, unknown>) => unknown) {
  registerAction({
    name, description: name, kind: "write",
    params: { type: "object", properties: {
      id: { type: "string" }, type: { type: "string" }, calcParams: { type: "array" },
      extendData: { type: "object" }, timeframe: { type: "string" }, patch: { type: "object" },
      resolution: { type: "string" }, tool: { type: "string" }, points: { type: "array" },
      inset: { type: "boolean" }, epic: { type: "string" },
    } },
    handler: async (args) => { calls.push([name, args]); return result(args); },
  });
}

beforeEach(() => {
  clearRegistryForTest();
  calls.length = 0;
  focus.cellId = "c1";
  liveInstances = [{ id: "TL", type: "TRENDLINES", calcParams: [5, 0, 2], extendData: { showStats: true } }];
  reg("indicator.add", (a) => ({ id: `${a.type}2`, type: a.type, cellId: "c1" }));
  reg("indicator.remove", (a) => ({ removed: a.id }));
  reg("indicator.set", (a) => ({ id: a.id }));
  reg("drawing.add", () => ({ id: "d1", tool: "segment" }));
  reg("drawing.remove", (a) => ({ removed: a.id }));
  reg("backtest.config.get", () => ({ longEntry: { combine: "AND", rules: [] }, costs: { quantity: 1 } }));
  reg("backtest.config.set", (a) => a.patch);
  reg("chart.timeframe.set", (a) => { focus.resolution = String(a.resolution) === "1D" ? "DAY" : String(a.resolution); return {}; });
  // Like the real jumpToEpic: the focused-chart provider re-points a render later.
  reg("market.select", (a) => { setTimeout(() => { focus.epic = String(a.epic); focus.cellId = "c9"; }, 120); return {}; });
});

describe("executeTool", () => {
  it("refuses tools outside the allowlist", async () => {
    const r = await executeTool("order_place", {}, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns ActionErrors as is_error results", async () => {
    const r = await executeTool("indicator_set", { id: "NOPE", bogus: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/bogus|INVALID/i);
  });

  it("indicator_add undo removes the new instance", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    expect(r.change!.label).toMatch(/Added RSI/);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["indicator.remove", { id: "RSI2" }]);
  });

  it("indicator_set undo restores calcParams and old extendData values", async () => {
    const r = await executeTool("indicator_set", { id: "TL", extendData: { showStats: false, debug: true } }, ctx);
    await undoTurn([r.change!]);
    const [name, args] = calls.at(-1)!;
    expect(name).toBe("indicator.set");
    expect(args).toEqual({ id: "TL", calcParams: [5, 0, 2], extendData: { showStats: true, debug: undefined } });
  });

  it("indicator_configure merges onto live params and is undoable", async () => {
    liveInstances = [{ id: "R", type: "RSI", calcParams: [14] }];
    const r = await executeTool("indicator_configure", { id: "R", params: { p0: 21 } }, ctx);
    expect(r.isError).toBe(false);
    expect(calls.at(-1)).toEqual(["indicator.set", { id: "R", calcParams: [21] }]);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["indicator.set", { id: "R", calcParams: [14] }]);
  });

  it("indicator_configure reports unknown keys", async () => {
    liveInstances = [{ id: "R", type: "RSI", calcParams: [14] }];
    const r = await executeTool("indicator_configure", { id: "R", params: { length: 21 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/p0/);
  });

  it("drawing_remove undo re-places the full snapshot", async () => {
    const r = await executeTool("drawing_remove", { id: "d1" }, ctx);
    await undoTurn([r.change!]);
    expect(drawings.placeDrawing).toHaveBeenCalledWith(expect.objectContaining({ name: "segment", styles: { line: { size: 3 } } }));
  });

  it("backtest_config_set undo restores only the patched keys", async () => {
    const r = await executeTool("backtest_config_set", { patch: { longEntry: { combine: "OR", rules: [{ expr: "x" }] } } }, ctx);
    await undoTurn([r.change!]);
    expect(calls.at(-1)).toEqual(["backtest.config.set", { patch: { longEntry: { combine: "AND", rules: [] } } }]);
  });

  it("undo runs in reverse order", async () => {
    const a = await executeTool("indicator_add", { type: "RSI" }, ctx);
    const b = await executeTool("drawing_add", { tool: "segment", points: [{ value: 1 }] }, ctx);
    calls.length = 0;
    await undoTurn([a.change!, b.change!]);
    expect(calls.map((c) => c[0])).toEqual(["drawing.remove", "indicator.remove"]);
  });

  it("refuses to undo on another chart", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    focus.cellId = "c2";
    calls.length = 0;
    expect(await undoTurn([r.change!])).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("market_select waits for the focus to settle before returning", async () => {
    focus.epic = "US100";
    const r = await executeTool("market_select", { epic: "GOLD" }, ctx);
    expect(r.isError).toBe(false);
    expect(focus.epic).toBe("GOLD");
    expect(r.change!.cellId).toBe("c9");
  });

  it("a failing undo step reports false", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    clearRegistryForTest();
    expect(await undoTurn([r.change!])).toBe(false);
  });
});
