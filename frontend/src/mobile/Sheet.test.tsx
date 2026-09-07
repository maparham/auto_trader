// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sheet from "./Sheet";

describe("Sheet", () => {
  it("renders children in a dialog and closes on backdrop click", async () => {
    const onClose = vi.fn();
    render(<Sheet title="Test sheet" onClose={onClose}><p>hello</p></Sheet>);
    expect(screen.getByRole("dialog", { name: "Test sheet" })).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    await userEvent.click(document.querySelector(".m-sheet-backdrop")!);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><p>x</p></Sheet>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
