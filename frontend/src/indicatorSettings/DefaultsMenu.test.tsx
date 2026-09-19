// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DefaultsMenu from "./DefaultsMenu";
import { saveIndicatorPreset } from "../lib/persist";
import { installMemStorage } from "../lib/testMemStorage";
installMemStorage();

vi.mock("../lib/indicators", () => ({
  applyIndicator: vi.fn(() => "p1"),
  removeIndicatorById: vi.fn(),
}));
import { applyIndicator, removeIndicatorById } from "../lib/indicators";

// A preset row is mostly empty space beside a short name like "1D", and the
// hover highlight covers the whole row, so the click must apply from anywhere
// on it, not just the label.
describe("DefaultsMenu preset apply", () => {
  it("clicking the preset ROW (beside the label) recreates the instance and closes", () => {
    saveIndicatorPreset("TRENDLINES", "1D", { calcParams: [7, 40], extendData: { mtf: { timeframe: "DAY" } } });
    const onClose = vi.fn();
    render(
      <DefaultsMenu chart={{} as never} scope="s" epic="US100" name="tl1" type="TRENDLINES"
        currentConfig={() => ({})} onClose={onClose} />,
    );
    fireEvent.click(screen.getByText("Defaults ▾"));
    fireEvent.click(screen.getByText("1D").closest("li")!);
    expect(removeIndicatorById).toHaveBeenCalled();
    expect(applyIndicator).toHaveBeenCalledWith({}, "s", "US100", { id: "tl1", type: "TRENDLINES" },
      { config: { calcParams: [7, 40], extendData: { mtf: { timeframe: "DAY" } } }, rehydrate: true });
    expect(onClose).toHaveBeenCalled();
  });
});
