// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IndicatorSettings from "./IndicatorSettings";

afterEach(cleanup);

function open(extendData: object = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const ind = {
    paneId: "candle_pane",
    name: "AUTO_FIB",
    calcParams: [5, 0],
    extendData: { indType: "AUTO_FIB", ...extendData },
    figures: [],
    styles: {},
  };
  const chart = {
    getIndicators: () => [ind],
    overrideIndicator: (o: { extendData?: Record<string, unknown> }) => {
      if (o.extendData) writes.push(o.extendData);
      return true;
    },
    getStyles: () => ({ indicator: { lines: [] } }),
    getDataList: () => [],
  };
  render(
    <IndicatorSettings
      chart={chart as never}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="DAY"
      paneId="candle_pane"
      name="AUTO_FIB"
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
  return writes;
}

describe("Auto Fib settings", () => {
  it("offers Past fibs and a timeframe pin on the Inputs tab", () => {
    open();
    // The value is not asserted: a 0 in a number box can render empty (the
    // off-sentinel draft rule), which is not what this pins.
    expect(screen.getByLabelText("Past fibs")).toBeTruthy();
    // Only pinnable types render this checkbox; the fallback shows a disabled select.
    expect(screen.getAllByText("Wait for timeframe closes").length).toBeGreaterThan(0);
  });

  it("edits the levels from the Style tab as a plain extendData write", () => {
    const writes = open();
    fireEvent.click(screen.getByRole("button", { name: "Style" }));
    fireEvent.click(screen.getByLabelText("Level 0.236"));
    const fib = writes.at(-1)?.fib as { levels: Array<{ enabled: boolean }>; extend: string };
    expect(fib.levels[1].enabled).toBe(false);
    // A pane with no saved fib starts extended right.
    expect(fib.extend).toBe("right");
  });
});
