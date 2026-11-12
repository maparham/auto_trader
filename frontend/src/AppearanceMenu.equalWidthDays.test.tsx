// @vitest-environment jsdom
// Equal-width days is a display choice, so it lives in the Appearance menu.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AppearanceMenu from "./AppearanceMenu";
import { DEFAULT_SETTINGS } from "./theme";

describe("AppearanceMenu: Equal-width days", () => {
  it("shows the switch and flips the setting", () => {
    const onChange = vi.fn();
    render(<AppearanceMenu settings={{ ...DEFAULT_SETTINGS, equalWidthDays: false }} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("button")[0]); // open the menu
    const sw = screen.getByRole("switch", { name: "Time gaps" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ equalWidthDays: true }));
  });
});
