// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// The modal now threads openChartPicker -> enumerateChartOperands, which pulls in
// backtestSeries -> customIndicators, which reads LineType at module load (AVWAP
// line style table); stub klinecharts' runtime surface like backtestSeries.test.ts /
// overlays.test.ts / chartOperand.test.ts do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";

// See VisibilityTab.test.tsx: vitest isn't run with jest-style globals, so RTL's
// automatic cleanup never registers. Without this each render leaks into the next.
afterEach(cleanup);

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

function renderModal() {
  return render(
    <BacktestSettingsModal
      initial={defaultBacktestConfig()}
      epic="TEST"
      resolution="MINUTE"
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
// open it before the Long/Short groups exist in the DOM.
function openStrategy() {
  fireEvent.click(screen.getByRole("button", { name: "Strategy" }));
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
  it("an empty rule group offers '+ Rule from chart' and opens the picker", () => {
    renderModal();
    openStrategy();
    // Empty the seeded "Buy to open" group so the empty-state entry point (the
    // reported bug — no pre-added rule needed) is what's actually exercised.
    const entry = groupSection("Buy to open");
    fireEvent.click(within(entry).getByLabelText("Delete rule"));
    expect(ruleRows(entry)).toHaveLength(0);
    // Both the empty-state hint and the footer offer it once the group is empty.
    const btns = within(entry).getAllByRole("button", { name: "+ Rule from chart" });
    expect(btns.length).toBeGreaterThan(0);
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
