// @vitest-environment jsdom
// The "Reference name" field is gated on EXPR_INSTANCE_TYPES alone, but every
// pane type also carries its own render branches on the Inputs tab — S/R Levels
// is excluded from several of them (its figure lines are draw-suppressed). This
// pins that the field actually reaches the screen for a rule-referenceable pane
// whose Inputs tab is otherwise special-cased, and stays absent for one that no
// rule can name by instance.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";
import { SR_LEVELS_DEFAULTS } from "./lib/indicators/srLevelsOutputs";

afterEach(cleanup);

function open(type: string, calcParams: number[]) {
  const ind = {
    paneId: "candle_pane",
    name: type,
    calcParams,
    extendData: { indType: type },
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: () => true,
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  } as never;
  render(
    <IndicatorSettings
      chart={chart}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="HOUR"
      paneId="candle_pane"
      name={type}
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
}

describe("Reference name field", () => {
  it("renders for an S/R Levels pane, seeded with its current id", () => {
    open("SR_LEVELS", [...Object.values(SR_LEVELS_DEFAULTS)]);
    const box = screen.getByLabelText("Reference name") as HTMLInputElement;
    expect(box.type).toBe("text");
    expect(box.value).toBe("SR_LEVELS");
  });

  it("stays absent for a pane no rule can name by instance", () => {
    open("EMA", [9]);
    expect(screen.queryByLabelText("Reference name")).toBeNull();
  });
});
