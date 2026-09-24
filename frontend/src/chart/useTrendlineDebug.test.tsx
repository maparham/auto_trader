// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { applyDebugChanges, useTrendlineDebug } from "./useTrendlineDebug";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import { runDebugSync, type DebugRunInput } from "../lib/indicators/trendlinesDebug";
import { explain } from "../lib/indicators/trendlinesDebugExplain";
import { debugState } from "../lib/indicators/trendlinesDebugStore";
import { synthBars } from "../lib/indicators/trendlinesSynth.testutil";

// Never resolves: under a pinned timeframe the live calcParams only change
// after the bar fetch, so the live instance below stays on its old values.
vi.mock("../lib/mtfCoordinator", () => ({ applyTrendlinesTimeframe: vi.fn(() => new Promise(() => {})) }));
const saved: Record<string, unknown> = {};
vi.mock("../lib/persist", () => ({
  loadIndicatorConfigs: () => ({ TL: saved.TL ?? { calcParams: Object.values(TRENDLINES_DEFAULTS) } }),
  saveIndicatorConfig: (_s: string, name: string, cfg: unknown) => { saved[name] = cfg; },
}));

describe("applyDebugChanges", () => {
  it("undo restores previous calcParams", async () => {
    const live = { calcParams: Object.values(TRENDLINES_DEFAULTS), extendData: {} };
    const chart = { getIndicators: () => [live] } as never;
    const ctx = { chart, scope: "s", epic: "E", brokerId: "b", paneId: "candle_pane", name: "TL" };
    const prev = applyDebugChanges(ctx, [{ field: "minTouches", from: 2, to: 3, pool: false }]);
    expect((saved.TL as { calcParams: number[] }).calcParams[2]).toBe(3);
    applyDebugChanges(ctx, null, prev);
    expect((saved.TL as { calcParams: number[] }).calcParams).toEqual(prev);
  });
  it("two applies back to back keep both changes while the live instance is stale", () => {
    delete saved.TL;
    const defaults = Object.values(TRENDLINES_DEFAULTS);
    const live = { calcParams: defaults.slice(), extendData: { mtf: { timeframe: "HOUR_4" } } };
    const chart = { getIndicators: () => [live] } as never;
    const ctx = { chart, scope: "s", epic: "E", brokerId: "b", paneId: "candle_pane", name: "TL" };
    const slots = Object.keys(TRENDLINES_DEFAULTS);
    const iTouch = slots.indexOf("minTouches");
    const iLines = slots.indexOf("maxLines");
    const first = applyDebugChanges(ctx, [{ field: "minTouches", from: 2, to: 3, pool: false }]);
    applyDebugChanges(ctx, [{ field: "maxLines", from: TRENDLINES_DEFAULTS.maxLines, to: 7, pool: false }]);
    const cp = (saved.TL as { calcParams: number[] }).calcParams;
    expect(cp[iTouch]).toBe(3);
    expect(cp[iLines]).toBe(7);
    applyDebugChanges(ctx, null, first);
    expect((saved.TL as { calcParams: number[] }).calcParams).toEqual(defaults);
  });
});

describe("useTrendlineDebug", () => {
  it("a line from the SECOND debug-on instance opens its popup", () => {
    const inds = [
      { name: "TL_A", extendData: { debug: true } },
      { name: "TL_B", extendData: { debug: true } },
    ];
    const chart = {
      getIndicators: (f: { name?: string }) => (f.name ? inds.filter((i) => i.name === f.name) : inds),
      overrideIndicator: vi.fn(),
    };
    const bars = synthBars(600);
    const input: DebugRunInput = {
      bars, cfg: { ...TRENDLINES_DEFAULTS, minTouches: 4 }, startIdx: 0, evalIdx: 599, window: [0, 599], forced: [],
    };
    const e = debugState(chart, "TL_B");
    e.result = explain(runDebugSync(input));
    e.input = input;
    e.key = "k";
    const cand = e.result.candidates.find((c) => !c.drawn)!;
    const { result, unmount } = renderHook(() => useTrendlineDebug({
      chartRef: { current: chart as never }, containerRef: { current: null }, overlays: {} as never,
      scope: "s", epicRef: { current: "E" }, brokerIdRef: { current: "b" },
    }));
    act(() => {
      result.current.openFor({ paneId: "candle_pane", name: "TL_B", seg: { key: `dbg:${cand.key}` } } as never, 10, 10);
    });
    expect(result.current.popup).not.toBeNull();
    unmount();
  });
});
