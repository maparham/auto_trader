// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
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

describe("BacktestSettingsModal rule duplicate/copy/paste", () => {
  it("duplicating a rule inserts an independent copy right after it", () => {
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()}
        epic="TEST"
        resolution="MINUTE"
        onRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Long side is shown first; its "Buy to open (long)" group has one rule.
    const entry = groupSection("Buy to open (long)");
    expect(ruleRows(entry)).toHaveLength(1);
    fireEvent.click(within(entry).getByLabelText("Duplicate rule"));
    expect(ruleRows(entry)).toHaveLength(2);
  });

  it("copy then paste appends the rule to a group on the other side", () => {
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()}
        epic="TEST"
        resolution="MINUTE"
        onRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Copy the long-entry rule.
    const longEntry = groupSection("Buy to open (long)");
    fireEvent.click(within(longEntry).getByLabelText("Copy rule"));

    // Switch to the short side and paste into its entry group.
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    const shortEntry = groupSection("Sell to open (short)");
    expect(ruleRows(shortEntry)).toHaveLength(1);
    fireEvent.click(within(shortEntry).getByRole("button", { name: "Paste rule" }));
    expect(ruleRows(shortEntry)).toHaveLength(2);
  });

  it("hides Paste until a rule has been copied", () => {
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()}
        epic="TEST"
        resolution="MINUTE"
        onRun={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Paste rule" })).toBeNull();
    fireEvent.click(within(groupSection("Buy to open (long)")).getAllByLabelText("Copy rule")[0]);
    expect(screen.getAllByRole("button", { name: "Paste rule" }).length).toBeGreaterThan(0);
  });
});
