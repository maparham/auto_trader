// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import CustomTimeframeForm from "./CustomTimeframeForm";

afterEach(cleanup);

const UNIT_NAME: Record<string, string> = {
  MINUTE: "minutes", HOUR: "hours", DAY: "days", WEEK: "weeks", MONTH: "months",
};

function fill(n: string, unit: string) {
  fireEvent.click(screen.getByRole("radio", { name: UNIT_NAME[unit] }));
  fireEvent.change(screen.getByLabelText("Custom timeframe size"), { target: { value: n } });
}

const addButton = () => screen.queryByRole("button", { name: /^Add/ });

describe("CustomTimeframeForm", () => {
  it("previews the canonical label and adds the canonical timeframe", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("120", "MINUTE");
    expect(addButton()!.textContent).toBe("Add 2H");
    fireEvent.click(addButton()!);
    expect(onAdd).toHaveBeenCalledWith("HOUR_2");
    expect((screen.getByLabelText("Custom timeframe size") as HTMLInputElement).value).toBe("");
  });
  it("submits on Enter", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("7", "MINUTE");
    fireEvent.submit(screen.getByLabelText("Custom timeframe size").closest("form")!);
    expect(onAdd).toHaveBeenCalledWith("MINUTE_7");
  });
  it("disables Add while the size is empty", () => {
    render(<CustomTimeframeForm onAdd={vi.fn()} />);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });
  it("marks the selected unit", () => {
    render(<CustomTimeframeForm onAdd={vi.fn()} />);
    fill("3", "MONTH");
    expect(screen.getByRole("radio", { name: "months" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "minutes" }).getAttribute("aria-checked")).toBe("false");
    expect(addButton()!.textContent).toBe("Add 3M");
  });
  it("shows the reason for an out-of-limit size and offers no Add", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("25", "HOUR");
    expect(screen.getByRole("alert").textContent).toContain("hours must be between 1 and 24");
    expect(addButton()).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("names the unit's range for a size too long for the grammar", () => {
    render(<CustomTimeframeForm onAdd={vi.fn()} />);
    fill("100000", "MINUTE");
    expect(screen.getByRole("alert").textContent).toBe("minutes must be between 1 and 1439");
  });
  it("rejects a fractional size", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("1.5", "HOUR");
    expect(screen.getByRole("alert").textContent).toBe("Use a whole number");
    fireEvent.submit(screen.getByLabelText("Custom timeframe size").closest("form")!);
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("re-validates when the unit changes", () => {
    render(<CustomTimeframeForm onAdd={vi.fn()} />);
    fill("30", "HOUR");
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "minutes" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(addButton()!.textContent).toBe("Add 30m");
  });
});
