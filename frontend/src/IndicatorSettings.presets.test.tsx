// @vitest-environment jsdom
// Applying a preset recreates the instance and the form must re-read THAT,
// not the snapshot Cancel keeps: the first cut seeded calcParams from the
// Cancel snapshot, so the box kept the old value while the chart drew the
// preset's, and Ok then wrote the old value back. Nothing is stored before
// Ok; Ok stores the form.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";
import { TRENDLINES_DEFAULTS } from "./lib/indicators/trendlinesOutputs";

installMemStorage();

// The live instance the chart hands out; applyIndicator swaps it for one
// built from the config it was given, as the real recreate path does.
const live = {
  paneId: "candle_pane",
  name: "TRENDLINES",
  calcParams: [...Object.values(TRENDLINES_DEFAULTS)],
  extendData: { indType: "TRENDLINES" } as Record<string, unknown>,
  figures: [],
  styles: {},
};
vi.mock("./lib/indicators", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/indicators")>();
  return {
    ...real,
    removeIndicatorById: vi.fn(),
    applyIndicator: vi.fn((_c, _s, _e, _inst, opts?: { config?: { calcParams?: number[] } }) => {
      live.calcParams = opts?.config?.calcParams ?? [...Object.values(TRENDLINES_DEFAULTS)];
      return "candle_pane";
    }),
  };
});
import IndicatorSettings from "./IndicatorSettings";
import { loadIndicatorConfigs, saveIndicatorPreset } from "./lib/persist";

afterEach(cleanup);

const chart = {
  getIndicators: () => [live],
  overrideIndicator: () => true,
  getStyles: () => ({ indicator: { lines: [] } }),
  getDataList: () => [],
} as never;

function open() {
  render(
    <IndicatorSettings
      chart={chart}
      scope="tab.test"
      epic="US100"
      brokerId="capital"
      chartResolution="DAY"
      paneId="candle_pane"
      name="TRENDLINES"
      cellId="cell.test"
      onClose={vi.fn()}
    />,
  );
}

describe("applying a preset", () => {
  it("fills the form from the recreated instance, keeps the modal open, and stores only on Ok", () => {
    const preset = [...Object.values(TRENDLINES_DEFAULTS)];
    preset[0] = 7; // Min Pivot Length
    saveIndicatorPreset("TRENDLINES", "7 bars", { calcParams: preset });
    open();
    const box = () => screen.getByLabelText("Min Pivot Length") as HTMLInputElement;
    expect(box().value).toBe(String(Object.values(TRENDLINES_DEFAULTS)[0]));

    fireEvent.click(screen.getByText("Defaults ▾"));
    fireEvent.click(screen.getByText("7 bars").closest("li")!);

    expect(box().value).toBe("7");
    expect(screen.getByText("Ok")).toBeTruthy();
    expect(loadIndicatorConfigs("tab.test")["TRENDLINES"]).toBeUndefined();

    fireEvent.click(screen.getByText("Ok"));
    expect(loadIndicatorConfigs("tab.test")["TRENDLINES"]?.calcParams?.[0]).toBe(7);
  });
});
