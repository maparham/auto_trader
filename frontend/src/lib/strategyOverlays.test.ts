import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParamSpec } from "../api";

// customIndicators.ts (imported via indicators.ts) touches klinecharts at module
// load; stub its runtime surface like indicators.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => ["BOLL"], // BOLL is a klinecharts built-in
}));

const { installMemStorage } = await import("./testMemStorage");
installMemStorage();

const { resolveOverlayCalcParams, syncStrategyOverlays } = await import("./strategyOverlays");
const { addIndicatorInstance } = await import("./indicators");
const persist = await import("./persist");

const spec = (name: string, def: number): ParamSpec => ({
  name, label: name, type: "float", default: def,
  min: null, max: null, step: null, options: null, help: null,
});

const BOLL_OVERLAY = { indicator: "BOLL", calc_params: ["bb_period", "bb_dev"] };
const SCHEMA = [spec("bb_period", 20), spec("bb_dev", 3.0)];

describe("resolveOverlayCalcParams", () => {
  it("reads values from the tuned params", () => {
    expect(resolveOverlayCalcParams(BOLL_OVERLAY, { bb_period: 34, bb_dev: 2.5 }, SCHEMA))
      .toEqual([34, 2.5]);
  });

  it("falls back to the schema default for untuned params", () => {
    expect(resolveOverlayCalcParams(BOLL_OVERLAY, { bb_dev: 2.0 }, SCHEMA)).toEqual([20, 2.0]);
    expect(resolveOverlayCalcParams(BOLL_OVERLAY, undefined, SCHEMA)).toEqual([20, 3.0]);
  });

  it("returns null when a named param has no numeric value anywhere", () => {
    expect(resolveOverlayCalcParams(BOLL_OVERLAY, {}, [spec("bb_period", 20)])).toBeNull();
    expect(
      resolveOverlayCalcParams(
        { indicator: "BOLL", calc_params: ["mode"] },
        { mode: "fast" },
        [],
      ),
    ).toBeNull();
  });
});

const { fakeChart } = await import("./testFakeChart");

describe("syncStrategyOverlays", () => {
  beforeEach(() => localStorage.clear());
  const scope = "tab.sync";

  it("creates a tagged managed instance when none exists", () => {
    const { chart, live } = fakeChart();
    const next = syncStrategyOverlays(chart, scope, "US100", [], [
      { indicator: "BOLL", calcParams: [20, 3] },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].type).toBe("BOLL");
    expect(live.some((i) => i.name === next[0].id)).toBe(true);
    const cfg = persist.loadIndicatorConfigs(scope)[next[0].id];
    expect(cfg?.calcParams).toEqual([20, 3]);
    expect(cfg?.extendData?.strategyOverlay).toBe(true);
    expect(persist.loadIndicators(scope).map((i) => i.id)).toEqual(next.map((i) => i.id));
  });

  it("retunes the existing managed instance instead of adding another", () => {
    const { chart, overridden } = fakeChart();
    const first = syncStrategyOverlays(chart, scope, "US100", [], [
      { indicator: "BOLL", calcParams: [20, 3] },
    ]);
    const next = syncStrategyOverlays(chart, scope, "US100", first, [
      { indicator: "BOLL", calcParams: [50, 2] },
    ]);
    expect(next).toEqual(first);
    expect(overridden.some((o) => o.name === first[0].id)).toBe(true);
    expect(persist.loadIndicatorConfigs(scope)[first[0].id]?.calcParams).toEqual([50, 2]);
  });

  it("removes managed instances when no overlays are desired", () => {
    const { chart, live } = fakeChart();
    const first = syncStrategyOverlays(chart, scope, "US100", [], [
      { indicator: "BOLL", calcParams: [20, 3] },
    ]);
    const next = syncStrategyOverlays(chart, scope, "US100", first, []);
    expect(next).toEqual([]);
    expect(live).toHaveLength(0);
    expect(persist.loadIndicators(scope)).toEqual([]);
  });

  it("leaves a user-added BOLL (untagged) alone", () => {
    const { chart, live } = fakeChart();
    const user = addIndicatorInstance(chart, scope, "US100", "BOLL");
    expect(user).not.toBeNull();
    const current = [user!];
    persist.saveIndicators(scope, current);

    const withManaged = syncStrategyOverlays(chart, scope, "US100", current, [
      { indicator: "BOLL", calcParams: [20, 3] },
    ]);
    expect(withManaged).toHaveLength(2); // user's + managed

    const cleared = syncStrategyOverlays(chart, scope, "US100", withManaged, []);
    expect(cleared).toEqual(current); // only the managed one went away
    expect(live.some((i) => i.name === user!.id)).toBe(true);
  });
});
