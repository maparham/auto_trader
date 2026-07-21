// @vitest-environment jsdom
//
// Per-literal sweep chips on expression rows. Renders RuleGroupSection in expr
// mode and drives the literal sweep sub-row (toggle chip -> RangeChip).
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { RuleGroupSection } from "./BacktestSettingsModal";
import type { RangeAxis } from "./lib/sweep";

function baseSweep(overrides: Record<string, unknown> = {}) {
  return {
    axes: [] as RangeAxis[],
    side: "long" as const,
    group: "entry" as const,
    editable: true,
    onToggle: vi.fn(),
    onToggleOp: vi.fn(),
    onTickOp: vi.fn(),
    onAxisChange: vi.fn(),
    ...overrides,
  };
}

describe("RuleGroupSection (expression literal sweep)", () => {
  afterEach(() => cleanup());

  it("renders a toggle chip per literal and toggles with the RAW row index target", () => {
    const onToggle = vi.fn();
    const sweep = baseSweep({ onToggle });
    const { container, getByText } = render(
      <RuleGroupSection
        title="Buy to open"
        group={{ rules: [{ expr: "EMA(50) > 30", enabled: true }] }}
        onChange={vi.fn()}
        emptyHint="none"
        baseResolution="HOUR"
        isExit={false}
        sweep={sweep}
      />,
    );

    expect(container.querySelector(".bt-lit-sweep-row")).toBeTruthy();
    // First literal is "EMA length" with value 50.
    const chip = getByText(/EMA length/);
    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledWith("lit:long.entry.0.0", 50);
  });

  it("uses the RAW full-list row index, not the enabled-only index", () => {
    // A disabled row BEFORE the enabled one makes RAW index (1) diverge from
    // activeRuleIndex (0). The disabled row renders no chips, so /EMA length/
    // resolves uniquely to the enabled row at raw index 1.
    const onToggle = vi.fn();
    const sweep = baseSweep({ onToggle });
    const { getByText } = render(
      <RuleGroupSection
        title="Buy to open"
        group={{
          rules: [
            { expr: "RSI(14) > 70", enabled: false },
            { expr: "EMA(50) > 30", enabled: true },
          ],
        }}
        onChange={vi.fn()}
        emptyHint="none"
        baseResolution="HOUR"
        isExit={false}
        sweep={sweep}
      />,
    );

    fireEvent.click(getByText(/EMA length/));
    // RAW index -> ...1.0. activeRuleIndex would wrongly give ...0.0.
    expect(onToggle).toHaveBeenCalledWith("lit:long.entry.1.0", 50);
  });

  it("renders a RangeChip when a range axis exists for a literal", () => {
    const axis: RangeAxis = {
      kind: "range",
      target: "lit:long.entry.0.0",
      label: "EMA length",
      from: 10,
      to: 100,
      step: 10,
    };
    const sweep = baseSweep({ axes: [axis] });
    const { container } = render(
      <RuleGroupSection
        title="Buy to open"
        group={{ rules: [{ expr: "EMA(50) > 30", enabled: true }] }}
        onChange={vi.fn()}
        emptyHint="none"
        baseResolution="HOUR"
        isExit={false}
        sweep={sweep}
      />,
    );

    // The range axis renders as a RangeChip (range-chip), not a bare toggle.
    expect(container.querySelector(".bt-lit-axis")).toBeTruthy();
    expect(container.querySelector(".range-chip")).toBeTruthy();
  });

  it("renders no literal sweep row when editable is false", () => {
    const sweep = baseSweep({ editable: false });
    const { container } = render(
      <RuleGroupSection
        title="Buy to open"
        group={{ rules: [{ expr: "EMA(50) > 30", enabled: true }] }}
        onChange={vi.fn()}
        emptyHint="none"
        baseResolution="HOUR"
        isExit={false}
        sweep={sweep}
      />,
    );

    expect(container.querySelector(".bt-lit-sweep-row")).toBeNull();
  });
});
