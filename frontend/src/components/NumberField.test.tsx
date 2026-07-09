// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import NumberField from "./NumberField";

afterEach(cleanup);

// A number <input type="number"> reports .value as "" while a decimal is mid-entry
// ("0."), which a controlled numeric field rounds back to 0 and wipes the dot.
// NumberField keeps a draft string so fractional thresholds survive keystrokes.
describe("NumberField", () => {
  it("commits a fractional value and keeps the typed text", () => {
    const onChange = vi.fn();
    render(<NumberField value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0.0225" } });
    expect(input.value).toBe("0.0225");
    expect(onChange).toHaveBeenLastCalledWith(0.0225);
  });

  it("keeps a trailing dot on screen without committing a bad number", () => {
    const onChange = vi.fn();
    render(<NumberField value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0." } });
    expect(input.value).toBe("0."); // draft survives so the next digit lands after it
    expect(onChange).not.toHaveBeenCalledWith(NaN);
  });

  it("ignores a comma (comma-locale decimal key) rather than treating it as a separator", () => {
    const onChange = vi.fn();
    render(<NumberField value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0,5" } });
    expect(onChange).toHaveBeenLastCalledWith(5); // comma dropped -> "05" -> 5, never 0.5
  });

  it("strips a leading minus by default (unsigned)", () => {
    const onChange = vi.fn();
    render(<NumberField value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-3.5" } });
    expect(input.value).toBe("3.5");
    expect(onChange).toHaveBeenLastCalledWith(3.5);
  });

  it("accepts a negative fractional value when signed", () => {
    const onChange = vi.fn();
    render(<NumberField signed value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-0.05" } });
    expect(input.value).toBe("-0.05");
    expect(onChange).toHaveBeenLastCalledWith(-0.05);
  });

  it("holds a lone minus without committing", () => {
    const onChange = vi.fn();
    render(<NumberField signed value={0} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "-" } });
    expect(input.value).toBe("-");
    expect(onChange).not.toHaveBeenCalled();
  });
});
