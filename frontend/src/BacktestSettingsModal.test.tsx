// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

// jsdom's localStorage isn't wired up in this project's vitest config (see
// codedConfig.test.ts) — install the in-memory shim before any module reads it,
// so the coded-mode tests' persistence round-trip actually lands.
installMemStorage();

// The modal now threads openChartPicker -> enumerateChartOperands, which pulls in
// backtestSeries -> customIndicators, which reads LineType at module load (AVWAP
// line style table); stub klinecharts' runtime surface like backtestSeries.test.ts /
// overlays.test.ts / chartOperand.test.ts do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

// Coded-mode tests stub the strategy list so the modal doesn't hit the network.
// Defaults to an empty list so rules-mode tests (which never touch it) don't
// have to care.
const mockStrategies = vi.fn().mockResolvedValue([]);
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, fetchStrategies: (...args: unknown[]) => mockStrategies(...args) };
});

import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import { loadCodedCfg } from "./lib/codedConfig";
import { sweepStateSignal, sweepAxesSignal } from "./lib/signals";
import type { SweepRow } from "./api";

// See VisibilityTab.test.tsx: vitest isn't run with jest-style globals, so RTL's
// automatic cleanup never registers. Without this each render leaks into the next.
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  mockStrategies.mockReset().mockResolvedValue([]);
});

// The rule group whose <div class="bt-section"> heading matches `title`. Each
// group renders its rows and Add/Paste footer inside that section.
function groupSection(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const section = heading.closest(".bt-section");
  if (!section) throw new Error(`no section for "${title}"`);
  return section as HTMLElement;
}

function ruleRows(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll(".bt-rule-row")] as HTMLElement[];
}

