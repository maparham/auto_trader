// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PickChoiceHost from "./PickChoiceHost";
import { pickChoiceRequest } from "../lib/pickChoice";

afterEach(() => { cleanup(); pickChoiceRequest.set(null); });

const OPTIONS = [
  { token: "RSI.bullDiv", label: "Bullish divergence" },
  { token: "RSI.value", label: "RSI value" },
];

describe("PickChoiceHost", () => {
  it("lists the options and delivers the chosen token once", () => {
    const onChoose = vi.fn();
    render(<PickChoiceHost />);
    act(() => pickChoiceRequest.set({ options: OPTIONS, onChoose }));
    fireEvent.click(screen.getByRole("menuitem", { name: /RSI value/ }));
    expect(onChoose).toHaveBeenCalledWith("RSI.value");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape and an outside click close it without inserting", () => {
    const onChoose = vi.fn();
    render(<PickChoiceHost />);
    act(() => pickChoiceRequest.set({ options: OPTIONS, onChoose }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => pickChoiceRequest.set({ options: OPTIONS, onChoose }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
  });
});
