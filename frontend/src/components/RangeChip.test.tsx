// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";

import { RangeChip } from "./RangeChip";
import type { RangeAxis } from "../lib/sweep";

afterEach(cleanup);

const axis: RangeAxis = { kind: "range", target: "param:len", label: "len", from: -2, to: 2, step: 0.5 };

describe("RangeChip", () => {
  it("shows just the run-count badge (range lives in the tooltip)", () => {
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={() => {}} />);
    const chip = screen.getByRole("button", { name: /sweep len/i });
    expect(chip.textContent).toBe("9×");
    expect(chip.textContent).not.toContain("-2 … 2");
  });

  it("opens a popover whose fields patch the axis", () => {
    const onPatch = vi.fn();
    render(<RangeChip axis={axis} onPatch={onPatch} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /sweep len/i }));
    const from = screen.getByLabelText("From");
    fireEvent.change(from, { target: { value: "-3" } });
    fireEvent.blur(from);
    expect(onPatch).toHaveBeenCalledWith({ from: -3 });
  });

  it("popover offers Remove from sweep", () => {
    const onRemove = vi.fn();
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /sweep len/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("flags a degenerate range instead of a count", () => {
    render(
      <RangeChip axis={{ ...axis, step: 0 }} onPatch={() => {}} onRemove={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /sweep len/i }).textContent).toContain("∞");
  });

  it("disabled renders inert", () => {
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={() => {}} disabled />);
    const chip = screen.getByRole("button", { name: /sweep len/i });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(screen.queryByLabelText("From")).toBeNull();
  });
});
