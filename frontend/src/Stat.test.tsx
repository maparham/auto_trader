// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Stat } from "./PositionsPanel";

afterEach(cleanup);

describe("Stat", () => {
  it("shows the title as a tooltip on hover", () => {
    render(
      <Stat
        label="Margin"
        value="$1,234"
        title="Total deposit currently tied up by open positions"
      />,
    );
    const stat = screen.getByText("Margin").closest(".pp-stat")!;
    fireEvent.mouseEnter(stat.parentElement!);
    fireEvent.focus(stat.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Total deposit currently tied up by open positions",
    );
  });

  it("renders inertly with no tooltip when title is omitted", () => {
    render(<Stat label="Balance" value="$5,000" />);
    const stat = screen.getByText("Balance").closest(".pp-stat")!;
    fireEvent.focus(stat.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("applies the pos/neg tone class to the value", () => {
    render(<Stat label="P&L" value="+$50" tone="pos" />);
    expect(screen.getByText("+$50").className).toContain("pp-pos");
  });
});
