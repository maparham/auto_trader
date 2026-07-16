// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
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
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

// Coded-mode tests stub the strategy list so the modal doesn't hit the network.
// Defaults to an empty list so rules-mode tests (which never touch it) don't
// have to care.
const mockStrategies = vi.fn().mockResolvedValue([]);
// computeStatus gates the Compute: Local|Remote toggle. Default "not configured"
// so the toggle stays hidden for the tests that don't care; the toggle tests
// override it per case.
const mockComputeStatus = vi.fn().mockResolvedValue({ remoteConfigured: false });
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchStrategies: (...args: unknown[]) => mockStrategies(...args),
    computeStatus: (...args: unknown[]) => mockComputeStatus(...args),
  };
});

import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig, type BacktestConfig } from "./lib/backtestConfig";
import { loadCodedCfg } from "./lib/codedConfig";
import { saveBacktestPreset } from "./lib/persist/defaults";
import { sweepStateSignal, sweepAxesSignal, sweepTargetSignal } from "./lib/signals";
import type { SweepRow } from "./api";
import { recordSweepRanges, recallSweepRange, saveSweepAxes, recordSweepPace } from "./lib/sweepMemory";

// See VisibilityTab.test.tsx: vitest isn't run with jest-style globals, so RTL's
// automatic cleanup never registers. Without this each render leaks into the next.
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  mockStrategies.mockReset().mockResolvedValue([]);
  mockComputeStatus.mockReset().mockResolvedValue({ remoteConfigured: false });
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
      chartTimezone="UTC"
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

