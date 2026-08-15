// @vitest-environment jsdom
//
// Chart-level strategy overlay sync: the hook keeps the managed BOLL band in
// step with the persisted backtest config + coded params, independent of the
// settings modal's lifecycle — so writers outside the modal (agent bridge
// backtest.config.set, preset restores) retune the band too.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => ["BOLL"],
}));

const mockStrategies = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchStrategies: (...args: unknown[]) => mockStrategies(...args),
  };
});

import { useStrategyOverlaySync, resetStrategyMetaCache } from "./useStrategyOverlaySync";
import { liveStateSignal } from "../lib/liveController";
import { armSnapshot, initialLiveState, appendLog } from "../lib/liveState";
import { ChartController } from "../lib/chartController";
import { fakeChart } from "../lib/testFakeChart";
import { syncStrategyOverlays } from "../lib/strategyOverlays";
import { saveCodedCfg, defaultCodedCfg } from "../lib/codedConfig";
import { saveBacktestLastUsed } from "../lib/persist/defaults";
import { defaultBacktestConfig } from "../lib/backtestConfig";
import { backtestConfigLive } from "../lib/signals";
import type { StrategyInfo, ParamSpec } from "../api";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  mockStrategies.mockReset();
  resetStrategyMetaCache();
  backtestConfigLive.set(null);
  liveStateSignal.set(initialLiveState(defaultBacktestConfig(), "acct", 1));
});

const spec = (name: string, def: number): ParamSpec => ({
  name, label: name, type: "float", default: def,
  min: 1, max: 500, step: null, options: null, help: null,
});

const BB_STRAT: StrategyInfo = {
  filename: "bb_regime_breakout.py",
  name: "BB Regime Breakout",
  description: "",
  hedged: false,
  error: null,
  params: [spec("bb_period", 20), spec("bb_dev", 3.0)],
  chart_overlays: [{ indicator: "BOLL", calc_params: ["bb_period", "bb_dev"] }],
};

const CODED_CFG = {
  ...defaultBacktestConfig(),
  mode: "coded" as const,
  codedStrategy: "bb_regime_breakout.py",
};

function Harness({ controller }: { controller: ChartController }) {
  useStrategyOverlaySync(controller, "TEST");
  return null;
}

function setup(scope: string) {
  const { chart, live } = fakeChart();
  const controller = new ChartController("cell1", scope);
  controller.chart = chart;
  return { chart, live, controller };
}

const bolls = (live: { name: string }[]) => live.filter((i) => i.name.startsWith("BOLL"));

