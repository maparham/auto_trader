// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AlertBell, { type AlertBellActions } from "./AlertBellList";
import type { LegendAlertBell } from "./legendAlertBells";

afterEach(cleanup);

const LIVE: LegendAlertBell[] = [
  { id: "a", label: "Crossing EMA 50 (1D)" },
  { id: "b", label: "Crossing Up EMA 50 (1D)" },
];

// The bell inside a stand-in legend row whose own handlers must never fire
// from the list (it is portaled, but React bubbles through the tree).
function setup(list: LegendAlertBell[] = LIVE) {
  const actions: Required<AlertBellActions> = {
    onEdit: vi.fn(), onDelete: vi.fn(), onRearm: vi.fn(), onHide: vi.fn(),
  };
  const row = { click: vi.fn(), dblclick: vi.fn() };
  render(
    <div onClick={row.click} onDoubleClick={row.dblclick}>
      <AlertBell list={list} actions={actions} />
    </div>,
  );
  const bell = screen.getByRole("button", { name: /Indicator alerts/ });
  return { actions, row, bell };
}

const list = () => screen.queryByRole("dialog", { name: "Indicator alerts" });

describe("AlertBell", () => {
  it("shows the count as a superscript only for several alerts", () => {
    const { bell } = setup();
    expect(bell.className).toContain("has-count");
    expect(bell.textContent).toBe("2");
    cleanup();
    expect(setup([LIVE[0]]).bell.textContent).toBe("");
  });

  it("opens a list of the alerts on click, and closes on a second click", () => {
    const { bell, row } = setup();
    fireEvent.click(bell);
    expect(list()).not.toBeNull();
    expect(screen.getByText("Crossing Up EMA 50 (1D)")).toBeTruthy();
    expect(bell.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(bell);
    expect(list()).toBeNull();
    expect(row.click).not.toHaveBeenCalled();
  });

  it("opens on a right click too, focusing the first row", () => {
    const { bell } = setup();
    fireEvent.contextMenu(bell);
    expect(list()).not.toBeNull();
    expect(document.activeElement?.textContent).toContain("Crossing EMA 50 (1D)");
  });

  it("edits the alert whose row is clicked, closes, and never reaches the legend row", () => {
    const { bell, actions, row } = setup();
    fireEvent.click(bell);
    fireEvent.click(screen.getByText("Crossing Up EMA 50 (1D)"));
    expect(actions.onEdit).toHaveBeenCalledWith("b");
    expect(list()).toBeNull();
    expect(row.click).not.toHaveBeenCalled();
  });

  it("edits a row on Enter", () => {
    const { bell, actions } = setup();
    fireEvent.click(bell);
    const first = screen.getByText("Crossing EMA 50 (1D)").closest('[role="button"]')!;
    fireEvent.keyDown(first, { key: "Enter" });
    expect(actions.onEdit).toHaveBeenCalledWith("a");
  });

  it("deletes from the trash button without also editing", () => {
    const { bell, actions, row } = setup();
    fireEvent.click(bell);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    expect(actions.onDelete).toHaveBeenCalledWith("b");
    expect(actions.onEdit).not.toHaveBeenCalled();
    expect(row.click).not.toHaveBeenCalled();
  });

  it("keeps a double click inside the list from opening the indicator settings", () => {
    const { bell, row } = setup();
    fireEvent.click(bell);
    fireEvent.doubleClick(list()!);
    expect(row.dblclick).not.toHaveBeenCalled();
  });

  it("closes on an outside mousedown and on Escape, which it consumes", () => {
    const { bell } = setup();
    fireEvent.click(bell);
    fireEvent.mouseDown(document.body);
    expect(list()).toBeNull();

    fireEvent.click(bell);
    const later = vi.fn();
    window.addEventListener("keydown", later);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    window.removeEventListener("keydown", later);
    expect(list()).toBeNull();
    expect(later).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(bell);
  });

  it("closes when the window resizes", () => {
    const { bell } = setup();
    fireEvent.click(bell);
    fireEvent(window, new Event("resize"));
    expect(list()).toBeNull();
  });

  it("gives a fired alert Re-arm and Hide, and its row does not edit", () => {
    const { bell, actions } = setup([{ id: "f", label: "RSI 14 bullish divergence (5m)", firedAt: Date.now() - 60_000 }]);
    expect(bell.className).toContain("fired");
    fireEvent.click(bell);
    fireEvent.click(screen.getByText("RSI 14 bullish divergence (5m)"));
    expect(actions.onEdit).not.toHaveBeenCalled();
    expect(list()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-arm" }));
    expect(actions.onRearm).toHaveBeenCalledWith("f");
    fireEvent.click(bell);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(actions.onHide).toHaveBeenCalledWith("f");
  });

  it("dims the bell only when every alert on it has fired", () => {
    const { bell } = setup([LIVE[0], { id: "f", label: "x", firedAt: 1 }]);
    expect(bell.className).not.toContain("fired");
  });
});
