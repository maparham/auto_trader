import { describe, it, expect } from "vitest";
import {
  DEFAULT_FIT_GAP,
  STRETCHED_FIT_GAP,
  fitGap,
  nextFitMode,
  isAutoFitted,
  applyCandleFit,
  type PriceFitMode,
} from "./candleFit";

describe("fitGap", () => {
  it("reproduces klinecharts' own candle-pane margins in both default modes", () => {
    // The default must MATCH the framework default, or plain auto-fit would
    // shift the moment anything re-applies the gap.
    expect(fitGap("default")).toEqual({ top: 0.2, bottom: 0.1 });
    expect(fitGap("refit")).toEqual(DEFAULT_FIT_GAP);
  });

  it("leaves only a sliver of headroom when stretched", () => {
    expect(fitGap("stretched")).toEqual(STRETCHED_FIT_GAP);
    const { top, bottom } = fitGap("stretched");
    // Candles occupy 1 / (1 + top + bottom) of the pane: keep that above 90%.
    expect(1 / (1 + top + bottom)).toBeGreaterThan(0.9);
  });

  it("keeps both gaps below 1, where klinecharts switches to pixel units", () => {
    for (const mode of ["default", "refit", "stretched"] as PriceFitMode[]) {
      expect(fitGap(mode).top).toBeLessThan(1);
      expect(fitGap(mode).bottom).toBeLessThan(1);
    }
  });
});

describe("nextFitMode", () => {
  it("re-fits to the default margins on the first double-click", () => {
    expect(nextFitMode({ autoFitted: true, mode: "default" })).toBe("refit");
  });

  it("stretches on the second double-click", () => {
    expect(nextFitMode({ autoFitted: true, mode: "refit" })).toBe("stretched");
  });

  it("returns to the default margins on the third, then alternates", () => {
    expect(nextFitMode({ autoFitted: true, mode: "stretched" })).toBe("refit");
    expect(nextFitMode({ autoFitted: true, mode: "refit" })).toBe("stretched");
  });

  it("undoes a manual scale before resuming the cycle", () => {
    // Dragging or wheeling the axis clears klinecharts' auto-fit flag. The
    // double-click that follows means "undo my scaling", so it lands on the
    // default margins whatever mode was active — and re-arms, so the NEXT one
    // stretches.
    expect(nextFitMode({ autoFitted: false, mode: "stretched" })).toBe("refit");
    expect(nextFitMode({ autoFitted: false, mode: "refit" })).toBe("refit");
    expect(nextFitMode({ autoFitted: false, mode: "default" })).toBe("refit");
  });
});

describe("isAutoFitted", () => {
  const chartWith = (flag: boolean) => ({
    getYAxes: () => [{ getAutoCalcTickFlag: () => flag }],
  });

  it("reads klinecharts' own auto-calc flag", () => {
    expect(isAutoFitted(chartWith(true))).toBe(true);
    expect(isAutoFitted(chartWith(false))).toBe(false);
  });

  it("assumes auto-fit when the flag is unavailable, keeping the cycle usable", () => {
    // The flag lives on AxisImp, not the published YAxis type; a build that
    // drops it must not make the stretched mode unreachable.
    expect(isAutoFitted({ getYAxes: () => [{}] })).toBe(true);
    expect(isAutoFitted({ getYAxes: () => [] })).toBe(true);
  });
});

function makeChart() {
  const calls: unknown[] = [];
  return {
    calls,
    overrideYAxis(arg: unknown) {
      calls.push(arg);
    },
  };
}

describe("applyCandleFit", () => {
  it("writes the gap onto the candle pane in one override", () => {
    const chart = makeChart();
    applyCandleFit(chart, "stretched");
    expect(chart.calls).toEqual([{ paneId: "candle_pane", gap: STRETCHED_FIT_GAP }]);
  });

  it("re-asserts the default gap, so it also serves as the re-fit", () => {
    const chart = makeChart();
    applyCandleFit(chart, "refit");
    expect(chart.calls).toEqual([{ paneId: "candle_pane", gap: DEFAULT_FIT_GAP }]);
  });

  it("contains a throw from klinecharts' synchronous repaint", () => {
    const chart = {
      overrideYAxis() {
        throw new Error("x-axis tick formatting on a NaN scroll offset");
      },
    };
    expect(() => applyCandleFit(chart, "stretched")).not.toThrow();
  });
});
