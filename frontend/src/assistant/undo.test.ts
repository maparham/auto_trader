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
// Distinct from liveInstances: a pane can be tracked here (persisted
// bookkeeping, survives even when not drawn) without yet appearing in
// liveExprInstances (which only sees what klinecharts has actually computed).
let controllerIndicators: Array<{ id: string; type: string; inset?: boolean }> = [];
let dataList: Array<{ timestamp: number; close: number }> = [];
let savedConfigs: Record<string, { calcParams?: number[]; extendData?: unknown }> = {};

vi.mock("../agent/actions/chart", () => ({
  focusedChart: () => ({ ...focus, chart: { getDataList: () => dataList }, controller: { indicators: { value: controllerIndicators } } }),
  agentPeriod: (s: string) => ({ resolution: s === "1D" ? "DAY" : s }),
}));
vi.mock("../agent/actions/drawings", () => ({
  focusedDrawings: () => ({ overlays: drawings, epic: focus.epic, cellId: focus.cellId }),
}));
// indicator_values reads klinecharts' per-bar results off the pane.
let panes = new Map<string, Map<string, { result?: unknown[] }>>();
vi.mock("../lib/indicators", () => ({ liveExprInstances: () => liveInstances, getIndicatorsByPane: () => panes }));
vi.mock("../lib/persist/artifacts", () => ({ loadIndicatorConfigs: () => savedConfigs }));
vi.mock("../lib/notify", () => ({ toast: vi.fn() }));
// The broker's symbol search: market_select only opens epics it returns.
const searchInstruments = vi.fn(async (q: string, _broker?: string) =>
  [{ epic: q.toUpperCase(), name: q, status: "TRADEABLE", type: "COMMODITIES", pricePrecision: 2 }]);
vi.mock("../lib/feed/instruments", () => ({ searchInstruments: (q: string, b?: string) => searchInstruments(q, b) }));
vi.mock("../lib/feed/common", () => ({ DEFAULT_BROKER: "capital" }));

const drawings = {
  getDrawing: vi.fn((id: string) => (id === "d1" ? { name: "segment", points: [], styles: { line: { size: 3 } }, lock: false, visible: true, zLevel: 0, extendData: {} } : null)),
  placeDrawing: vi.fn(() => "d9"),
};