function renderModal(initial = defaultBacktestConfig()) {
  return render(
    <BacktestSettingsModal
      initial={initial}
      epic="TEST"
      resolution="MINUTE"
      controller={null}
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("BacktestSettingsModal period scheduling", () => {
  it("shows month suggestion chips when the Month tab is active", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    // getByRole throws if absent, so reaching the assertion is the check.
    expect(screen.getByRole("button", { name: "This month" })).toBeTruthy();
  });

  it("reveals mask controls and a coverage readout when enabled", () => {
    renderModal();
    fireEvent.click(screen.getByLabelText(/only trade during selected windows/i));
    expect(screen.getByRole("button", { name: "Mon" })).toBeTruthy();
    expect(screen.getByText("Session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    expect(screen.getByText(/Active on \d+ of \d+ sampled slots/)).toBeTruthy();
  });

  it("shows the session-close sub-toggle only when windows are enabled, and it toggles", () => {
    renderModal();
    // Hidden until the windows checkbox is on.
    expect(screen.queryByLabelText(/close open positions at session close/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/only trade during selected windows/i));
    const sub = screen.getByLabelText(/close open positions at session close/i) as HTMLInputElement;
    // Default off, and toggles on.
    expect(sub.checked).toBe(false);
    fireEvent.click(sub);
    expect(sub.checked).toBe(true);
  });
});

// The rule builder now lives under the "Strategy" vertical tab, so tests must
// open it before the Long/Short groups exist in the DOM. Scoped to the .bt-htabs
// nav — the Rules|Strategy mode switch inside the section reuses the same
// "Strategy" label, so an unscoped query would match both.
function openStrategy() {
  const nav = document.querySelector(".bt-htabs") as HTMLElement;
  fireEvent.click(within(nav).getByRole("button", { name: "Strategy" }));
}

// Row actions now live behind a ⋮ menu. Open the first row's menu in `section`,
// then click the named menuitem (the menu is portaled to <body>).
function ruleAction(section: HTMLElement, name: RegExp | string) {
  fireEvent.click(within(section).getAllByLabelText("Rule actions")[0]);
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("BacktestSettingsModal rule duplicate/copy/paste", () => {
  it("duplicating a rule inserts an independent copy right after it", () => {
    renderModal();
    openStrategy();
    // Long side is shown first; its "Buy to open" group has one rule.
    const entry = groupSection("Buy to open");
    expect(ruleRows(entry)).toHaveLength(1);
    ruleAction(entry, "Duplicate");
    expect(ruleRows(entry)).toHaveLength(2);
  });

  it("copy then paste appends the rule to a group on the other side", () => {
    renderModal();
    openStrategy();
    // Copy the long-entry rule via its row menu.
    ruleAction(groupSection("Buy to open"), "Copy");

    // Switch to the short side and paste into its entry group.
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    const shortEntry = groupSection("Sell to open");
    expect(ruleRows(shortEntry)).toHaveLength(1);
    fireEvent.click(within(shortEntry).getByRole("button", { name: "Paste rule" }));
    expect(ruleRows(shortEntry)).toHaveLength(2);
  });

  it("hides Paste until a rule has been copied", () => {
    renderModal();
    openStrategy();
    expect(screen.queryByRole("button", { name: "Paste rule" })).toBeNull();
    ruleAction(groupSection("Buy to open"), "Copy");
    expect(screen.getAllByRole("button", { name: "Paste rule" }).length).toBeGreaterThan(0);
  });

  it("disabling a rule keeps it but marks the row disabled", () => {
    renderModal();
    openStrategy();
    const entry = groupSection("Buy to open");
    expect(ruleRows(entry)).toHaveLength(1);
    ruleAction(entry, "Disable");
    // Still present (not removed), now flagged disabled.
    expect(ruleRows(entry)).toHaveLength(1);
    expect(entry.querySelector(".bt-rule-disabled")).not.toBeNull();
  });
});

describe("chart-operand entry points", () => {
  it("an empty rule group offers '+ Rule from chart' (footer) and opens the picker", () => {
    renderModal();
    openStrategy();
    // Empty the seeded "Buy to open" group so the empty group is what's exercised.
    const entry = groupSection("Buy to open");
    fireEvent.click(within(entry).getByLabelText("Delete rule"));
    expect(ruleRows(entry)).toHaveLength(0);
    // The always-present footer offers it exactly once (no redundant empty-state copy).
    const btns = within(entry).getAllByRole("button", { name: "+ Rule from chart" });
    expect(btns).toHaveLength(1);
    fireEvent.click(btns[0]);
    // No controller in the test harness -> picker shows its empty state.
    expect(screen.getByText(/No indicators on this chart/i)).toBeTruthy();
  });

  it("every operand shows an 'Add from chart' button", () => {
    renderModal();
    openStrategy();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add rule" })[0]);
    expect(screen.getAllByRole("button", { name: "Add from chart" }).length).toBeGreaterThan(0);
  });
});

describe("operator sweep", () => {
  it("toggles an operator sweep axis and shows the 7-operator chip editor inline", () => {
    renderModal();
    openStrategy();
    // Default config seeds one long-entry rule; add another so the group has rows.
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add rule" })[0]);
    // The operator sweep glyph sits beside the operator button.
    const glyphs = document.querySelectorAll(".bt-op-menu + .sp-sweep, .bt-op-sweep-toggle");
    expect(glyphs.length).toBeGreaterThan(0);
    fireEvent.click(glyphs[0]);
    // Inline chip editor lists all 7 operators; the rule's current op is ticked.
    const editor = document.querySelector(".bt-op-sweep-row")!;
    expect(editor).toBeTruthy();
    expect(editor.querySelectorAll(".bt-chip").length).toBe(7);
    expect(editor.querySelectorAll(".seg-on").length).toBe(1);
    // Ticking a second operator marks it selected (chip 3 is "greater than",
    // which differs from the seeded "crosses above").
    fireEvent.click(editor.querySelectorAll(".bt-chip")[3]);
    expect(editor.querySelectorAll(".seg-on").length).toBe(2);
  });
});

describe("time-window sweep", () => {
  it("toggles a time-window sweep axis and lists candidate windows inline", () => {
    const initial = defaultBacktestConfig();
    initial.range.mask = { enabled: true, timeOfDay: { startMin: 480, endMin: 720 }, tz: "UTC" };
    renderModal(initial);
    // with an enabled mask whose timeOfDay is 08:00-12:00 UTC
    const glyph = document.querySelector(".bt-tw-sweep-toggle")!;
    expect(glyph).toBeTruthy();
    fireEvent.click(glyph);
    const editor = document.querySelector(".bt-tw-sweep")!;
    expect(editor).toBeTruthy();
    // seeded with the current window
    expect(editor.textContent).toContain("08:00-12:00 UTC");
    // a session preset can be added as another option
    fireEvent.change(editor.querySelector("select")!, { target: { value: "London" } });
    expect(editor.querySelectorAll(".bt-tw-option").length).toBe(2);
    // removing an option works
    fireEvent.click(editor.querySelectorAll(".bt-tw-option button")[0]);
    expect(editor.querySelectorAll(".bt-tw-option").length).toBe(1);
  });
});

describe("period sweep", () => {
  it("toggles a period sweep axis with an inline windows stepper", () => {
    renderModal();
    const glyph = document.querySelector(".bt-period-sweep-toggle")!;
    expect(glyph).toBeTruthy();
    fireEvent.click(glyph);
    const editor = document.querySelector(".bt-period-sweep")!;
    expect(editor).toBeTruthy();
    const input = editor.querySelector("input")! as HTMLInputElement;
    expect(input.value).toBe("4");                      // default N
    fireEvent.change(input, { target: { value: "6" } });
    expect((editor.querySelector("input") as HTMLInputElement).value).toBe("6");
    fireEvent.click(glyph);                              // toggles off
    expect(document.querySelector(".bt-period-sweep")).toBeNull();
  });
});

describe("parked side", () => {
  it("makes the whole side inert when its trade toggle is off (switch stays live)", () => {
    renderModal();
    openStrategy();
    const sideRules = groupSection("Buy to open").closest(".bt-side-rules") as HTMLElement;
    expect(sideRules.hasAttribute("inert")).toBe(false);
    // Toggle the long side off.
    fireEvent.click(screen.getByRole("switch", { name: "Trade the long side" }));
    expect(sideRules.hasAttribute("inert")).toBe(true);
    expect(sideRules.className).toContain("bt-parked");
  });
});

describe("coded mode: params, risk, and exit-rule sections", () => {
  const strategies = [
    {
      filename: "ema_cross.py",
      name: "EMA Cross",
      description: "",
      hedged: false,
      error: null,
      params: [
        { name: "ema_fast", label: "Fast EMA", type: "int" as const, default: 9, min: 2, max: 50, step: 1, options: null, help: null },
      ],
    },
  ];

  it("coded mode shows params, risk and exit-rule sections editing the backtest set", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    openStrategy();

    // Params render once the strategy list resolves.
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    // Risk sections (one per side) — RiseSection's actual heading copy.
    expect(screen.getAllByText("Stop & take profit").length).toBeGreaterThan(0);

    // Exit rule-group titles, reused from rules mode.
    expect(screen.getByText("Sell to close")).toBeTruthy();
    expect(screen.getByText("Buy to close")).toBeTruthy();

    // Entry groups are hidden in coded mode.
    expect(screen.queryByText("Buy to open")).toBeNull();
    expect(screen.queryByText("Sell to open")).toBeNull();

    // Editing a param persists into the "backtest" coded set for this filename.
    const input = screen.getByDisplayValue("9") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(loadCodedCfg("backtest", "ema_cross.py").params.ema_fast).toBe(12);
  });

  it("rules mode is unchanged (no params/coded sections)", () => {
    renderModal();
    openStrategy();
    expect(screen.queryByText("Parameters")).toBeNull();
    expect(screen.getByText("Buy to open")).toBeTruthy();
  });
});

describe("sweep results: click-to-apply mid-sweep (I2)", () => {
  const strategies = [
    {
      filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
      params: [
        { name: "ema_fast", label: "Fast EMA", type: "int" as const, default: 9, min: 2, max: 50, step: 1, options: null, help: null },
      ],
    },
  ];
  const rows: SweepRow[] = [
    { combo: { "param:ema_fast": 12 }, metrics: { net_pnl: 10, n_trades: 3, win_rate: 0.5, max_drawdown: 1, profit_factor: 1.2, return_pct: 1 }, error: null },
  ];

  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  it("clicking a sweep row while the sweep is still running does NOT apply the combo", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const onRun = vi.fn();
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    render(
      <BacktestSettingsModal
        initial={initial} epic="TEST" resolution="MINUTE" controller={null}
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    openStrategy();
    await screen.findByText("Fast EMA");
    act(() => sweepStateSignal.set({ rows, done: 1, total: 2, running: true }));

    // The disabled state must be visible, not just non-functional.
    expect(screen.getByText(/Cancel the sweep to apply a combo/)).toBeTruthy();
    const row = document.querySelector(".sweep-row") as HTMLElement;
    expect(row.className).toContain("sweep-row-disabled");

    fireEvent.click(row);

    // Mid-sweep click must be a no-op: no re-run requested, no combo persisted.
    expect(onRun).not.toHaveBeenCalled();
    expect(loadCodedCfg("backtest", "ema_cross.py").params.ema_fast).toBeUndefined();
  });

  it("clicking a sweep row after the sweep finishes applies the combo normally", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const onRun = vi.fn();
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    render(
      <BacktestSettingsModal
        initial={initial} epic="TEST" resolution="MINUTE" controller={null}
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    openStrategy();
    await screen.findByText("Fast EMA");
    act(() => sweepStateSignal.set({ rows, done: 2, total: 2, running: false }));

    const row = document.querySelector(".sweep-row") as HTMLElement;
    fireEvent.click(row);

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(loadCodedCfg("backtest", "ema_cross.py").params.ema_fast).toBe(12);
  });
});

describe("synced long/short SL/TP", () => {
  // The one visible risk block (rule mode renders one side at a time).
  const riskSec = () =>
    screen.getByText("Stop & take profit").closest(".bt-risk") as HTMLElement;
  const stopSelect = () => riskSec().querySelectorAll("select")[0] as HTMLSelectElement;
  const syncBox = () => within(riskSec()).getByLabelText(/same for long & short/i) as HTMLInputElement;

  it("defaults on and mirrors an edit to the other side", () => {
    renderModal();
    openStrategy();
    expect(syncBox().checked).toBe(true);
    fireEvent.change(stopSelect(), { target: { value: "pct" } });
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    expect(stopSelect().value).toBe("pct");
  });

  it("stops mirroring once unchecked", () => {
    renderModal();
    openStrategy();
    fireEvent.click(syncBox());
    fireEvent.change(stopSelect(), { target: { value: "pct" } });
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    expect(stopSelect().value).toBe("none");
    expect(syncBox().checked).toBe(false);
  });

  it("copies the viewed side across on load when synced sides drifted apart", () => {
    const cfg = defaultBacktestConfig();
    cfg.longRisk = { stop: { kind: "pct", value: 1.5 }, target: { kind: "pct", value: 3 } };
    cfg.shortRisk = { stop: { kind: "atr", mult: 2, length: 14 }, target: { kind: "none" } };
    renderModal(cfg);   // riskSynced absent = on; long is the default viewed side
    openStrategy();
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    expect(stopSelect().value).toBe("pct");
    expect((riskSec().querySelector("input.bt-num") as HTMLInputElement).value).toBe("1.5");
  });

  it("re-checking the box copies the side being viewed across", () => {
    const cfg = defaultBacktestConfig();
    cfg.riskSynced = false;
    cfg.longRisk = { stop: { kind: "pct", value: 1 }, target: { kind: "pct", value: 2 } };
    cfg.shortRisk = { stop: { kind: "atr", mult: 2, length: 14 }, target: { kind: "none" } };
    renderModal(cfg);
    openStrategy();
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    fireEvent.click(syncBox());   // enable while looking at the short side
    fireEvent.click(screen.getByRole("button", { name: /Long/ }));
    expect(stopSelect().value).toBe("atr");
  });
});
