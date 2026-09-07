// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("klinecharts", async (orig) => ({
  ...(await orig<object>()),
  getSupportedIndicators: () => ["EMA", "RSI"],
}));

const addIndicatorInstance = vi.fn();
const removeIndicatorById = vi.fn();
vi.mock("../lib/indicators", async (orig) => ({
  ...(await orig<object>()),
  addIndicatorInstance: (...args: unknown[]) => addIndicatorInstance(...args),
  removeIndicatorById: (...args: unknown[]) => removeIndicatorById(...args),
}));

const saveIndicators = vi.fn();
vi.mock("../lib/persist", async (orig) => ({
  ...(await orig<object>()),
  saveIndicators: (...args: unknown[]) => saveIndicators(...args),
}));

import MobileIndicatorsSheet from "./MobileIndicatorsSheet";
import { mobileChartCtx } from "./mobileChartState";
import { Signal } from "../lib/signals";
import type { IndicatorInstance } from "../lib/persist";

afterEach(cleanup);

function makeController(initial: IndicatorInstance[] = []) {
  return {
    scope: "mobile",
    indicators: new Signal<IndicatorInstance[]>(initial),
    indicatorsHidden: new Signal<boolean>(false),
    subPanesHidden: new Signal<boolean>(false),
    avwapAnchorMode: new Signal<string | null>(null),
  };
}

describe("MobileIndicatorsSheet", () => {
  beforeEach(() => {
    addIndicatorInstance.mockReset();
    removeIndicatorById.mockReset();
    saveIndicators.mockReset();
  });

  it("adds an indicator via the type picker", async () => {
    addIndicatorInstance.mockReturnValue({ id: "EMA1", type: "EMA" });
    const controller = makeController([]);
    mobileChartCtx.set({ chart: {}, controller } as never);

    render(<MobileIndicatorsSheet onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Add indicator" }));
    await userEvent.click(screen.getByRole("button", { name: /EMA/ }));

    expect(addIndicatorInstance).toHaveBeenCalled();
    expect(controller.indicators.value).toEqual([{ id: "EMA1", type: "EMA" }]);
    expect(saveIndicators).toHaveBeenCalledWith("mobile", [{ id: "EMA1", type: "EMA" }]);
  });

  it("removes an indicator instance from the active list", async () => {
    const controller = makeController([{ id: "EMA1", type: "EMA" }]);
    mobileChartCtx.set({ chart: {}, controller } as never);

    render(<MobileIndicatorsSheet onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(removeIndicatorById).toHaveBeenCalledWith({}, "mobile", "EMA1");
    expect(controller.indicators.value).toEqual([]);
    expect(saveIndicators).toHaveBeenCalledWith("mobile", []);
  });
});
