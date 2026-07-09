// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrategyParams } from "./StrategyParams";
import type { ParamSpec } from "../api";

afterEach(cleanup);

const specs: ParamSpec[] = [
  { name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
    min: 2, max: 50, step: 1, options: null, help: "EMA length" },
  { name: "longs_only", label: "Longs only", type: "bool", default: true,
    min: null, max: null, step: null, options: null, help: null },
  { name: "mode", label: "Mode", type: "choice", default: "fast",
    min: null, max: null, step: null, options: ["fast", "slow"], help: null },
];

describe("StrategyParams", () => {
  it("renders one control per spec with default hints", () => {
    render(<StrategyParams specs={specs}
      values={{ ema_fast: 9, longs_only: true, mode: "fast" }} onChange={() => {}} />);
    expect(screen.getByText("Fast EMA")).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByText(/default 9/)).toBeTruthy();
  });

  it("emits changed values and marks them changed", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<StrategyParams specs={specs}
      values={{ ema_fast: 9, longs_only: true, mode: "fast" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ longs_only: false }));
    rerender(<StrategyParams specs={specs}
      values={{ ema_fast: 12, longs_only: true, mode: "fast" }} onChange={onChange} />);
    expect(container.querySelector(".sp-changed")).toBeTruthy();
  });

  it("Reset all restores every default", () => {
    const onChange = vi.fn();
    render(<StrategyParams specs={specs}
      values={{ ema_fast: 12, longs_only: false, mode: "slow" }} onChange={onChange} />);
    fireEvent.click(screen.getByText("Reset all"));
    expect(onChange).toHaveBeenCalledWith({ ema_fast: 9, longs_only: true, mode: "fast" });
  });

  it("renders nothing for an empty schema", () => {
    const { container } = render(
      <StrategyParams specs={[]} values={{}} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("snaps numeric values to the spec's step on blur", () => {
    const onChange = vi.fn();
    const stepSpecs: ParamSpec[] = [
      { name: "interval", label: "Interval", type: "int", default: 10,
        min: 0, max: 100, step: 5, options: null, help: "Step size test" },
    ];
    render(<StrategyParams specs={stepSpecs}
      values={{ interval: 10 }} onChange={onChange} />);
    const input = screen.getByDisplayValue("10") as HTMLInputElement;
    // Type 12 (off the step=5 multiple): expects snap to 10 (Math.round(12/5)*5 = 10)
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ interval: 10 }));
  });
});
