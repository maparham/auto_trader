// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import { installMemStorage } from "../lib/testMemStorage";
installMemStorage();

import PresetsTab from "./PresetsTab";
import { defaultBacktestConfig, type BacktestConfig } from "../lib/backtestConfig";
import {
  loadPresets, putPreset, newPreset, serializePresets, parsePresets, type PresetRun,
} from "../lib/backtestPresets";
import { backtestResultSignal, backtestRunCompletedSignal } from "../lib/signals";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function setup(over: Partial<ComponentProps<typeof PresetsTab>> = {}) {
  const onLoad = vi.fn();
  const onActiveChange = vi.fn();
  const props = {
    cfg: defaultBacktestConfig(),
    onLoad,
    activeName: null as string | null,
    onActiveChange,
    chartSymbol: "TEST",
    chartTimeframe: "MINUTE",
    captureRuns: true,
    onGoLive: vi.fn(),
    ...over,
  };
  const view = render(<PresetsTab {...props} />);
  return { ...view, onLoad, onActiveChange, props };
}

// "Save as…" reveals an inline name field — no window.prompt anywhere. The spy
// makes that rule mechanical rather than aspirational: a browser prompt cannot
// be styled, tested, or cancelled predictably, so every naming path must stay
// inline.
function saveAs(name: string) {
  const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
  fireEvent.change(screen.getByPlaceholderText("Strategy name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(promptSpy).not.toHaveBeenCalled();
  promptSpy.mockRestore();
}

const dirtyCfg = (): BacktestConfig => ({ ...defaultBacktestConfig(), longEnabled: false });

// Only the fields PresetsTab reads; the rest of StoredBacktestResult is
// irrelevant here.
const fakeResult = (netPnl: number) =>
  ({
    trades: [],
    summary: { net_pnl: netPnl, n_trades: 4, win_rate: 0.5, max_drawdown: 7 },
  }) as unknown as NonNullable<typeof backtestResultSignal.value>;

const aRun = (): PresetRun => ({
  at: 1,
  symbol: "TEST",
  timeframe: "MINUTE",
  netPnl: 10,
  trades: 3,
  winRate: 0.5,
  maxDd: 2,
});

describe("PresetsTab identity bar", () => {
  it("shows 'Unsaved strategy' with Save and Revert disabled", () => {
    setup();
    expect(screen.getByText("Unsaved strategy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save as…" }).hasAttribute("disabled")).toBe(false);
  });

  it("Save as… stores the preset and makes it active", () => {
    const { onActiveChange } = setup();
    saveAs("Momentum");
    expect(Object.keys(loadPresets())).toEqual(["Momentum"]);
    expect(loadPresets().Momentum.origin).toEqual({ symbol: "TEST", timeframe: "MINUTE" });
    expect(onActiveChange).toHaveBeenCalledWith("Momentum");
  });
});

// Save a clean preset, then re-mount with it active and a config to compare
// against — the component reads storage once on mount, so the remount is what
// makes the seeded preset visible to it. The remount also gives the component a
// real `active` preset: `activeName` is parent-owned, and the bare `vi.fn()`
// `onActiveChange` never feeds it back, so without this the dirty check would
// short-circuit on `!active` and prove nothing.
function seeded(cfg: BacktestConfig, activeName: string | null = "Momentum") {
  setup();
  saveAs("Momentum");
  cleanup();
  return setup({ activeName, cfg });
}

describe("PresetsTab dirty state", () => {
  it("is clean when the active preset matches the live config", () => {
    // Deliberately re-mounted with the preset ACTIVE: the pre-fix version of
    // this test stayed on the mount that saved it, where `active` is undefined
    // and Save is disabled for the wrong reason.
    seeded(defaultBacktestConfig());
    // Scoped to the identity bar: the name also appears in the library table
    // below, so a bare getByText would now match twice.
    expect(document.querySelector(".bt-preset-name")?.textContent).toBe("Momentum");
    expect(screen.queryByText("edited")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows 'edited' and enables Save once the config diverges", () => {
    seeded(dirtyCfg());
    expect(screen.getByText("edited")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("Save writes the current config and clears the edited flag", () => {
    seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(screen.queryByText("edited")).toBeNull();
  });

  // The failure this rework exists to prevent: a Save that writes storage but
  // leaves the component comparing against the STALE preset, so the badge stays
  // lit forever. Guards refresh() from the button side, where the user sees it.
  it("Save re-baselines the dirty check, not just the badge", () => {
    seeded(dirtyCfg());
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(true);
    // Reverting now would hand back the config just saved, so the dot is clean.
    expect(document.querySelector(".bt-preset-dot.dirty")).toBeNull();
  });

  it("Revert asks first, then hands the saved config back", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onLoad } = seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalled();
    expect(onLoad.mock.calls[0][0].longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });

  it("Revert does nothing when the confirm is declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onLoad } = seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onLoad).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // A name that happens to be an Object.prototype member is still just a name.
  // A plain `presets[name]` read would find the inherited function, fire a
  // "Replace the saved preset" confirm for a preset that does not exist, and
  // then hand that function to the save path.
  it("Save as… under a prototype-member name creates it without a bogus confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onActiveChange } = setup();
    saveAs("toString");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(Object.keys(loadPresets())).toEqual(["toString"]);
    expect(onActiveChange).toHaveBeenCalledWith("toString");
    confirmSpy.mockRestore();
  });

  it("Save as… onto an existing name confirms, and cancelling leaves it alone", () => {
    setup();
    saveAs("Momentum");
    cleanup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    setup({ cfg: dirtyCfg() });
    saveAs("Momentum");
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });

  // A dangling activeName (the preset it names is gone from storage) renders as
  // "Unsaved strategy" while the parent still believes one is active. Recorded
  // as a deliberate decision, not an oversight: Task 4 owns delete and will
  // decide whether to notify the parent. Nothing here can delete a preset yet.
  it("falls back to 'Unsaved strategy' when activeName names nothing stored", () => {
    setup({ activeName: "Ghost" });
    expect(screen.getByText("Unsaved strategy")).toBeTruthy();
  });

  // Same dangling case, but on a name Object.prototype also carries: a plain
  // `presets[activeName]` would hand back a function, `active` would go truthy,
  // and the dirty check would dereference `.cfg` on it mid-render.
  it("does not treat a dangling prototype-member activeName as an active preset", () => {
    setup({ activeName: "toString" });
    expect(screen.getByText("Unsaved strategy")).toBeTruthy();
  });
});

describe("PresetsTab naming row", () => {
  // The tab is always mounted, so a draft abandoned via Escape would otherwise
  // live for the life of the panel and pre-fill the field on the next open — a
  // reflexive Enter would then fire an overwrite confirm on a stale name.
  it("Escape clears the draft, not just the row", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    fireEvent.change(screen.getByPlaceholderText("Strategy name"), {
      target: { value: "Abandoned" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Strategy name"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Strategy name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect((screen.getByPlaceholderText("Strategy name") as HTMLInputElement).value).toBe("");
  });

  it("Cancel clears the draft too", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    fireEvent.change(screen.getByPlaceholderText("Strategy name"), {
      target: { value: "Abandoned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect((screen.getByPlaceholderText("Strategy name") as HTMLInputElement).value).toBe("");
  });

  it("Save closes an open naming row", () => {
    seeded(dirtyCfg());
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByPlaceholderText("Strategy name")).toBeNull();
  });
});

// A stored lastRun summarizes the last CLEAN run, so it must never outlive the
// cfg it describes — Task 7's library table would otherwise credit a strategy
// with a result belonging to a superseded version of it.
describe("PresetsTab lastRun invariant", () => {
  function seedWithRun(cfg = defaultBacktestConfig()) {
    putPreset({
      ...newPreset("Momentum", cfg, { symbol: "TEST", timeframe: "MINUTE" }, 1),
      lastRun: aRun(),
    });
  }

  it("Save drops lastRun when the config changed", () => {
    seedWithRun();
    setup({ activeName: "Momentum", cfg: dirtyCfg() });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("Save as… onto an existing name drops its lastRun when the config changed", () => {
    seedWithRun();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setup({ cfg: dirtyCfg() });
    saveAs("Momentum");
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
    confirmSpy.mockRestore();
  });

  it("keeps lastRun when the overwrite writes an identical config", () => {
    seedWithRun();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    saveAs("Momentum");
    expect(loadPresets().Momentum.lastRun).toEqual(aRun());
    confirmSpy.mockRestore();
  });
});

describe("PresetsTab go live", () => {
  it("calls onGoLive with no argument", () => {
    const onGoLive = vi.fn();
    setup({ onGoLive });
    fireEvent.click(screen.getByRole("button", { name: /Go live/ }));
    expect(onGoLive).toHaveBeenCalled();
  });
});

function seedPreset(name: string, over: Partial<import("../lib/backtestPresets").BacktestPreset> = {}) {
  putPreset({
    ...newPreset(name, defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 1000),
    ...over,
  });
}

const run = (netPnl: number, over = {}) => ({
  at: 2000, symbol: "TEST", timeframe: "MINUTE",
  netPnl, trades: 4, winRate: 0.5, maxDd: 7, ...over,
});

function rowNames(): string[] {
  return [...document.querySelectorAll(".bt-preset-row .bt-preset-cell-name")].map(
    (el) => el.textContent ?? "",
  );
}

describe("PresetsTab library table", () => {
  it("shows an empty state instead of a dead dropdown", () => {
    setup();
    expect(screen.getByText(/No saved strategies yet/)).toBeTruthy();
    expect(document.querySelector(".bt-preset-row")).toBeNull();
  });

  // Asserts per CELL, not against whole-row text: the loose version passed
  // regardless of which column a value landed in, and let the "+" sign that
  // fmtMoney adds go unverified.
  it("renders one row per preset with its last-run summary", () => {
    seedPreset("Momentum", { lastRun: run(123.45) });
    seedPreset("Other", { lastRun: run(-1) });
    setup();
    expect(document.querySelectorAll(".bt-preset-row").length).toBe(2);
    const row = [...document.querySelectorAll(".bt-preset-row")].find((r) =>
      r.textContent?.includes("Momentum"),
    ) as HTMLElement;
    expect(row.querySelector(".bt-preset-cell-name")?.textContent).toBe("Momentum");
    // Symbol/TF, the four result columns in header order, then Modified.
    const cells = [...row.querySelectorAll(".bt-preset-cell")].map((c) => c.textContent);
    expect(cells.slice(0, 5)).toEqual(["TEST · MINUTE", "+123.45", "4", "50%", "7.00"]);
  });

  it("shows dashes for a preset that never recorded a run", () => {
    seedPreset("Fresh");
    setup();
    const row = document.querySelector(".bt-preset-row") as HTMLElement;
    // All FOUR result columns — `toContain("—")` passed on any single one.
    const nums = [...row.querySelectorAll(".bt-preset-cell.num")].map((c) => c.textContent);
    expect(nums).toEqual(["—", "—", "—", "—"]);
  });

  it("filters by name", () => {
    seedPreset("Momentum");
    seedPreset("Mean reversion");
    setup();
    fireEvent.change(screen.getByPlaceholderText("Filter…"), { target: { value: "mean" } });
    expect(rowNames()).toEqual(["Mean reversion"]);
  });

  it("sorts by net P&L when that header is clicked", () => {
    seedPreset("Loser", { lastRun: run(-50) });
    seedPreset("Winner", { lastRun: run(200) });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Net P&L" }));
    expect(rowNames()).toEqual(["Winner", "Loser"]);
    fireEvent.click(screen.getByRole("button", { name: "Net P&L" }));
    expect(rowNames()).toEqual(["Loser", "Winner"]);
  });

  it("marks a preset built on a different chart", () => {
    seedPreset("Daily thing", { origin: { symbol: "OTHER", timeframe: "DAY" } });
    setup();
    expect(document.querySelector(".bt-preset-mismatch")).not.toBeNull();
  });

  it("does not mark a preset matching the current chart", () => {
    seedPreset("Same chart");
    setup();
    expect(document.querySelector(".bt-preset-mismatch")).toBeNull();
  });
});

describe("PresetsTab row actions", () => {
  function openMenu(name: string) {
    const row = [...document.querySelectorAll(".bt-preset-row")].find((r) =>
      r.textContent?.includes(name),
    ) as HTMLElement;
    fireEvent.click(row.querySelector(".bt-preset-menu-btn") as HTMLElement);
  }

  it("Load hands the stored config back and sets it active", () => {
    seedPreset("Momentum", { cfg: { ...defaultBacktestConfig(), longEnabled: false } });
    const { onLoad, onActiveChange } = setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad.mock.calls[0][0].longEnabled).toBe(false);
    expect(onActiveChange).toHaveBeenCalledWith("Momentum");
  });

  it("Load while dirty offers Save & load / Discard & load / Cancel", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save & load" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard & load" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("Save & load writes the edits before switching", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad, onActiveChange } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & load" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(onLoad).toHaveBeenCalled();
    expect(onActiveChange).toHaveBeenCalledWith("Other");
  });

  it("Discard & load switches without writing", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard & load" }));
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    expect(onLoad).toHaveBeenCalled();
  });

  it("Duplicate creates a copy", () => {
    seedPreset("Momentum");
    setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(Object.keys(loadPresets()).sort()).toEqual(["Momentum", "Momentum copy"]);
  });

  // Pins the runFor invariant from the OTHER side. runFor drops lastRun whenever
  // the cfg being written differs from the stored one — Duplicate writes the cfg
  // unchanged, so the summary still describes it and must ride across. Without
  // this, a future "consistency" fix that drops lastRun by analogy with runFor
  // would land green.
  it("Duplicate carries lastRun across, because the cfg is unchanged", () => {
    seedPreset("Momentum", { lastRun: run(42) });
    setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const copy = loadPresets()["Momentum copy"];
    expect(copy.lastRun?.netPnl).toBe(42);
    expect(copy.cfg).toEqual(loadPresets().Momentum.cfg);
  });

  it("Rename keeps the metadata and moves the active pointer", () => {
    seedPreset("Old", { lastRun: run(10) });
    const { onActiveChange } = setup({ activeName: "Old" });
    openMenu("Old");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByPlaceholderText("Strategy name"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(loadPresets().New.lastRun?.netPnl).toBe(10);
    expect(onActiveChange).toHaveBeenCalledWith("New");
  });

  it("Delete confirms, and clears the active pointer when it was active", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Momentum");
    const { onActiveChange } = setup({ activeName: "Momentum" });
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(loadPresets()).toEqual({});
    expect(onActiveChange).toHaveBeenCalledWith(null);
    confirmSpy.mockRestore();
  });

  it("Delete leaves the preset alone when the confirm is declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    seedPreset("Momentum");
    setup();
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(Object.keys(loadPresets())).toEqual(["Momentum"]);
    confirmSpy.mockRestore();
  });

  // Not in the brief: the same-preset case the three-way prompt creates. Save &
  // load on the ACTIVE preset must hand back the edits it just saved, not the
  // pre-save stored cfg — otherwise "save" silently un-saves.
  it("Save & load on the active preset hands back the saved config", () => {
    seedPreset("Momentum");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Momentum");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & load" }));
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    expect(onLoad.mock.calls[0][0].longEnabled).toBe(false);
  });

  // An abandoned rename draft must not leak into the next Save as… — the tab is
  // always mounted, so the naming row's state outlives the interaction.
  it("cancelling a rename leaves Save as… clean and in create mode", () => {
    seedPreset("Old");
    setup();
    openMenu("Old");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect((screen.getByPlaceholderText("Strategy name") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  // Rename onto a name already in use is a destructive, confirm-gated path —
  // the same shape as Save as… over an existing preset, and previously the only
  // such path in this tab with no coverage at all.
  function renameTo(from: string, to: string) {
    openMenu(from);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByPlaceholderText("Strategy name"), { target: { value: to } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  }

  it("Rename onto an existing name confirms, and accepting replaces its content", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Old", { lastRun: run(10) });
    seedPreset("Taken", { lastRun: run(99) });
    setup();
    renameTo("Old", "Taken");
    expect(confirmSpy).toHaveBeenCalled();
    const all = loadPresets();
    expect(Object.keys(all).sort()).toEqual(["Taken"]);
    // The two collapse into one carrying the RENAMED preset's content.
    expect(all.Taken.lastRun?.netPnl).toBe(10);
    confirmSpy.mockRestore();
  });

  it("Rename onto an existing name leaves both alone when declined, keeping the draft", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    seedPreset("Old", { lastRun: run(10) });
    seedPreset("Taken", { lastRun: run(99) });
    setup();
    renameTo("Old", "Taken");
    expect(Object.keys(loadPresets()).sort()).toEqual(["Old", "Taken"]);
    expect(loadPresets().Taken.lastRun?.netPnl).toBe(99);
    // Declining leaves the row open with the draft intact, as createNamed does.
    expect((screen.getByPlaceholderText("Strategy name") as HTMLInputElement).value).toBe("Taken");
    confirmSpy.mockRestore();
  });

  it("Rename that overwrites the ACTIVE preset drops the active pointer", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Old");
    seedPreset("Editing");
    const { onActiveChange } = setup({ activeName: "Editing" });
    renameTo("Old", "Editing");
    // The overwrite destroyed the preset the panel was editing, exactly as a
    // delete would. Re-pointing at the same name would silently swap its content
    // and light the dirty dot for no visible cause.
    expect(onActiveChange).toHaveBeenCalledWith(null);
    confirmSpy.mockRestore();
  });

  // The table stays live while the load prompt is up, so the prompt's subject
  // can be destroyed out from under it. Reported: the prompt survived with two
  // dead buttons, and Save & load still wrote storage on every click.
  it("deleting the pending load target dismisses the prompt", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Momentum");
    seedPreset("Other");
    setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByRole("button", { name: "Save & load" })).toBeTruthy();
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("button", { name: "Save & load" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard & load" })).toBeNull();
    confirmSpy.mockRestore();
  });

  // The other way the subject can vanish, which remove()'s own clear does not
  // cover — this one is caught by doLoad clearing the prompt before its
  // existence guard rather than after.
  it("Save & load on a target renamed away dismisses the prompt instead of sticking", () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const { onLoad } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    openMenu("Other");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    renameTo("Other", "Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save & load" }));
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save & load" })).toBeNull();
  });
});

// The file input is read through File.text(); jsdom's File does not implement
// it in every version, so stub the method on the instance we hand to the input.
function fakeFile(contents: string): File {
  const f = new File([contents], "presets.json", { type: "application/json" });
  Object.defineProperty(f, "text", { value: () => Promise.resolve(contents) });
  return f;
}

function importJson(json: string) {
  const input = document.querySelector(".bt-preset-import-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(json)] } });
}

describe("PresetsTab import", () => {
  it("adds presets from a valid file", async () => {
    setup();
    const json = serializePresets([
      newPreset("Imported", defaultBacktestConfig(), { symbol: "OTHER", timeframe: "HOUR" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported");
    expect(Object.keys(loadPresets())).toEqual(["Imported"]);
  });

  it("reports what it rejected and leaves good entries in place", async () => {
    setup();
    const json = JSON.stringify({ version: 3, presets: [{ name: "Bad" }] });
    importJson(json);
    await screen.findByText(/Skipped 1/);
    expect(loadPresets()).toEqual({});
  });

  it("confirms before overwriting an existing name", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    seedPreset("Momentum");
    setup();
    const json = serializePresets([
      newPreset("Momentum", { ...defaultBacktestConfig(), longEnabled: false }, { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText(/Imported 0/);
    expect(loadPresets().Momentum.cfg.longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });

  // Not in the brief. Import is the first path that can put hand-edited metadata
  // in front of the table's formatters and comparators; parsePresets strips the
  // garbage rather than dropping the strategy, and this pins that end to end.
  it("keeps a preset whose metadata is garbage, minus the garbage", async () => {
    setup();
    const json = JSON.stringify({
      version: 3,
      presets: [
        { ...newPreset("Junky", defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 500),
          origin: 42, lastRun: "banana" },
      ],
    });
    importJson(json);
    await screen.findByText("Junky");
    expect(loadPresets().Junky.origin).toBeUndefined();
    expect(loadPresets().Junky.lastRun).toBeUndefined();
    // Rendered, not crashed: every result column falls back to a dash.
    const row = document.querySelector(".bt-preset-row") as HTMLElement;
    expect([...row.querySelectorAll(".bt-preset-cell.num")].map((c) => c.textContent))
      .toEqual(["—", "—", "—", "—"]);
  });

  // A file carrying the same name twice: the collision set has to grow as the
  // loop writes, or the second occurrence silently overwrites the first and the
  // note reports both as imported.
  it("confirms on a name repeated inside one file", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    setup();
    const cfgA = defaultBacktestConfig();
    const json = serializePresets([
      newPreset("Twin", cfgA, { symbol: "TEST", timeframe: "MINUTE" }, 500),
      newPreset("Twin", { ...cfgA, longEnabled: false }, { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported 1 · Skipped 1");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The FIRST occurrence survives; the declined second did not overwrite it.
    expect(loadPresets().Twin.cfg.longEnabled).not.toBe(false);
    confirmSpy.mockRestore();
  });

  // Same policy commitRename and remove already apply: overwriting the ACTIVE
  // preset leaves the panel showing a config stored nowhere. Reported: the dirty
  // dot lit with no user edit, and Save wrote the panel's config back over the
  // freshly imported one.
  it("drops the active pointer when the import overwrites the active preset", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    seedPreset("Momentum");
    const { onActiveChange } = setup({ activeName: "Momentum" });
    const json = serializePresets([
      newPreset("Momentum", dirtyCfg(), { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported 1");
    expect(onActiveChange).toHaveBeenCalledWith(null);
    expect(loadPresets().Momentum.cfg.longEnabled).toBe(false);
    confirmSpy.mockRestore();
  });

  it("leaves the active pointer alone when the import touches other names", async () => {
    seedPreset("Momentum");
    const { onActiveChange } = setup({ activeName: "Momentum" });
    const json = serializePresets([
      newPreset("Other", defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported 1");
    expect(onActiveChange).not.toHaveBeenCalled();
  });

  // A structurally wrong cfg has no usable remainder — unlike the metadata it
  // cannot be stripped. Task 6 hands imported configs to the real modal, which
  // derefs cfg.range.mode unguarded.
  it("rejects an entry whose cfg is not a backtest config", async () => {
    setup();
    const json = JSON.stringify({
      version: 3,
      presets: [
        { name: "Hollow", cfg: {}, createdAt: 1, updatedAt: 1 },
        { ...newPreset("Real", defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 1) },
      ],
    });
    importJson(json);
    await screen.findByText("Imported 1 · Skipped 1");
    expect(Object.keys(loadPresets())).toEqual(["Real"]);
  });

  // A name that is also an Object.prototype key. Reported: the note said
  // "Imported 1" with zero keys in storage, because the write landed on the
  // prototype instead of a property.
  it("actually stores a preset named __proto__", async () => {
    setup();
    const json = serializePresets([
      newPreset("__proto__", defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported 1");
    expect(Object.keys(loadPresets())).toEqual(["__proto__"]);
  });

  // Covers re-entrancy only. The `e.target.value = ""` line it sits next to is
  // NOT provable here and this test is not claimed to guard it: jsdom never
  // derives `input.value` from a synthetically assigned `files`, and a synthetic
  // fireEvent.change dispatches whether or not the value was cleared. Verified
  // by deleting the line — every test in this file still passed. The line stays
  // because real browsers suppress `change` on an identical re-selection; it is
  // load-bearing in production and untestable in jsdom.
  it("processes a second import with no remount", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    const json = serializePresets([
      newPreset("Imported", defaultBacktestConfig(), { symbol: "TEST", timeframe: "MINUTE" }, 500),
    ]);
    importJson(json);
    await screen.findByText("Imported 1");
    importJson(json);
    // The note reads the same both times, so the collision confirm — reachable
    // only on the second pass — is what shows the second file was processed.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });
});

// jsdom implements neither object URLs nor anchor-triggered downloads, so the
// export path is verified at its only observable boundary: the Blob handed to
// createObjectURL. `a.click()` logs a "Not implemented: navigation" line — noise.
// Restored in afterEach rather than by the caller: these are plain property
// writes, so vi.restoreAllMocks() cannot undo them and a failing expect would
// otherwise leak the stubs into every later test in the run.
let restoreDownload: (() => void) | null = null;
afterEach(() => { restoreDownload?.(); restoreDownload = null; });

function captureDownload(): Blob[] {
  const blobs: Blob[] = [];
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  const prev = { create: url.createObjectURL, revoke: url.revokeObjectURL };
  url.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:mock"; });
  url.revokeObjectURL = vi.fn();
  restoreDownload = () => { url.createObjectURL = prev.create; url.revokeObjectURL = prev.revoke; };
  return blobs;
}

describe("PresetsTab export", () => {
  it("Export all writes a file the importer accepts", async () => {
    seedPreset("Momentum", { lastRun: run(42) });
    seedPreset("Other");
    const blobs = captureDownload();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Export all" }));
    expect(blobs).toHaveLength(1);
    const { presets, rejected } = parsePresets(await blobs[0].text());
    expect(rejected).toBe(0);
    expect(presets.map((p) => p.name).sort()).toEqual(["Momentum", "Other"]);
    expect(presets.find((p) => p.name === "Momentum")?.lastRun?.netPnl).toBe(42);
  });

  it("Export all is disabled with nothing saved", () => {
    setup();
    expect(screen.getByRole("button", { name: "Export all" }).hasAttribute("disabled")).toBe(true);
  });

  it("Export from the row menu writes just that preset", async () => {
    seedPreset("Momentum");
    seedPreset("Other");
    const blobs = captureDownload();
    setup();
    const row = [...document.querySelectorAll(".bt-preset-row")].find((r) =>
      r.textContent?.includes("Momentum"),
    ) as HTMLElement;
    fireEvent.click(row.querySelector(".bt-preset-menu-btn") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const { presets } = parsePresets(await blobs[0].text());
    expect(presets.map((p) => p.name)).toEqual(["Momentum"]);
    // Every other row action closes the menu behind it; Export must too, or the
    // menu hangs open over a download the user cannot see happening.
    expect(document.querySelector(".bt-preset-menu")).toBeNull();
  });
});

// A completed single backtest = publish the result, then bump the completion
// counter. That is exactly what BacktestButton does, in that order; a rehydrate
// does only the publish.
function completeRun(result: NonNullable<typeof backtestResultSignal.value>) {
  act(() => {
    backtestResultSignal.set(result);
    backtestRunCompletedSignal.set(backtestRunCompletedSignal.value + 1);
  });
}

// What a rehydrate hands the panel: the result read back out of localStorage on a
// symbol/timeframe switch. A STRUCTURAL COPY, never the same object — runAndRender
// returns loadBacktestResult's value, so even a fresh run publishes a JSON
// round-trip and object identity cannot separate the two cases.
const republish = (result: NonNullable<typeof backtestResultSignal.value>) =>
  act(() => backtestResultSignal.set(JSON.parse(JSON.stringify(result))));

describe("PresetsTab run capture", () => {
  beforeEach(() => {
    backtestResultSignal.set(null);
    backtestRunCompletedSignal.set(0);
  });

  it("records the summary on a clean active preset", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum" });
    completeRun(fakeResult(88.5));
    const captured = loadPresets().Momentum.lastRun;
    expect(captured?.netPnl).toBe(88.5);
    expect(captured?.trades).toBe(4);
    expect(captured?.winRate).toBe(0.5);
    expect(captured?.maxDd).toBe(7);
    expect(captured?.symbol).toBe("TEST");
    expect(captured?.timeframe).toBe("MINUTE");
  });

  // A run is not an edit, and Modified is the table's default sort key — a
  // finished backtest must not reshuffle the library.
  it("does not bump updatedAt when recording", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum" });
    completeRun(fakeResult(88.5));
    expect(loadPresets().Momentum.updatedAt).toBe(1000);
  });

  it("records nothing when the config is dirty", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum", cfg: dirtyCfg() });
    completeRun(fakeResult(88.5));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("records nothing when no preset is active", () => {
    seedPreset("Momentum");
    setup();
    completeRun(fakeResult(88.5));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("records nothing outside single-backtest mode", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum", captureRuns: false });
    completeRun(fakeResult(88.5));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  it("does not re-record the same result object twice", () => {
    seedPreset("Momentum");
    const r = fakeResult(10);
    setup({ activeName: "Momentum" });
    completeRun(r);
    const first = loadPresets().Momentum.lastRun?.at;
    act(() => backtestResultSignal.set(r));
    expect(loadPresets().Momentum.lastRun?.at).toBe(first);
  });

  // The real rehydrate path, and the one that defeats object identity: a
  // timeframe switch republishes a structural COPY of the stored result. Without
  // the completion counter this restamps `at` and credits the run to whatever
  // chart the user has since switched to.
  it("does not re-record a structural copy republished by a rehydrate", () => {
    seedPreset("Momentum");
    const r = fakeResult(10);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5000);
    const { rerender, props } = setup({ activeName: "Momentum" });
    completeRun(r);
    expect(loadPresets().Momentum.lastRun?.at).toBe(5000);
    // The user switches the chart to HOUR; the panel is non-modal and stays
    // mounted, with the same preset still active.
    nowSpy.mockReturnValue(9000);
    rerender(<PresetsTab {...props} chartTimeframe="HOUR" />);
    republish(r);
    const after = loadPresets().Momentum.lastRun;
    expect(after?.at).toBe(5000);
    expect(after?.symbol).toBe("TEST");
    expect(after?.timeframe).toBe("MINUTE");
    nowSpy.mockRestore();
  });

  // The invariant break the counter exists to prevent: a run performed with NO
  // preset active is correctly not recorded, but a later rehydrate of that same
  // stored result must not then attach its numbers — from a completely different
  // config — to whatever preset the user has since loaded. `runFor` cannot help
  // here: the preset's cfg never changed, so it still looks clean.
  it("does not attach a rehydrated run to a preset loaded afterwards", () => {
    seedPreset("Momentum");
    const r = fakeResult(123);
    const { rerender, props } = setup();
    completeRun(r);
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
    rerender(<PresetsTab {...props} activeName="Momentum" />);
    republish(r);
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  // The counter's other job: a rehydrate can publish ANOTHER chart's saved
  // result, which is a genuine run but not one this panel performed. A runId or
  // value compare would wave this through — it is a result the panel has never
  // seen — so only "did a run complete while I was mounted?" rejects it.
  it("does not attach another chart's stored run", () => {
    seedPreset("Momentum");
    setup({ activeName: "Momentum" });
    republish(fakeResult(123));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  // Brief-mandated behaviour: a run that completes against an EDITED config
  // belongs to that edited config, so reverting must not retro-attach it.
  it("does not attach a run that completed while dirty after a revert", () => {
    seedPreset("Momentum");
    const { rerender, props } = setup({ activeName: "Momentum", cfg: dirtyCfg() });
    completeRun(fakeResult(88.5));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
    // The user reverts: the config matches the stored preset again.
    rerender(<PresetsTab {...props} cfg={defaultBacktestConfig()} />);
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
    // …and a later rehydrate of that same run must not resurrect it either.
    republish(fakeResult(88.5));
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });

  // The panel unmounts when it is closed, so it can mount after a run has already
  // completed. That run is not ours to record.
  it("does not record a run that completed before it mounted", () => {
    seedPreset("Momentum");
    backtestResultSignal.set(fakeResult(88.5));
    backtestRunCompletedSignal.set(1);
    setup({ activeName: "Momentum" });
    expect(loadPresets().Momentum.lastRun).toBeUndefined();
  });
});