describe("useStrategyOverlaySync", () => {
  it("creates the band from the persisted config and params on mount", async () => {
    mockStrategies.mockResolvedValue([BB_STRAT]);
    saveBacktestLastUsed(CODED_CFG);
    saveCodedCfg("backtest", "bb_regime_breakout.py", {
      ...defaultCodedCfg(), params: { bb_dev: 1.5 },
    });
    const { live, controller } = setup("tab.hook-mount");

    render(<Harness controller={controller} />);

    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([20, 1.5]));
    expect(controller.indicators.value.some((i) => i.type === "BOLL")).toBe(true);
  });

  it("retunes when coded params are written to storage (preset restore, bridge)", async () => {
    mockStrategies.mockResolvedValue([BB_STRAT]);
    saveBacktestLastUsed(CODED_CFG);
    const { live, controller } = setup("tab.hook-params");
    render(<Harness controller={controller} />);
    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([20, 3.0]));

    saveCodedCfg("backtest", "bb_regime_breakout.py", {
      ...defaultCodedCfg(), params: { bb_period: 50, bb_dev: 2.0 },
    });

    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([50, 2.0]));
    expect(bolls(live)).toHaveLength(1); // retuned, not duplicated
  });

  it("follows the live panel config and removes the band when mode flips to rules", async () => {
    mockStrategies.mockResolvedValue([BB_STRAT]);
    saveBacktestLastUsed(CODED_CFG);
    const { live, controller } = setup("tab.hook-live");
    render(<Harness controller={controller} />);
    await waitFor(() => expect(bolls(live)).toHaveLength(1));

    backtestConfigLive.set({ ...CODED_CFG, mode: "rules" });

    await waitFor(() => expect(bolls(live)).toHaveLength(0));
  });

  it("removes the band when the persisted config switches strategy (bridge write)", async () => {
    const plain: StrategyInfo = {
      ...BB_STRAT, filename: "plain.py", name: "Plain", chart_overlays: [],
    };
    mockStrategies.mockResolvedValue([BB_STRAT, plain]);
    saveBacktestLastUsed(CODED_CFG);
    const { live, controller } = setup("tab.hook-switch");
    render(<Harness controller={controller} />);
    await waitFor(() => expect(bolls(live)).toHaveLength(1));

    saveBacktestLastUsed({ ...CODED_CFG, codedStrategy: "plain.py" });

    await waitFor(() => expect(bolls(live)).toHaveLength(0));
  });

  it("keeps an existing band while the strategy list is still loading", async () => {
    mockStrategies.mockReturnValue(new Promise(() => {})); // never resolves
    saveBacktestLastUsed(CODED_CFG);
    const { chart, live, controller } = setup("tab.hook-pending");
    controller.indicators.set(syncStrategyOverlays(chart, "tab.hook-pending", "TEST", [], [
      { indicator: "BOLL", calcParams: [20, 3.0] },
    ]));
    expect(bolls(live)).toHaveLength(1);

    render(<Harness controller={controller} />);
    await new Promise((r) => setTimeout(r, 50));

    expect(bolls(live)).toHaveLength(1);
  });

  // While a live coded strategy is ARMED, the band shows what the engine
  // actually trades: the frozen snapshot's params — not the backtest panel's
  // selection. Disarming falls back to the backtest source.
  it("armed live strategy wins over the backtest selection, disarm falls back", async () => {
    mockStrategies.mockResolvedValue([BB_STRAT]);
    saveBacktestLastUsed(CODED_CFG); // backtest tuned to defaults (20, 3.0)
    const { live, controller } = setup("tab.hook-armed");
    render(<Harness controller={controller} />);
    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([20, 3.0]));

    const armedDraft = { ...CODED_CFG };
    liveStateSignal.set(armSnapshot(
      initialLiveState(armedDraft, "acct", 1), "BB Regime Breakout", 0,
      { ...defaultCodedCfg(), params: { bb_period: 34, bb_dev: 2.0 } },
    ));

    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([34, 2.0]));
    expect(bolls(live)).toHaveLength(1);

    liveStateSignal.set(initialLiveState(defaultBacktestConfig(), "acct", 1));
    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([20, 3.0]));
  });

  // liveStateSignal fires on every engine log tick and draft keystroke; the
  // sync must only re-resolve its source when (status, snapshot) actually
  // changed — not pay storage reads per tick, per mounted cell.
  it("ignores live-state mutations that keep status and snapshot unchanged", async () => {
    mockStrategies.mockResolvedValue([BB_STRAT]);
    saveBacktestLastUsed(CODED_CFG);
    const { chart, live, controller } = setup("tab.hook-livetick");
    render(<Harness controller={controller} />);
    await waitFor(() => expect(bolls(live)).toHaveLength(1));

    let calls = 0;
    const orig = chart.getIndicators.bind(chart);
    (chart as { getIndicators: typeof chart.getIndicators }).getIndicators = (...a) => {
      calls += 1;
      return orig(...a);
    };
    for (let i = 0; i < 5; i += 1) {
      liveStateSignal.set(appendLog(liveStateSignal.value, i, `tick ${i}`));
    }
    expect(calls).toBe(0); // no sync ran: same status, same snapshot

    liveStateSignal.set(armSnapshot(
      liveStateSignal.value.draft === CODED_CFG
        ? liveStateSignal.value
        : { ...liveStateSignal.value, draft: CODED_CFG },
      "BB Regime Breakout", 0,
      { ...defaultCodedCfg(), params: { bb_period: 40, bb_dev: 2.0 } },
    ));
    await waitFor(() => expect(bolls(live)[0]?.calcParams).toEqual([40, 2.0]));
  });

  it("keeps an existing band when the strategy list fetch fails", async () => {
    mockStrategies.mockRejectedValue(new Error("backend down"));
    saveBacktestLastUsed(CODED_CFG);
    const { chart, live, controller } = setup("tab.hook-failed");
    controller.indicators.set(syncStrategyOverlays(chart, "tab.hook-failed", "TEST", [], [
      { indicator: "BOLL", calcParams: [20, 3.0] },
    ]));

    render(<Harness controller={controller} />);
    await new Promise((r) => setTimeout(r, 50));

    expect(bolls(live)).toHaveLength(1);
  });
});
