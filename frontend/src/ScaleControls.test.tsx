// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "./lib/testMemStorage";
installMemStorage();

import { ScaleControls } from "./ToolbarControls";
import { ChartController } from "./lib/chartController";
import type { Chart } from "klinecharts";
import { DEFAULT_FIT_GAP, STRETCHED_FIT_GAP } from "./chart/candleFit";

const SCOPE = "tab.T.cell.c";

// Minimal chart stub: ScaleControls only ever writes the candle pane's y-axis.
function makeChart() {
  const overrides: Array<Record<string, unknown>> = [];
  const chart = {
    overrideYAxis: (o: Record<string, unknown>) => void overrides.push(o),
  } as unknown as Chart;
  return { chart, overrides, lastGap: () => overrides.at(-1)?.gap };
}

function mount() {
  const { chart, overrides, lastGap } = makeChart();
  const controller = new ChartController("cell-1", SCOPE);
  controller.chart = chart;
  render(<ScaleControls controller={controller} />);
  return { controller, overrides, lastGap };
}

const stretchBtn = () => screen.getByLabelText("Stretch price scale") as HTMLButtonElement;
const autoBtn = () => screen.getByRole("button", { name: "A" }) as HTMLButtonElement;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("ScaleControls stretch toggle", () => {
  it("sits dim on a default chart and lights up while stretched", async () => {
    const user = userEvent.setup();
    mount();
    expect(stretchBtn().className).not.toContain("on");

    await user.click(stretchBtn());
    expect(stretchBtn().className).toContain("on");
  });

  it("writes the stretched gap onto the chart, and the default gap back off", async () => {
    const user = userEvent.setup();
    const { lastGap } = mount();

    await user.click(stretchBtn());
    expect(lastGap()).toEqual(STRETCHED_FIT_GAP);

    await user.click(stretchBtn());
    expect(lastGap()).toEqual(DEFAULT_FIT_GAP);
  });

  it("restores the stretched fit on a later mount of the same cell", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.click(stretchBtn());
    expect(first.controller.priceFitMode.value).toBe("stretched");

    cleanup();
    // A remount builds a fresh controller from storage, the way a page reload does.
    const second = mount();
    expect(second.controller.priceFitMode.value).toBe("stretched");
    expect(stretchBtn().className).toContain("on");
  });

  it("leaves the toggle off after a mount with nothing stored", () => {
    const { controller } = mount();
    expect(controller.priceFitMode.value).toBe("default");
    expect(stretchBtn().className).not.toContain("on");
  });

  it("un-stretches when 'A' re-fits, so the two controls agree", async () => {
    const user = userEvent.setup();
    const { controller, lastGap } = mount();
    await user.click(stretchBtn());

    await user.click(autoBtn());
    expect(controller.priceFitMode.value).toBe("default");
    expect(lastGap()).toEqual(DEFAULT_FIT_GAP);
    expect(stretchBtn().className).not.toContain("on");

    // …and the reset is stored too: a reload must not come back stretched.
    cleanup();
    expect(mount().controller.priceFitMode.value).toBe("default");
  });
});
