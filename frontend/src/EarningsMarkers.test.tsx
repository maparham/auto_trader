// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import EarningsMarkers, { type EarningsMarkersHandle } from "./EarningsMarkers";

afterEach(cleanup);

const lines = ["Earnings 30 Jul 2026", "Reported", "EPS est 1.89", "EPS actual 2.02", "Surprise +6.7%"];

describe("EarningsMarkers", () => {
  it("renders one chip per marker on the pane's bottom edge", () => {
    const ref = createRef<EarningsMarkersHandle>();
    render(<EarningsMarkers handleRef={ref} />);
    act(() => ref.current!.setMarkers([{ key: "earn:1", x: 40, lines, upcoming: false, lift: false }], 200));
    const chip = screen.getByLabelText(lines.join(", "));
    expect(chip.textContent).toBe("E");
    expect(chip.style.left).toBe("40px");
    expect(chip.style.top).toBe(`${200 - 18}px`);
    expect(chip.style.border).toContain("solid");
  });

  it("dashes an upcoming chip and lifts one off a split chip", () => {
    const ref = createRef<EarningsMarkersHandle>();
    render(<EarningsMarkers handleRef={ref} />);
    act(() =>
      ref.current!.setMarkers([{ key: "earn:2", x: 90, lines: ["Earnings 2 Nov 2026", "Estimated"], upcoming: true, lift: true }], 200),
    );
    const chip = screen.getByLabelText("Earnings 2 Nov 2026, Estimated");
    expect(chip.style.border).toContain("dashed");
    expect(chip.style.top).toBe(`${200 - 18 - 16}px`);
  });

  it("renders nothing without markers", () => {
    const ref = createRef<EarningsMarkersHandle>();
    const { container } = render(<EarningsMarkers handleRef={ref} />);
    act(() => ref.current!.setMarkers([], 200));
    expect(container.firstChild).toBeNull();
  });
});