import { clearRegistryForTest, registerAction } from "../agent/registry";
import { executeTool, undoTurn, redoTurn } from "./undo";

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
  drawings.getDrawing.mockClear();
  drawings.placeDrawing.mockClear();
  focus.cellId = "c1";
  focus.epic = "US100";
  liveInstances = [{ id: "TL", type: "TRENDLINES", calcParams: [5, 0, 2], extendData: { showStats: true } }];
  controllerIndicators = [{ id: "TL", type: "TRENDLINES", inset: false }];
  savedConfigs = {};
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
    expect(r.change!.label).toMatch(/Added Relative Strength Index \(RSI2\)/);
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

  it("indicator_configure labels the change with titles, not codes", async () => {
    liveInstances = [{ id: "R", type: "RSI", calcParams: [14] }];
    const r = await executeTool("indicator_configure", { id: "R", params: { p0: 21 } }, ctx);
    expect(r.change!.label).not.toMatch(/\bRSI\b|p0/);
    expect(r.change!.label).toMatch(/^Relative Strength Index: /);
    // The card shows the value, not just the setting's name.
    expect(r.change!.label).toMatch(/ 14 to 21$/);
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

  it("market_select refuses an epic the broker's search does not return", async () => {
    focus.epic = "US100";
    searchInstruments.mockResolvedValueOnce([{ epic: "US10YR", name: "US 10-Year", status: "TRADEABLE", type: "RATES", pricePrecision: 3 }]);
    const n = calls.length;
    const r = await executeTool("market_select", { epic: "US10Y" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/NOT_FOUND.*symbol_search/);
    expect(calls.length).toBe(n);
    expect(focus.epic).toBe("US100");
  });

  it("symbol_search returns the broker's matches", async () => {
    searchInstruments.mockResolvedValueOnce([{ epic: "US10YR", name: "US 10-Year", status: "TRADEABLE", type: "RATES", pricePrecision: 3 }]);
    const r = await executeTool("symbol_search", { query: "10 year" }, ctx);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).results[0]).toMatchObject({ epic: "US10YR", name: "US 10-Year" });
    expect(r.change).toBeUndefined();
  });

  it("a failing undo step reports false", async () => {
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    clearRegistryForTest();
    expect(await undoTurn([r.change!])).toBe(false);
  });

  // --- fix round 1 -----------------------------------------------------

  // Finding 1: a partial undo (refused midway) must not re-run reverts that
  // already succeeded when the user fixes focus and retries.
  it("marks a reverted change so a retried undo does not re-run it", async () => {
    const a = await executeTool("indicator_add", { type: "RSI" }, ctx); // captured on c1
    focus.cellId = "c2";
    const b = await executeTool("indicator_add", { type: "EMA" }, ctx); // captured on c2
    calls.length = 0;
    // Undo attempted while still focused on c2: b (c2) reverts; a (c1) is refused.
    expect(await undoTurn([a.change!, b.change!])).toBe(false);
    expect(calls).toEqual([["indicator.remove", { id: "EMA2" }]]);
    // Fix focus and retry: only a's revert should run now; b must not re-run.
    focus.cellId = "c1";
    expect(await undoTurn([a.change!, b.change!])).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["indicator.remove", "indicator.remove"]);
    expect(calls[1]).toEqual(["indicator.remove", { id: "RSI2" }]);
  });

  // Finding 2: a cellId match alone isn't enough — the same cell can be
  // re-pointed at a different symbol (drawings/indicators are per epic).
  it("refuses to undo when the epic changed on the same cell", async () => {
    const r = await executeTool("drawing_remove", { id: "d1" }, ctx);
    focus.epic = "GOLD"; // same cellId, different symbol
    calls.length = 0;
    expect(await undoTurn([r.change!])).toBe(false);
    expect(calls).toHaveLength(0);
    expect(drawings.placeDrawing).not.toHaveBeenCalled();
  });

  // Finding 3: indicator.remove undo falls back to the persisted config when
  // the pane never computed (liveExprInstances misses it).
  it("indicator_remove falls back to persisted config when the pane isn't live", async () => {
    liveInstances = []; // not drawn/computed
    controllerIndicators = [{ id: "HIDDEN1", type: "SLOPE", inset: true }];
    savedConfigs = { HIDDEN1: { calcParams: [9], extendData: { foo: 1 } } };
    const r = await executeTool("indicator_remove", { id: "HIDDEN1" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.change!.undo).toBeDefined();
    expect(r.change!.label).not.toMatch(/cannot undo/i);
    await undoTurn([r.change!]);
    const addCall = calls.find((c) => c[0] === "indicator.add");
    expect(addCall).toBeDefined();
    expect(addCall![1]).toEqual({ type: "SLOPE", calcParams: [9], inset: true });
  });

  // Finding 3 (continued): when nothing at all can be recovered, the change
  // is explicitly marked non-undoable (its label already says so) so it does
  // not block the rest of the turn forever — undoTurn skips it rather than
  // treating it as an unexpected failure.
  it("indicator_remove cannot undo when nothing can be captured", async () => {
    liveInstances = [];
    controllerIndicators = [];
    savedConfigs = {};
    const r = await executeTool("indicator_remove", { id: "GHOST" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.change!.undo).toBeUndefined();
    expect(r.change!.undoable).toBe(false);
    expect(r.change!.label).toMatch(/cannot undo/i);
    expect(await undoTurn([r.change!])).toBe(true);
  });

  // Finding 4: undo-by-id must never be offered when the new id already
  // named one of the user's own panes.
  it("indicator_add gives no undo when the new id collides with an existing pane", async () => {
    controllerIndicators = [{ id: "RSI2", type: "RSI", inset: false }];
    const r = await executeTool("indicator_add", { type: "RSI" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.change!.undo).toBeUndefined();
    expect(r.change!.undoable).toBe(false);
    expect(r.change!.label).toMatch(/cannot undo/i);
    expect(await undoTurn([r.change!])).toBe(true);
  });

  // Finding (M1): a change explicitly marked non-undoable at capture must not
  // block the rest of the turn from being reverted.
  it("a cannot-undo change does not block the rest of the turn from being undone", async () => {
    controllerIndicators = [{ id: "RSI2", type: "RSI", inset: false }];
    const collided = await executeTool("indicator_add", { type: "RSI" }, ctx); // id collides, undoable: false
    controllerIndicators = [];
    const ok = await executeTool("indicator_add", { type: "EMA" }, ctx); // normally undoable
    calls.length = 0;
    expect(await undoTurn([collided.change!, ok.change!])).toBe(true);
    expect(calls).toEqual([["indicator.remove", { id: "EMA2" }]]);
  });

  // M5: validate_rule reads the backtest config's picked lines (same source
  // the backtest panel reads from) so a bare L<n> ref is checked rather than
  // left unchecked.
  it("validate_rule checks a picked-line ref against the backtest config's lines", async () => {
    clearRegistryForTest();
    reg("backtest.config.get", () => ({ lines: { L1: {} } }));
    const ok = await executeTool("validate_rule", { expr: "candle.close x> L1" }, ctx);
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content)).toMatchObject({ ok: true });
    const bad = await executeTool("validate_rule", { expr: "candle.close x> L2" }, ctx);
    const parsed = JSON.parse(bad.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].message).toMatch(/L2 is not one of this rule's lines/);
  });

  // Finding 5: a chart that never settles must not fail silently.
  it("warns in the result content when the chart does not settle in time", async () => {
    vi.useFakeTimers();
    try {
      clearRegistryForTest();
      reg("market.select", () => ({})); // never updates focus - simulates a stuck UI
      const p = executeTool("market_select", { epic: "GOLD" }, ctx);
      await vi.advanceTimersByTimeAsync(2100);
      const r = await p;
      expect(r.isError).toBe(false);
      expect(r.content).toMatch(/did not switch within 2 s/i);
      expect(focus.epic).toBe("US100");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("redoTurn", () => {
  it("replays recorded calls in order and remaps an id the add hands back differently", async () => {
    const changes = [
      { label: "Added RSI", cellId: "c1", epic: "US100", createdId: "RSI7", replay: { tool: "indicator_add", input: { type: "RSI" } } },
      { label: "Changed RSI settings", cellId: "c1", epic: "US100", replay: { tool: "indicator_set", input: { id: "RSI7", calcParams: [21] } } },
    ];
    liveInstances = [...liveInstances, { id: "RSI2", type: "RSI", calcParams: [14] }];
    calls.length = 0;
    const r = await redoTurn(changes);
    expect(r.ok).toBe(true);
    expect(r.ids).toEqual({ RSI7: "RSI2" });
    expect(calls.map((c) => c[0])).toEqual(["indicator.add", "indicator.set"]);
    expect(calls[1][1]).toMatchObject({ id: "RSI2", calcParams: [21] });
    expect(r.changes).toHaveLength(2);
    expect(r.changes[1].replay!.input).toMatchObject({ id: "RSI2" });
    expect(typeof r.changes[0].undo).toBe("function");
  });

  it("undo then redo of a remove targets the re-created pane, not the vanished id", async () => {
    const r = await executeTool("indicator_remove", { id: "TL" }, ctx);
    const change = { ...r.change!, replay: { tool: "indicator_remove", input: { id: "TL" } } };
    await undoTurn([change]);
    expect(change.restoredId).toBe("TRENDLINES2");
    controllerIndicators = [...controllerIndicators, { id: "TRENDLINES2", type: "TRENDLINES", inset: false }];
    calls.length = 0;
    const red = await redoTurn([change]);
    expect(red.ok).toBe(true);
    expect(red.ids).toEqual({});
    expect(calls[0]).toEqual(["indicator.remove", { id: "TRENDLINES2" }]);
  });

  it("refuses on another chart without running anything", async () => {
    calls.length = 0;
    const r = await redoTurn([{ label: "Drew a segment", cellId: "c2", epic: "US100", replay: { tool: "drawing_add", input: { tool: "segment" } } }]);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("indicator_values", () => {
  it("returns a pane's per-bar numbers aligned to candles, windowed and read-only", async () => {
    dataList = [1, 2, 3, 4].map((i) => ({ timestamp: i * 1000, close: 100 + i }));
    panes = new Map([["p1", new Map([["RSI", { result: [{ rsi1: 55.123456 }, { rsi1: 29.5 }, { rsi1: NaN }, { rsi1: 40 }] }]])]]);
    calls.length = 0;
    const r = await executeTool("indicator_values", { id: "RSI", from: 2000, to: 3000 }, ctx);
    expect(r.isError).toBe(false);
    expect(r.change).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(JSON.parse(r.content).rows).toEqual([{ t: 2000, close: 102, rsi1: 29.5 }, { t: 3000, close: 103 }]);
  });

  it("drops the oldest rows to fit the result cap instead of cutting the JSON", async () => {
    dataList = Array.from({ length: 300 }, (_, i) => ({ timestamp: 1e12 + i, close: 20000 + i }));
    panes = new Map([["p1", new Map([["RSI", { result: dataList.map(() => ({ rsi1: 33.3333, rsi2: 44.4444 })) }]])]]);
    const r = await executeTool("indicator_values", { id: "RSI", bars: 300 }, ctx);
    const parsed = JSON.parse(r.content);
    expect(parsed.rows.at(-1).t).toBe(1e12 + 299);
    expect(parsed.omittedOlder).toBeGreaterThan(0);
  });

  it("reports an unknown pane", async () => {
    panes = new Map();
    const r = await executeTool("indicator_values", { id: "NOPE" }, ctx);
    expect(r.isError).toBe(true);
  });
});
