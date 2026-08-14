// @vitest-environment jsdom
// The Built-in strategy guide: a "Guide" button on StrategyPicker opens a
// formatted document (sections + SVG diagrams + parameter table) for the
// selected strategy. Guides exist only for the shipped built-ins; files
// without one show no button.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import StrategyPicker from "./StrategyPicker";
import type { StrategyInfo } from "./api";

afterEach(cleanup);

const bbParams = [
  {
    name: "bb_period",
    label: "BB period",
    type: "int" as const,
    default: 20,
    min: 2,
    max: 200,
    step: 1,
    options: null,
    help: null,
  },
  {
    name: "squeeze_pctile",
    label: "Squeeze percentile",
    type: "float" as const,
    default: 25,
    min: 1,
    max: 100,
    step: null,
    options: null,
    help: "Band width at or below this percentile of its lookback counts as consolidation.",
  },
];

function makeStrategy(over: Partial<StrategyInfo>): StrategyInfo {
  return {
    filename: "bb_regime_breakout.py",
    name: "BB Regime Breakout",
    description: "Trend/regime breakout on Bollinger Bands.",
    hedged: false,
    error: null,
    params: bbParams,
    ...over,
  };
}

function renderPicker(list: StrategyInfo[], value = list[0]?.filename) {
  return render(
    <StrategyPicker
      value={value}
      onChange={() => {}}
      list={list}
      loadError={null}
      onReload={() => {}}
    />,
  );
}

describe("strategy guide", () => {
  it("opens the illustrated guide from a single click on the Guide button", () => {
    renderPicker([makeStrategy({})]);

    fireEvent.click(screen.getByRole("button", { name: /guide/i }));

    const dialog = screen.getByRole("dialog", { name: /BB Regime Breakout/ });
    // Formatted sections, not the raw docstring wall.
    expect(dialog.textContent).toContain("The squeeze");
    expect(dialog.textContent).toContain("The breakout");
    // Graphical example: at least one SVG diagram with an accessible title.
    expect(dialog.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("renders the parameter table from the live strategy meta", () => {
    renderPicker([makeStrategy({})]);
    fireEvent.click(screen.getByRole("button", { name: /guide/i }));

    const dialog = screen.getByRole("dialog", { name: /BB Regime Breakout/ });
    expect(dialog.textContent).toContain("Squeeze percentile");
    expect(dialog.textContent).toContain(
      "Band width at or below this percentile of its lookback counts as consolidation.",
    );
  });

  it("closes on Escape", () => {
    renderPicker([makeStrategy({})]);
    fireEvent.click(screen.getByRole("button", { name: /guide/i }));
    expect(screen.getByRole("dialog", { name: /BB Regime Breakout/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /BB Regime Breakout/ })).toBeNull();
  });

  it("shows no Guide button for a strategy file without a guide", () => {
    renderPicker([
      makeStrategy({ filename: "my_custom.py", name: "My Custom", params: [] }),
    ]);
    expect(screen.queryByRole("button", { name: /guide/i })).toBeNull();
  });

  it("has a guide for every shipped built-in strategy", async () => {
    const { strategyGuides } = await import("./strategyGuides");
    for (const file of [
      "bb_regime_breakout.py",
      "sim_consensus.py",
      "slope_acceleration.py",
      "trend_pullback.py",
    ]) {
      expect(strategyGuides[file], `missing guide for ${file}`).toBeTruthy();
      expect(strategyGuides[file].sections.length).toBeGreaterThan(1);
    }
  });
});
