// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ColorLineStylePicker from "./ColorLineStylePicker";

afterEach(cleanup);

describe("ColorLineStylePicker", () => {
  it("shows the explicit title as a tooltip on the swatch trigger", () => {
    render(<ColorLineStylePicker color="#ff0000" onColor={() => {}} title="Bid line" />);
    fireEvent.focus(screen.getByRole("button", { name: "" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Bid line");
  });

  it("falls back to the default title when none is passed", () => {
    render(<ColorLineStylePicker color="#ff0000" onColor={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Color & line style");
  });

  it("shows a tooltip with the hex code on a palette cell once the popover is open", () => {
    render(<ColorLineStylePicker color="#ffffff" onColor={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "" }));
    // PALETTE's first entry is "#ffffff" (top-left of the greyscale row) — a
    // stable index, unlike matching on the cell's serialized inline style.
    const firstCell = document.querySelectorAll(".clsp-cell")[0] as HTMLElement;
    fireEvent.focus(firstCell);
    expect(screen.getByRole("tooltip").textContent).toContain("#ffffff");
  });

  it("shows a tooltip on a thickness preset when size is supplied", () => {
    render(
      <ColorLineStylePicker color="#000000" onColor={() => {}} size={2} onSize={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "" }));
    const presets = document.querySelectorAll(".clsp-preset");
    fireEvent.focus(presets[0]);
    expect(screen.getByRole("tooltip").textContent).toContain("1px");
  });
});
