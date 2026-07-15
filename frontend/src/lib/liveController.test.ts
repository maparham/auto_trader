import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

// liveController pulls in liveEngine -> backtestSeries -> customIndicators,
// which reads LineType at module load (same stub other lib tests use).
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const fetchStrategiesMock = vi.fn();
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchStrategies: (...args: unknown[]) => fetchStrategiesMock(...args),
  };
});

vi.mock("./feed", () => ({
  fetchRecent: vi.fn().mockResolvedValue([
    { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
  ]),
}));

const armLiveEngineMock = vi.fn().mockReturnValue({ disarm: vi.fn() });
vi.mock("./liveEngine", async () => {
  const actual = await vi.importActual<typeof import("./liveEngine")>("./liveEngine");
  return {
    ...actual,
    armLiveEngine: (...args: unknown[]) => armLiveEngineMock(...args),
    saveArmed: vi.fn(),
    loadArmed: vi.fn().mockReturnValue(null),
    saveArmedAccount: vi.fn(),
    loadArmedAccount: vi.fn().mockReturnValue(null),
  };
});

import { defaultBacktestConfig } from "./backtestConfig";
import { saveCodedCfg, defaultCodedCfg } from "./codedConfig";
import type { ParamSpec } from "../api";

const paramSpec = (over: Partial<ParamSpec> = {}): ParamSpec => ({
  name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
  min: 2, max: 50, step: 1, options: null, help: null, ...over,
});

beforeEach(() => {
  localStorage.clear();
  fetchStrategiesMock.mockReset();
  armLiveEngineMock.mockClear();
});

describe("arm() coded param resolution (I3)", () => {
  it("freezes the resolved (schema-clamped) param values into the snapshot, not the raw stored ones", async () => {
    fetchStrategiesMock.mockResolvedValue([
      { filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
        params: [paramSpec()] },
    ]);
    // Stale stored value is out of the CURRENT schema's range — this is exactly
    // the case that used to 422 every live evaluate cycle (I3).
    saveCodedCfg("live", "ema_cross.py", { ...defaultCodedCfg(), params: { ema_fast: 999 } });

    const { initLive, arm, liveStateSignal } = await import("./liveController");
    initLive({ epic: "EURUSD", resolution: "MINUTE", brokerId: "capital", account: "capital:demo" });
    const cfg = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    const { setDraft } = await import("./liveController");
    setDraft(cfg);

    await arm();

    const snap = liveStateSignal.value.snapshot;
    expect(snap?.coded?.params).toEqual({ ema_fast: 9 }); // clamped back to default, not 999
  });

  it("keeps a valid stored value unchanged", async () => {
    fetchStrategiesMock.mockResolvedValue([
      { filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
        params: [paramSpec()] },
    ]);
    saveCodedCfg("live", "ema_cross.py", { ...defaultCodedCfg(), params: { ema_fast: 15 } });

    const { initLive, arm, setDraft, liveStateSignal } = await import("./liveController");
    initLive({ epic: "EURUSD", resolution: "MINUTE", brokerId: "capital", account: "capital:demo" });
    setDraft({ ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" });

    await arm();

    expect(liveStateSignal.value.snapshot?.coded?.params).toEqual({ ema_fast: 15 });
  });
});
