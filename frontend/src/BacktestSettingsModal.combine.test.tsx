// @vitest-environment jsdom
//
// The per-group AND/OR combiner in a rule group's section header. It only shows
// up once a group has something to combine (>= 2 rules), defaults to AND, and
// emits the whole group back with `combine` swapped.
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { RuleGroupSection } from "./BacktestSettingsModal";

const twoRules = {
  combine: "AND" as const,
  rules: [
    { expr: "candle.close > 1", enabled: true },
    { expr: "candle.close > 2", enabled: true },
  ],
};

describe("RuleGroupSection combine toggle", () => {
  afterEach(() => cleanup());

  it("renders AND/OR for a multi-rule group and emits the switch", () => {
    const onChange = vi.fn();
    render(
      <RuleGroupSection title="Buy to open" group={twoRules} onChange={onChange} emptyHint="none" />,
    );
    // AND is the checked option out of the box.
    expect(screen.getByRole("radio", { name: "AND" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "OR" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "OR" }));
    // The whole group travels back, so the rules survive the switch.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ combine: "OR", rules: twoRules.rules }),
    );
  });

  it("treats a group with no `combine` as AND", () => {
    render(
      <RuleGroupSection
        title="Buy to open"
        group={{ rules: twoRules.rules }}
        onChange={vi.fn()}
        emptyHint="none"
      />,
    );
    expect(screen.getByRole("radio", { name: "AND" }).getAttribute("aria-checked")).toBe("true");
  });

  it("hides the toggle for a single-rule group", () => {
    const one = { combine: "AND" as const, rules: [{ expr: "candle.close > 1", enabled: true }] };
    render(
      <RuleGroupSection title="Buy to open" group={one} onChange={() => {}} emptyHint="none" />,
    );
    expect(screen.queryByRole("radiogroup", { name: /combine/i })).toBeNull();
  });

  it("hides the toggle for an empty group", () => {
    render(
      <RuleGroupSection
        title="Buy to open"
        group={{ combine: "AND", rules: [] }}
        onChange={() => {}}
        emptyHint="none"
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: /combine/i })).toBeNull();
  });
});
