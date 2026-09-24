// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import SplitMarkers, { type SplitMarkersHandle } from "./SplitMarkers";

afterEach(cleanup);

describe("SplitMarkers", () => {
  it("renders one chip per marker on the pane's bottom edge", () => {
    const ref = createRef<SplitMarkersHandle>();
    render(<SplitMarkers handleRef={ref} />);
    act(() =>
      ref.current!.setMarkers(
        [{ key: "split:1", x: 40, label: "25:1", date: "6 Apr 2026" }],
        200,
      ),
    );
    const chip = screen.getByLabelText("Stock split 25:1, 6 Apr 2026");
    expect(chip.textContent).toBe("S");
    expect(chip.style.left).toBe("40px");
    expect(chip.style.top).toBe(`${200 - 18}px`);
  });

  it("renders nothing without markers", () => {
    const ref = createRef<SplitMarkersHandle>();
    const { container } = render(<SplitMarkers handleRef={ref} />);
    act(() => ref.current!.setMarkers([], 200));
    expect(container.firstChild).toBeNull();
  });
});
