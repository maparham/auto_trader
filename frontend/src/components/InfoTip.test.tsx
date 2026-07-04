// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import InfoTip from "./InfoTip";

afterEach(cleanup);

describe("InfoTip", () => {
  it("shows the title and text on hover of the ⓘ glyph", () => {
    render(<InfoTip title="Margin" text={["Deposit required.", "= notional ÷ leverage."]} />);
    fireEvent.focus(screen.getByRole("button", { name: "About Margin" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector(".tooltip-title")?.textContent).toBe("Margin");
    expect(tip.querySelectorAll(".tooltip-desc").length).toBe(2);
  });

  it("swallows clicks so it never toggles a wrapping row/label", () => {
    let outer = 0;
    render(
      <div onClick={() => { outer += 1; }}>
        <InfoTip text="hi" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More info" }));
    expect(outer).toBe(0);
  });
});
