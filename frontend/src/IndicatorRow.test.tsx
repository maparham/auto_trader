// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import IndicatorRow from "./IndicatorRow";

afterEach(cleanup);

describe("IndicatorRow", () => {
  it("shows the indicator's description via InfoTip when one exists", () => {
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "About Relative Strength Index" }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Momentum oscillator (0–100) measuring the speed of gains vs losses",
    );
  });

  it("renders no info button for an indicator with no catalogued description", () => {
    render(<IndicatorRow name="NOT_A_REAL_INDICATOR" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    expect(screen.queryByRole("button", { name: "About NOT_A_REAL_INDICATOR" })).toBeNull();
  });

  it("shows a tooltip on the favorite star reflecting its current state", () => {
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => {}} onToggleFavorite={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "Add to favorites" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Add to favorites");
  });

  it("clicking the row (not the star or info button) calls onAdd", () => {
    let added = false;
    render(<IndicatorRow name="RSI" favorite={false} onAdd={() => { added = true; }} onToggleFavorite={() => {}} />);
    fireEvent.click(screen.getByText(/Relative Strength|RSI/));
    expect(added).toBe(true);
  });
});
