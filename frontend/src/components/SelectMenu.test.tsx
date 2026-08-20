// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SelectMenu from "./SelectMenu";

afterEach(cleanup);

const OPTS = [
  { value: "ray", label: "Extend right" },
  { value: "lastbar", label: "End at last bar" },
  { value: "segment", label: "Segment, stops at last touch" },
];

function setup(value = "ray") {
  const onChange = vi.fn();
  render(<SelectMenu value={value} options={OPTS} onChange={onChange} ariaLabel="Extend" />);
  return { onChange, trigger: screen.getByRole("button", { name: "Extend" }) };
}

describe("SelectMenu", () => {
  it("shows the selected option's LABEL, not its value", () => {
    setup("lastbar");
    expect(screen.getByRole("button", { name: "Extend" }).textContent).toContain(
      "End at last bar",
    );
  });

  it("opens a listbox below the field and marks the current option", () => {
    const { trigger } = setup("lastbar");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox");
    // Fixed, not absolute: .floating-modal-body scrolls, so an absolutely
    // positioned list would be clipped for a field near the bottom.
    expect(list.style.position || getComputedStyle(list).position).not.toBe("absolute");
    const sel = (name: string) =>
      screen.getByRole("option", { name }).getAttribute("aria-selected");
    expect(sel("End at last bar")).toBe("true");
    expect(sel("Extend right")).toBe("false");
  });

  it("emits the VALUE of the option clicked, and closes", () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Segment, stops at last touch" }));
    expect(onChange).toHaveBeenCalledWith("segment");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // The app-wide rule: every popover closes on an outside click. Tested with
  // mousedown specifically, because that is the event the handler listens for
  // and a click-only test passes against a handler that never fires.
  it("closes on an outside mousedown", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open for a mousedown inside its own list", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Extend right" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  // The close-on-scroll listener is capture-phase on window, so without an
  // origin check a wheel inside a list long enough to overflow (it is
  // overflow-y: auto under a max height) closes the menu mid-scroll.
  it("stays open when its own list is scrolled", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("closes on a scroll elsewhere on the page", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("toggles shut when the trigger is clicked again", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("falls back to the raw value when no option matches", () => {
    render(<SelectMenu value="mystery" options={OPTS} onChange={vi.fn()} ariaLabel="X" />);
    expect(screen.getByRole("button", { name: "X" }).textContent).toContain(
      "mystery",
    );
  });
});
