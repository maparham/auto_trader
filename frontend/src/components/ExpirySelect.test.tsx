// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExpirySelect from "./ExpirySelect";

afterEach(cleanup);

describe("ExpirySelect", () => {
  it("defaults to Good-Till-Cancelled and reports null", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    const sel = screen.getByRole("combobox") as HTMLSelectElement;
    expect(sel.value).toBe("gtc");
  });

  it("selecting a preset reports a future timestamp", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "d30" } });
    const ms = onChange.mock.calls.at(-1)![0];
    expect(ms).toBeGreaterThan(Date.now());
  });

  it("custom relative entry reports now + duration", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    // relative radio is the default custom mode; set amount to 45 minutes
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "45" } });
    const ms = onChange.mock.calls.at(-1)![0];
    expect(ms).toBeGreaterThan(Date.now() + 44 * 60_000);
    expect(ms).toBeLessThan(Date.now() + 46 * 60_000);
  });

  it("mounting with a non-null value seeds the absolute custom form", () => {
    const onChange = vi.fn();
    const at = Date.now() + 60 * 60_000; // 1h from now
    render(<ExpirySelect value={at} onChange={onChange} />);
    const sel = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(sel.value).toBe("custom");
    const dateInput = screen.getByLabelText(/date-time/i) as HTMLInputElement;
    expect(dateInput.value).not.toBe("");
    const absoluteRadio = dateInput.closest("label")!.querySelector(
      'input[type="radio"]',
    ) as HTMLInputElement;
    expect(absoluteRadio.checked).toBe(true);
    // Mounting must not itself emit a change (would dirty pending state).
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mounting with a null value (new order) still shows GTC", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    const sel = screen.getByRole("combobox") as HTMLSelectElement;
    expect(sel.value).toBe("gtc");
    expect(onChange).not.toHaveBeenCalled();
  });
});
