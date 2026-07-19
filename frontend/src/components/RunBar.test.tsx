// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeSeg } from "./RunBar";

afterEach(cleanup);

describe("ModeSeg", () => {
  it("renders three modes and dispatches walkforward", () => {
    const onSelect = vi.fn();
    render(<ModeSeg mode="sweep" onSelectMode={onSelect} modeBadge={null} wfoBadge={null} />);
    const wfoBtn = screen.getByRole("button", { name: /walk-fwd/i });
    fireEvent.click(wfoBtn);
    expect(onSelect).toHaveBeenCalledWith("walkforward");
    // Plain getAttribute: @testing-library/jest-dom is not a dependency here.
    expect(screen.getByRole("button", { name: /sweep/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("marks walkforward active", () => {
    render(<ModeSeg mode="walkforward" onSelectMode={() => {}} modeBadge={null} wfoBadge={<span>3/9</span>} />);
    expect(screen.getByRole("button", { name: /walk-fwd/i }).getAttribute("aria-pressed")).toBe("true");
  });
});