// The footer's Backtest | Sweep mode switch. Sweep setup/results only render in
// Sweep mode, so the sweep tests flip it via the real control after rendering.
function modeSeg(): HTMLElement {
  return document.querySelector(".bt-mode-seg") as HTMLElement;
}
function enterSweepMode() {
  fireEvent.click(within(modeSeg()).getByRole("button", { name: /Sweep/ }));
}
function enterBacktestMode() {
  fireEvent.click(within(modeSeg()).getByRole("button", { name: "Backtest" }));
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

  it("keeps the raw windows value while typing and clamps to 2..50 on blur", () => {
    renderModal();
    const input = screen.getByPlaceholderText("auto") as HTMLInputElement;
    // Two-digit values like 15 must survive typing (no per-keystroke clamp up to 2).
    fireEvent.change(input, { target: { value: "15" } });
    expect(input.value).toBe("15");
    // Below-range on blur clamps up to the minimum.
    fireEvent.change(input, { target: { value: "1" } });
    expect(input.value).toBe("1");
    fireEvent.blur(input);
    expect(input.value).toBe("2");
    // Above-range on blur clamps down to the maximum.
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(input.value).toBe("50");
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
    ruleAction(entry, "Remove");
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

describe("BacktestSettingsModal results side-by-side column", () => {
  it("moves results into a docked column and back", () => {
    renderModal();
    // Default: results are stacked inside the config panel, no column.
    expect(document.querySelector(".bt-results-region")).toBeTruthy();
    expect(document.querySelector(".bt-results-col")).toBeNull();

    // Turn on side-by-side via the footer toggle (the single opener).
    fireEvent.click(screen.getByLabelText("Show results in a side column"));
    const col = document.querySelector(".bt-results-col");
    expect(col).toBeTruthy();
    // The results content lives in the column now, not the stacked region.
    expect(document.querySelector(".bt-results-region")).toBeNull();
    expect(within(col as HTMLElement).getByText(/Run a backtest to see results/)).toBeTruthy();

    // Dock back. Two closers exist while docked (column header + footer toggle).
    const closers = screen.getAllByLabelText("Dock results back into the panel");
    expect(closers.length).toBe(2);
    fireEvent.click(closers[0]);
    expect(document.querySelector(".bt-results-col")).toBeNull();
    expect(document.querySelector(".bt-results-region")).toBeTruthy();
  });
});

describe("operator sweep", () => {
  it("toggles an operator sweep axis and shows the 7-operator chip editor inline", () => {
    renderModal();
    enterSweepMode();
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

  it("a swept indicator length renders its editor inline inside the rule group", () => {
    renderModal();
    enterSweepMode();
    openStrategy();

    const section = groupSection("Buy to open");
    // The left operand's length glyph is the first .sp-sweep inside the rule row.
    const row = ruleRows(section)[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);

    // The swept field renders a RangeChip in place of its value input, inside
    // this group section and nowhere else in the document.
    expect(section.querySelector(".range-chip")).toBeTruthy();
    expect(document.querySelectorAll(".range-chip")).toHaveLength(1);

    // Toggle off via the chip popover's Remove action: gone.
    fireEvent.click(section.querySelector(".range-chip")!);
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(section.querySelector(".range-chip")).toBeNull();
  });

  it("drops a swept const-value axis when the operand switches to an indicator", () => {
    renderModal();
    enterSweepMode();
    openStrategy();

    const section = groupSection("Buy to open");
    const row = ruleRows(section)[0];
    // Make the left operand a Number so its value can be swept.
    const typeSelect = row.querySelector(".bt-operand select") as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "const" } });

    // Sweep the const value: a RangeChip replaces the input and the footer
    // starts counting combos.
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(section.querySelector(".range-chip")).toBeTruthy();
    expect(document.querySelector(".sweep-counter")!.textContent).not.toContain(
      "Turn on a field's sweep toggle to run",
    );

    // Switch the operand back to an indicator: the value leaf is orphaned, so
    // its axis must drop — no stranded chip, and the counter resets.
    fireEvent.change(
      row.querySelector(".bt-operand select") as HTMLSelectElement,
      { target: { value: "EMA" } },
    );
    expect(section.querySelector(".range-chip")).toBeNull();
    expect(document.querySelector(".sweep-counter")!.textContent).toContain(
      "Turn on a field's sweep toggle to run",
    );
  });

  it("a swept exit count renders its editor inline inside its rule group", () => {
    renderModal();
    enterSweepMode();
    openStrategy();

    // Exit groups carry the count field; its glyph is the LAST .sp-sweep in
    // the row (after both operands' length/value glyphs). Tooltip wraps each
    // glyph in its own span, so sibling selectors on .bt-rule-count won't hit it.
    const section = groupSection("Sell to close");
    const row = ruleRows(section)[0];
    const glyphs = row.querySelectorAll(".sp-sweep");
    fireEvent.click(glyphs[glyphs.length - 1]);

    expect(section.querySelector(".range-chip")).toBeTruthy();
    expect(document.querySelectorAll(".range-chip")).toHaveLength(1);
  });
});

describe("time-window sweep", () => {
  it("toggles a time-window sweep axis and lists candidate windows inline", () => {
    const initial = defaultBacktestConfig();
    initial.range.mask = { enabled: true, timeOfDay: { startMin: 480, endMin: 720 }, tz: "UTC" };
    renderModal(initial);
    enterSweepMode();
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

  // Fix 1: removing the LAST window option must drop the axis entirely (like the
  // operator path), not leave a kind:"list" axis with options:[] that makes
  // comboCount return Infinity and strands an axis slot.
  it("removing the last window option drops the axis instead of leaving it empty", () => {
    const initial = defaultBacktestConfig();
    initial.range.mask = { enabled: true, timeOfDay: { startMin: 480, endMin: 720 }, tz: "UTC" };
    renderModal(initial);
    enterSweepMode();
    fireEvent.click(document.querySelector(".bt-tw-sweep-toggle")!);
    const editor = document.querySelector(".bt-tw-sweep")!;
    // seeded with exactly one option (the current window)
    expect(editor.querySelectorAll(".bt-tw-option").length).toBe(1);
    // remove that last option
    fireEvent.click(editor.querySelectorAll(".bt-tw-option button")[0]);
    // the whole editor is gone (axis removed) and the glyph is no longer "on"
    expect(document.querySelector(".bt-tw-sweep")).toBeNull();
    expect(document.querySelector(".bt-tw-sweep-toggle.on")).toBeNull();
  });

  // Fix 2: the window-sweep editor is gated by the SAME !session condition as the
  // toggle glyph. Activating a session preset while a timeWindow axis exists must
  // hide the editor (the axis is kept, not removed: the glyph/editor reappear when
  // the preset is cleared).
  it("hides the window-sweep editor while a session preset is active", () => {
    // A saved preset whose config carries an active session, loadable via the UI.
    const sessionCfg: BacktestConfig = {
      ...defaultBacktestConfig(),
      range: { mode: "bars", bars: 500, history: "full", mask: { enabled: true, session: "NYSE" } },
    };
    saveBacktestPreset("session-preset", sessionCfg);

    const initial = defaultBacktestConfig();
    initial.range.mask = { enabled: true, timeOfDay: { startMin: 480, endMin: 720 }, tz: "UTC" };
    renderModal(initial);
    enterSweepMode();

    // Create the time-window axis: both the glyph and the editor are present
    // (they share the !session gate).
    fireEvent.click(document.querySelector(".bt-tw-sweep-toggle")!);
    expect(document.querySelector(".bt-tw-sweep-toggle")).toBeTruthy();
    expect(document.querySelector(".bt-tw-sweep")).toBeTruthy();

    // Load the session preset: cfg.range.mask.session becomes truthy.
    const presetSelect = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "session-preset"),
    ) as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "session-preset" } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    // Glyph gone (proves the session took effect, independent of the fix) AND the
    // editor gone (the fix under test). The axis itself is still present.
    expect(document.querySelector(".bt-tw-sweep-toggle")).toBeNull();
    expect(document.querySelector(".bt-tw-sweep")).toBeNull();
  });
});

describe("period sweep", () => {
  it("toggles a period sweep axis with an inline windows stepper", () => {
    renderModal();
    enterSweepMode();
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
        { name: "ema_slow", label: "Slow EMA", type: "int" as const, default: 21, min: 5, max: 100, step: 1, options: null, help: null },
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

  it("param sweep editor renders inline inside the params block", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    enterSweepMode();
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    const params = document.querySelector(".strategy-params") as HTMLElement;
    expect(params.querySelector(".range-chip")).toBeNull();

    // Toggle the param's sweep glyph on: a RangeChip replaces the value input
    // INSIDE the params block (inline), not as a sibling after it.
    fireEvent.click(params.querySelector(".sp-sweep")!);
    expect(params.querySelector(".range-chip")).toBeTruthy();
    expect(document.querySelectorAll(".range-chip")).toHaveLength(1);

    // Editing "to" in the chip popover patches the axis: footer combo count
    // grows past 1 run.
    fireEvent.click(params.querySelector(".range-chip")!);
    const nums = [...document.querySelectorAll(".range-chip-field input")] as HTMLInputElement[];
    fireEvent.change(nums[1], { target: { value: "15" } });
    fireEvent.blur(nums[1]);
    expect(document.querySelector(".sweep-counter")!.textContent).not.toContain("1 = 1");

    // Remove from sweep via the popover: chip gone.
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(params.querySelector(".range-chip")).toBeNull();
  });

  it("keeps three sweep axes active at once (no oldest-axis drop)", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    enterSweepMode();
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    const params = document.querySelector(".strategy-params") as HTMLElement;
    const glyphs = params.querySelectorAll(".sp-sweep");
    fireEvent.click(glyphs[0]);   // Fast EMA axis
    fireEvent.click(glyphs[1]);   // Slow EMA axis
    fireEvent.click(document.querySelector(".bt-period-sweep-toggle")!);   // Period axis

    // All three stay on: both param glyphs and the period toggle.
    expect(params.querySelectorAll(".sp-sweep.on")).toHaveLength(2);
    expect(document.querySelector(".bt-period-sweep-toggle")!.className).toContain("on");
    // Footer multiplies three factors: two multiplication signs.
    expect(screen.getByText(/runs$/).textContent?.match(/×/g)).toHaveLength(2);
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
    { combo: { "param:ema_fast": 12 }, metrics: { net_pnl: 10, n_trades: 3, win_rate: 0.5, max_drawdown: 1, profit_factor: 1.2, avg_win_loss_ratio: null, return_pct: 1 }, error: null, windows: null },
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
        initial={initial} epic="TEST" resolution="MINUTE" controller={null} chartTimezone="UTC"
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    enterSweepMode();
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
        initial={initial} epic="TEST" resolution="MINUTE" controller={null} chartTimezone="UTC"
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    enterSweepMode();
    openStrategy();
    await screen.findByText("Fast EMA");
    act(() => sweepStateSignal.set({ rows, done: 2, total: 2, running: false }));

    const row = document.querySelector(".sweep-row") as HTMLElement;
    fireEvent.click(row);

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(loadCodedCfg("backtest", "ema_cross.py").params.ema_fast).toBe(12);
  });
});

describe("rules-mode combo apply", () => {
  // Rules-mode cfg is not persisted to localStorage (unlike coded mode's
  // loadCodedCfg), so applyRuleSweepCombo's result is observed via the cfg it
  // hands to run() -> onRun(next). Capturing that argument inspects the resulting
  // config object itself, not mock-call semantics.
  function renderRules(initial: BacktestConfig) {
    const onRun = vi.fn();
    render(
      <BacktestSettingsModal
        initial={initial} epic="TEST" resolution="MINUTE" controller={null} chartTimezone="UTC"
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    enterSweepMode();
    return onRun;
  }
  function applyCombo(onRun: ReturnType<typeof vi.fn>, combo: SweepRow["combo"]) {
    const rows: SweepRow[] = [
      { combo, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, error: null, windows: null },
    ];
    act(() => sweepStateSignal.set({ rows, done: 1, total: 1, running: false }));
    fireEvent.click(document.querySelector(".sweep-row") as HTMLElement);
    expect(onRun).toHaveBeenCalledTimes(1);
    return onRun.mock.calls[0][0] as BacktestConfig;
  }

  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  it("op combo patches the first ENABLED long entry rule (skips a disabled rule at raw index 0)", () => {
    const initial = defaultBacktestConfig();
    // Raw index 0 is disabled; raw index 1 is the first ENABLED rule. The op axis
    // counts enabled rules only, so "op:long.entry.0" must patch raw index 1.
    initial.longEntry = {
      combine: "AND",
      rules: [
        { left: { kind: "indicator", indicator: "EMA", length: 9 }, op: "lt", right: { kind: "indicator", indicator: "EMA", length: 21 }, enabled: false },
        { left: { kind: "indicator", indicator: "EMA", length: 9 }, op: "crossesAbove", right: { kind: "indicator", indicator: "EMA", length: 21 } },
      ],
    };
    const onRun = renderRules(initial);
    const next = applyCombo(onRun, { "op:long.entry.0": "gt" });
    expect(next.longEntry.rules[1].op).toBe("gt");      // enabled rule patched
    expect(next.longEntry.rules[0].op).toBe("lt");      // disabled rule untouched
    expect(next.longEntry.rules[0].enabled).toBe(false);
  });

  it("period combo switches the range to a custom window (unix seconds -> ms)", () => {
    const onRun = renderRules(defaultBacktestConfig());
    const next = applyCombo(onRun, { "period:from": 1751155200, "period:to": 1751587200 });
    expect(next.range.mode).toBe("custom");
    expect(next.range.fromMs).toBe(1751155200000);
    expect(next.range.toMs).toBe(1751587200000);
  });

  it("timeWindow combo patches the mask window, reads it in the chart tz, and clears any session", () => {
    const initial = defaultBacktestConfig();
    initial.range.mask = { enabled: true, session: "NYSE" };
    const onRun = renderRules(initial);
    // The combo carries a tz, but the run always stamps the chart timezone
    // (chartTimezone="UTC" here) onto the mask, so the combo tz is ignored.
    const next = applyCombo(onRun, {
      "timeWindow:startMin": 540, "timeWindow:endMin": 1050, "timeWindow:tz": "Europe/London",
    });
    expect(next.range.mask?.enabled).toBe(true);
    expect(next.range.mask?.timeOfDay).toEqual({ startMin: 540, endMin: 1050 });
    expect(next.range.mask?.tz).toBe("UTC");
    expect(next.range.mask?.session).toBeUndefined();
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

describe("inline risk sweep editors", () => {
  const strategies = [
    {
      filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
      params: [
        { name: "ema_fast", label: "Fast EMA", type: "int" as const, default: 9, min: 2, max: 50, step: 1, options: null, help: null },
      ],
    },
  ];

  it("coded mode: a swept stop % renders its chip in place inside the risk block", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    enterSweepMode();
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    // Set the LONG stop kind to % so the value field and its glyph render.
    const riskBlocks = [...document.querySelectorAll(".bt-risk")] as HTMLElement[];
    expect(riskBlocks.length).toBe(2);
    const stopKind = riskBlocks[0].querySelectorAll("select")[0];
    fireEvent.change(stopKind, { target: { value: "pct" } });

    // Toggle the stop-value sweep glyph on (sync defaults ON, axis canonical on long).
    fireEvent.click(riskBlocks[0].querySelector(".sp-sweep")!);

    // Chip replaces the value input in the LONG block. Sync mirrors the pct
    // field to the SHORT block too, so the same canonical axis's chip shows in
    // both blocks (renders wherever the field renders).
    expect(riskBlocks[0].querySelector(".range-chip")).toBeTruthy();
    expect(document.querySelectorAll(".range-chip")).toHaveLength(2);
  });

  it("rules mode: with sync on, the short tab shows the synced axis's chip too", () => {
    renderModal();
    enterSweepMode();
    openStrategy();

    // Long tab: set stop kind to %, toggle its sweep glyph.
    const longRisk = document.querySelector(".bt-risk") as HTMLElement;
    fireEvent.change(longRisk.querySelectorAll("select")[0], { target: { value: "pct" } });
    fireEvent.click(longRisk.querySelector(".sp-sweep")!);
    expect(longRisk.querySelector(".range-chip")).toBeTruthy();

    // Switch to the short tab: the same canonical axis's chip is visible there.
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    const shortRisk = document.querySelector(".bt-risk") as HTMLElement;
    expect(shortRisk.querySelector(".range-chip")).toBeTruthy();
  });
});

describe("sweep range memory", () => {
  it("toggling a sweep on recalls the last-run range instead of the heuristic", () => {
    // 30..60 step 3 enumerates 11 values; the heuristic seed would not.
    recordSweepRanges("rules", [
      { kind: "range", target: "rule:long.entry.0.left.length", label: "len", from: 30, to: 60, step: 3 },
    ]);
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    // Footer combo count proves the recalled range seeded the axis: 11 runs.
    expect(screen.getByText(/runs$/).textContent).toContain("11");
  });

  it("running a sweep records each range axis's from/to/step", () => {
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(recallSweepRange("rules", "rule:long.entry.0.left.length")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run sweep" }));
    const rec = recallSweepRange("rules", "rule:long.entry.0.left.length");
    expect(rec).not.toBeNull();
    expect(rec!.step).toBeGreaterThan(0);
  });
});

describe("persistent sweep setup", () => {
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  it("restores the axis set after unmount/remount", () => {
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(document.querySelector(".range-chip")).toBeTruthy();
    cleanup();
    // Sweep mode is device-local persisted too, so the remount restores it.
    renderModal();
    openStrategy();
    expect(document.querySelector(".range-chip")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run sweep" })).toBeTruthy();
  });

  it("prunes a stored axis whose rule no longer exists", () => {
    saveSweepAxes("rules", [
      { kind: "range", target: "rule:long.entry.5.left.length", label: "stale", from: 1, to: 2, step: 1 },
    ]);
    renderModal();
    enterSweepMode();
    openStrategy();
    // The stale axis must not survive restore: no editor, and Run sweep stays
    // unavailable because no axis is configured.
    expect(document.querySelector(".range-chip")).toBeNull();
    expect((screen.getByRole("button", { name: "Run sweep" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applying a combo flips to Backtest mode but keeps the axes and the results table one flip away", () => {
    const onRun = vi.fn();
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()} epic="TEST" resolution="MINUTE" controller={null} chartTimezone="UTC"
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    const rows: SweepRow[] = [
      { combo: { "rule:long.entry.0.left.length": 30 }, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, windows: null, error: null },
    ];
    act(() => sweepStateSignal.set({ rows, done: 1, total: 1, running: false }));
    fireEvent.click(document.querySelector(".sweep-row") as HTMLElement);
    expect(onRun).toHaveBeenCalledTimes(1);
    // The run that just fired was a plain backtest, not a sweep.
    expect(sweepAxesSignal.value).toEqual([]);
    // Apply lands you in Backtest mode so the follow-up run's result shows.
    expect(screen.getByRole("button", { name: "Run backtest" })).toBeTruthy();
    expect(document.querySelector(".sweep-panel")).toBeNull();
    // The sweep table AND the configured axes survive one flip away.
    expect(sweepStateSignal.value).not.toBeNull();
    enterSweepMode();
    expect(document.querySelector(".sweep-panel")).toBeTruthy();
    expect(document.querySelector(".range-chip")).toBeTruthy();
    // A second row click (same single row here) still applies and re-runs.
    fireEvent.click(document.querySelector(".sweep-row") as HTMLElement);
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it("replaces a swept field's input with a RangeChip, and restores it on remove", () => {
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    const before = row.querySelectorAll("input.bt-operand-length").length;
    fireEvent.click(row.querySelector(".sp-sweep")!);
    // The swept field's value input is gone, replaced by its RangeChip.
    expect(row.querySelectorAll("input.bt-operand-length").length).toBe(before - 1);
    expect(row.querySelector(".range-chip")).toBeTruthy();
    // Removing the sweep from the chip popover restores the plain input.
    fireEvent.click(row.querySelector(".range-chip")!);
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(row.querySelectorAll("input.bt-operand-length").length).toBe(before);
    expect(row.querySelector(".range-chip")).toBeNull();
  });

  it("toggling the last axis off disables Run sweep and persists the cleared set", () => {
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    const runBtn = () => screen.getByRole("button", { name: "Run sweep" }) as HTMLButtonElement;
    expect(runBtn().disabled).toBe(false);
    // Off again via the chip popover's Remove action.
    fireEvent.click(row.querySelector(".range-chip")!);
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(document.querySelector(".range-chip")).toBeNull();
    expect(runBtn().disabled).toBe(true);
    // The empty set is what persists: a remount must not resurrect the axes.
    cleanup();
    renderModal();
    openStrategy();
    expect(document.querySelector(".range-chip")).toBeNull();
    expect(runBtn().disabled).toBe(true);
  });

  it("mode switch round-trip restores each mode's own axes", () => {
    renderModal();
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(document.querySelector(".range-chip")).toBeTruthy();
    // The User Defined|Built-in segmented switch reuses the vertical tab's "Strategy"
    // label; the seg button is the one that is NOT inside .bt-htabs.
    const segStrategy = screen
      .getAllByRole("button", { name: "Built-in" })
      .find((b) => !b.closest(".bt-htabs"))!;
    fireEvent.click(segStrategy);
    expect(document.querySelector(".range-chip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "User Defined" }));
    expect(document.querySelector(".range-chip")).toBeTruthy();
  });

  it("prunes a stored param axis the file no longer declares when entering coded mode via the mode switch", async () => {
    saveSweepAxes("coded.ema_cross.py", [
      { kind: "range", target: "param:gone", label: "gone", from: 1, to: 2, step: 1 },
    ]);
    const strategies = [
      {
        filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
        params: [
          { name: "ema_fast", label: "Fast EMA", type: "int" as const, default: 9, min: 2, max: 50, step: 1, options: null, help: null },
        ],
      },
    ];
    mockStrategies.mockResolvedValue(strategies);
    renderModal({ ...defaultBacktestConfig(), codedStrategy: "ema_cross.py" });
    enterSweepMode();
    openStrategy();
    const segStrategy = screen
      .getAllByRole("button", { name: "Built-in" })
      .find((b) => !b.closest(".bt-htabs"))!;
    fireEvent.click(segStrategy);
    // Let the strategy schema land so the param prune can validate against it.
    // The prune runs in a passive effect after that render, so wait for its
    // outcome instead of asserting synchronously.
    await screen.findByText("Fast EMA");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Run sweep" }) as HTMLButtonElement).disabled).toBe(true));
    expect(document.querySelector(".range-chip")).toBeNull();
  });
});

describe("sweep footer estimate + compute toggle", () => {
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
    sweepTargetSignal.set("local");
  });

  // A range axis resolving against the default long-entry rule, big enough to
  // exceed SWEEP_WARN_COMBOS (1000): 1..2001 step 1 enumerates 2001 combos.
  const bigAxis = () =>
    saveSweepAxes("rules", [
      { kind: "range", target: "rule:long.entry.0.left.length", label: "len", from: 1, to: 2001, step: 1 },
    ]);

  it("marks the estimate amber past 1000 combos but keeps Run sweep enabled", () => {
    bigAxis();
    renderModal();
    enterSweepMode();
    const est = document.querySelector(".bt-sweep-estimate") as HTMLElement;
    expect(est).toBeTruthy();
    expect(est.className).toContain("bt-sweep-warn");
    expect(est.textContent).toContain("2001 combos");
    // The combo count must never gate the Run button.
    const run = screen.getByRole("button", { name: "Run sweep" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
  });

  it("shows a runtime estimate when a pace has been recorded for this epic/tf/target", () => {
    // 2001 combos * 200ms = 400200ms -> about 7m.
    recordSweepPace("TEST", "MINUTE", "local", 200);
    bigAxis();
    renderModal();
    enterSweepMode();
    const est = document.querySelector(".bt-sweep-estimate") as HTMLElement;
    expect(est.textContent).toBe("2001 combos, about 7m on this run target");
  });

  it("hides the Compute toggle when remote compute is not configured", async () => {
    mockComputeStatus.mockResolvedValue({ remoteConfigured: false });
    bigAxis();
    renderModal();
    enterSweepMode();
    // Let the mount fetch resolve; the toggle must stay absent.
    await waitFor(() => expect(mockComputeStatus).toHaveBeenCalled());
    expect(document.querySelector(".bt-compute-toggle")).toBeNull();
  });

  it("shows the Compute toggle once remote compute is configured", async () => {
    mockComputeStatus.mockResolvedValue({ remoteConfigured: true });
    bigAxis();
    renderModal();
    enterSweepMode();
    await waitFor(() => expect(document.querySelector(".bt-compute-toggle")).toBeTruthy());
    const toggle = document.querySelector(".bt-compute-toggle") as HTMLElement;
    expect(within(toggle).getByRole("button", { name: "Local" })).toBeTruthy();
    expect(within(toggle).getByRole("button", { name: "Remote" })).toBeTruthy();
  });

  it("clicking Remote writes the sweep-target signal and persists it", async () => {
    mockComputeStatus.mockResolvedValue({ remoteConfigured: true });
    bigAxis();
    renderModal();
    enterSweepMode();
    await waitFor(() => expect(document.querySelector(".bt-compute-toggle")).toBeTruthy());
    const toggle = document.querySelector(".bt-compute-toggle") as HTMLElement;
    fireEvent.click(within(toggle).getByRole("button", { name: "Remote" }));
    expect(sweepTargetSignal.value).toBe("remote");
    expect(localStorage.getItem("auto-trader.sweepTarget")).toBe(JSON.stringify("remote"));
  });
});

describe("backtest | sweep mode switch", () => {
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  const rows: SweepRow[] = [
    { combo: { "rule:long.entry.0.left.length": 30 }, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, windows: null, error: null },
  ];

  it("flipping the mode flips the results view without clearing either result set", () => {
    renderModal();
    enterSweepMode();
    act(() => sweepStateSignal.set({ rows, done: 1, total: 1, running: false }));
    expect(document.querySelector(".sweep-panel")).toBeTruthy();
    enterBacktestMode();
    // Backtest view shows; the sweep state survives untouched behind it.
    expect(document.querySelector(".sweep-panel")).toBeNull();
    expect(sweepStateSignal.value).not.toBeNull();
    enterSweepMode();
    expect(document.querySelector(".sweep-panel")).toBeTruthy();
  });

  it("Run in Backtest mode publishes no axes even when axes are configured", () => {
    const onRun = vi.fn();
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()} epic="TEST" resolution="MINUTE" controller={null} chartTimezone="UTC"
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    enterSweepMode();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    enterBacktestMode();
    fireEvent.click(screen.getByRole("button", { name: "Run backtest" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    // The mode gates the run: BacktestButton must see an empty axis set.
    expect(sweepAxesSignal.value).toEqual([]);
  });

  it("sweep toggles are inert in Backtest mode", () => {
    renderModal();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);   // no-op in Backtest mode
    enterSweepMode();
    expect(document.querySelector(".range-chip")).toBeNull();
  });

  it("shows sweep progress on the Sweep segment while in Backtest mode", () => {
    renderModal();
    act(() => sweepStateSignal.set({ rows, done: 1, total: 4, running: true }));
    expect(modeSeg().querySelector(".bt-mode-badge")?.textContent).toBe("1/4");
  });
});

describe("clear sweep results", () => {
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  const rows: SweepRow[] = [
    { combo: { "rule:long.entry.0.left.length": 30 }, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, windows: null, error: null },
  ];

  it("shows Clear results only when a sweep is finished, and clicking it clears the table", () => {
    renderModal();
    enterSweepMode();
    act(() => sweepStateSignal.set({ rows, done: 1, total: 2, running: true }));
    // While running: Cancel, no Clear.
    expect(screen.getByRole("button", { name: "Cancel sweep" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear results" })).toBeNull();
    act(() => sweepStateSignal.set({ rows, done: 2, total: 2, running: false }));
    expect(screen.queryByRole("button", { name: "Cancel sweep" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear results" }));
    expect(sweepStateSignal.value).toBeNull();
    expect(document.querySelector(".sweep-panel")).toBeNull();
  });
});
