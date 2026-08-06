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

describe("arm() indicator references", () => {
  const PANE = { id: "SLOPE", type: "SLOPE", calcParams: [50], extendData: {} };
  const refRow = { expr: "SLOPE.slope0 > 0.5", enabled: true };
  const cfgWithRef = () => ({
    ...defaultBacktestConfig(),
    longEntry: { combine: "AND" as const, rules: [refRow] },
  });

  async function panel() {
    const mod = await import("./liveController");
    // The controller is a module singleton and initLive is a no-op while armed,
    // so a previous test's arm would otherwise leak into this one.
    mod.disarm();
    mod.initLive({ epic: "EURUSD", resolution: "MINUTE", brokerId: "capital", account: "capital:demo" });
    return mod;
  }

  it("freezes the referenced pane into the snapshot", async () => {
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft(cfgWithRef());
    await arm([PANE]);
    expect(liveStateSignal.value.status).toBe("armed");
    expect(liveStateSignal.value.snapshot?.indicators).toEqual({
      SLOPE: { type: "SLOPE", calcParams: [50], extendData: {} },
    });
  });

  it("REFUSES to arm when a rule references a pane that isn't on the chart", async () => {
    // The alternative is arming something that 422s the evaluate route on every
    // bar, exit rules included — an open position with nothing able to close it.
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft(cfgWithRef());
    await arm([]); // e.g. no chart focused, or the pane was deleted
    expect(liveStateSignal.value.status).not.toBe("armed");
    expect(liveStateSignal.value.log.at(-1)?.text).toContain("SLOPE");
    expect(liveStateSignal.value.log.at(-1)?.text).toContain("not on the chart");
  });

  // A pinned pane resolves `SLOPE.slope0` to its HIGHER-timeframe series with no
  // `@tf` in the rule text, and the live evaluate route has no way to source those
  // bars (it reads req.htfCandles, which the live engine never sends). Arming
  // would produce an all-None operand and a rule that never fires — silently.
  const PINNED = { ...PANE, extendData: { mtf: { timeframe: "HOUR_4" } } };

  it("REFUSES to arm when a referenced pane is PINNED to a higher timeframe", async () => {
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft(cfgWithRef());
    await arm([PINNED]);
    expect(liveStateSignal.value.status).not.toBe("armed");
    expect(liveStateSignal.value.log.at(-1)?.text).toContain("SLOPE");
    expect(liveStateSignal.value.log.at(-1)?.text).toContain("HOUR_4");
  });

  it("arms when the pane is present and UNPINNED (mtf.timeframe null)", async () => {
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft(cfgWithRef());
    await arm([{ ...PANE, extendData: { mtf: { timeframe: null } } }]);
    expect(liveStateSignal.value.status).toBe("armed");
  });

  it("ignores a DISABLED row's reference — it never reaches the backend", async () => {
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft({
      ...defaultBacktestConfig(),
      longEntry: { combine: "AND", rules: [{ ...refRow, enabled: false }] },
    });
    await arm([]);
    expect(liveStateSignal.value.status).toBe("armed");
  });

  it("a config with no references arms with no map at all", async () => {
    const { arm, setDraft, liveStateSignal } = await panel();
    setDraft(defaultBacktestConfig());
    await arm([PANE]);
    expect(liveStateSignal.value.status).toBe("armed");
    expect(liveStateSignal.value.snapshot?.indicators).toBeUndefined();
  });

  // CODED mode executes the coded set's PANEL EXITS, not the draft's rule-mode
  // groups — which are dormant. Collecting from the wrong groups shipped {} for
  // a coded panel exit referencing a pane, reproducing the per-bar 422 this
  // whole guard exists to prevent, and the refusal check missed it too.
  describe("coded mode reads the coded set's panel exits", () => {
    async function codedPanel() {
      fetchStrategiesMock.mockResolvedValue([
        { filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false,
          error: null, params: [] },
      ]);
      const mod = await panel();
      return mod;
    }
    const codedDraft = () => ({
      ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py",
    });

    it("freezes a pane referenced by a coded PANEL EXIT", async () => {
      saveCodedCfg("live", "ema_cross.py", {
        ...defaultCodedCfg(),
        longExit: { combine: "AND", rules: [refRow] },
      });
      const { arm, setDraft, liveStateSignal } = await codedPanel();
      setDraft(codedDraft());
      await arm([PANE]);
      expect(liveStateSignal.value.status).toBe("armed");
      expect(liveStateSignal.value.snapshot?.indicators).toHaveProperty("SLOPE");
    });

    it("refuses when that exit's pane isn't on the chart", async () => {
      saveCodedCfg("live", "ema_cross.py", {
        ...defaultCodedCfg(),
        longExit: { combine: "AND", rules: [refRow] },
      });
      const { arm, setDraft, liveStateSignal } = await codedPanel();
      setDraft(codedDraft());
      await arm([]);
      expect(liveStateSignal.value.status).not.toBe("armed");
      expect(liveStateSignal.value.log.at(-1)?.text).toContain("SLOPE");
    });

    it("IGNORES a reference sitting in the dormant rule-mode groups", async () => {
      // Those rows are never sent in coded mode, so requiring their pane would
      // refuse a perfectly valid arm.
      saveCodedCfg("live", "ema_cross.py", defaultCodedCfg());
      const { arm, setDraft, liveStateSignal } = await codedPanel();
      setDraft({ ...codedDraft(), longEntry: { combine: "AND", rules: [refRow] } });
      await arm([]);
      expect(liveStateSignal.value.status).toBe("armed");
      expect(liveStateSignal.value.snapshot?.indicators).toBeUndefined();
    });

    it("IGNORES a PINNED pane named only by the dormant rule-mode groups", async () => {
      // Same rationale as the case above: coded mode never sends those rows, so a
      // pin on a pane they name can't reach the backend and must not block arming.
      // Keying the pin check off the executed rows (not the pane list) gives this.
      saveCodedCfg("live", "ema_cross.py", defaultCodedCfg());
      const { arm, setDraft, liveStateSignal } = await codedPanel();
      setDraft({ ...codedDraft(), longEntry: { combine: "AND", rules: [refRow] } });
      await arm([PINNED]);
      expect(liveStateSignal.value.status).toBe("armed");
    });
  });
});
