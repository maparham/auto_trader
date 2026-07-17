import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

// templates.ts (imported transitively) statically imports ./indicators, which
// loads klinecharts enums unavailable in the node test env. Stub it — the
// autosave tests only exercise capture/compare, not real indicator application.
vi.mock("./indicators", () => {
  let seq = 0;
  return {
    applyIndicator: vi.fn(() => "pane_x"),
    mintInstanceId: vi.fn((_c: unknown, t: string) => `${t}#m${++seq}`),
    effectiveCalcParams: vi.fn((_t: string, saved?: number[]) => saved),
    isSubPaneIndicator: vi.fn(() => false),
  };
});

installMemStorage();

import {
  sameTemplate,
  maybeAutoSaveTemplate,
  scheduleAutoSave,
  cancelAutoSave,
  flushTemplateCapture,
  flushPendingAutoSaves,
} from "./templateAutosave";
import { saveIndicators, loadSymbolTemplate } from "./persist";
import { loadSettings, saveSettings } from "../theme";

const SCOPE = "cell-1";
const EPIC = "GOLD";

const setAutoSave = (on: boolean) =>
  saveSettings({ ...loadSettings(), autoSaveTemplates: on });

beforeEach(() => {
  localStorage.clear();
  setAutoSave(true);
});

describe("sameTemplate", () => {
  it("ignores savedAt", () => {
    const base = {
      epic: EPIC,
      indicators: [{ id: "EMA#1", type: "EMA" }],
      indicatorConfigs: {},
      drawings: [],
      avwapAnchors: {},
      savedAt: 1,
    };
    expect(sameTemplate(base, { ...base, savedAt: 999 })).toBe(true);
  });
  it("detects an added indicator", () => {
    const a = {
      epic: EPIC,
      indicators: [],
      indicatorConfigs: {},
      drawings: [],
      avwapAnchors: {},
      savedAt: 1,
    };
    const b = { ...a, indicators: [{ id: "EMA#1", type: "EMA" }] };
    expect(sameTemplate(a, b)).toBe(false);
  });
});

describe("maybeAutoSaveTemplate", () => {
  it("writes the captured template when none is stored", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)?.indicators).toEqual([
      { id: "EMA#1", type: "EMA" },
    ]);
  });

  it("does not rewrite when content is unchanged", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    const firstAt = loadSymbolTemplate(EPIC)!.savedAt;
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)!.savedAt).toBe(firstAt);
  });

  it("saves an EMPTY template when the cell is cleared (not delete)", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    saveIndicators(SCOPE, []); // user removed everything
    maybeAutoSaveTemplate(SCOPE, EPIC);
    const t = loadSymbolTemplate(EPIC);
    expect(t).not.toBeNull();
    expect(t!.indicators).toEqual([]);
  });

  it("does nothing when auto-save is off", () => {
    setAutoSave(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    maybeAutoSaveTemplate(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)).toBeNull();
  });
});

describe("scheduleAutoSave / cancelAutoSave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounced save fires after the delay", () => {
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)).toBeNull(); // not yet
    vi.advanceTimersByTime(1000);
    expect(loadSymbolTemplate(EPIC)?.indicators).toEqual([
      { id: "EMA#1", type: "EMA" },
    ]);
  });

  it("cancelAutoSave prevents a pending save from firing", () => {
    // Simulate: a good template exists, an edit schedules a save, then the cell is
    // torn down (cancel) and its scope storage purged before the timer would fire.
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    vi.advanceTimersByTime(1000); // template now holds EMA
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);

    scheduleAutoSave(SCOPE, EPIC); // a later edit schedules another save
    cancelAutoSave(SCOPE, EPIC); // teardown cancels it
    localStorage.removeItem(`auto-trader.${SCOPE}.indicators`); // scope purged
    vi.advanceTimersByTime(1000);
    // The cancelled timer never ran, so the real template is intact (not blanked).
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
  });
});

describe("flushTemplateCapture", () => {
  it("captures immediately even with autoSaveTemplates OFF", () => {
    setAutoSave(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    flushTemplateCapture(SCOPE, EPIC);
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
  });

  it("cancels a pending debounced save for the same scope+epic", () => {
    vi.useFakeTimers();
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushTemplateCapture(SCOPE, EPIC);
    saveIndicators(SCOPE, []); // storage changes after flush...
    vi.runAllTimers(); // ...a surviving timer would capture the empty layout
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("flushPendingAutoSaves", () => {
  it("fires every pending debounced save immediately", () => {
    vi.useFakeTimers();
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushPendingAutoSaves();
    expect(loadSymbolTemplate(EPIC)?.indicators).toHaveLength(1);
    vi.runAllTimers(); // nothing left pending
    vi.useRealTimers();
  });

  it("pending saves keep the setting gate (OFF means no write)", () => {
    vi.useFakeTimers();
    setAutoSave(false);
    saveIndicators(SCOPE, [{ id: "EMA#1", type: "EMA" }]);
    scheduleAutoSave(SCOPE, EPIC);
    flushPendingAutoSaves();
    expect(loadSymbolTemplate(EPIC)).toBeNull();
    vi.useRealTimers();
  });
});
