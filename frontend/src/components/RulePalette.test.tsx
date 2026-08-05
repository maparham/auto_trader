// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RulePalette from "./RulePalette";

afterEach(cleanup);

function open(props: Partial<Parameters<typeof RulePalette>[0]> = {}) {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  render(<RulePalette onInsert={onInsert} onClose={onClose} {...props} />);
  return { onInsert, onClose };
}

describe("RulePalette", () => {
  it("renders as a titled modal", () => {
    open({ title: "Insert into rule 2" });
    expect(screen.getByText("Insert into rule 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("inserts an indicator's default snippet on click, then closes", async () => {
    const { onInsert, onClose } = open();
    await userEvent.click(screen.getByRole("button", { name: /EMA\(length\)/ }));
    expect(onInsert).toHaveBeenCalledWith("EMA(9)");
    expect(onClose).toHaveBeenCalled();
  });

  it("groups candle fields, indicators, wrappers, crosses, and timeframes", () => {
    open();
    for (const g of ["Candle", "Indicators", "Wrappers", "Crosses", "Timeframes"]) {
      expect(screen.getByText(g)).toBeTruthy();
    }
  });

  it("filters items and hides groups with no match", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Filter palette"), "cross");
    expect(screen.getByText("Crosses")).toBeTruthy();
    expect(screen.queryByText("Candle")).toBeNull();
    expect(screen.queryByRole("button", { name: /EMA\(length\)/ })).toBeNull();
  });

  it("matches on an entry's description, not just its name", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Filter palette"), "exponential");
    expect(screen.getByRole("button", { name: /EMA\(length\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /SMA\(length\)/ })).toBeNull();
  });

  it("inserts the first visible match on Enter", async () => {
    const { onInsert, onClose } = open();
    const filter = screen.getByLabelText("Filter palette");
    await userEvent.type(filter, "rsi{Enter}");
    expect(onInsert).toHaveBeenCalledWith("RSI(14)");
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Enter on an empty filter (no reflex insert of the first entry)", async () => {
    const { onInsert, onClose } = open();
    await userEvent.type(screen.getByLabelText("Filter palette"), "{Enter}");
    expect(onInsert).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a no-matches note and inserts nothing on Enter", async () => {
    const { onInsert, onClose } = open();
    await userEvent.type(screen.getByLabelText("Filter palette"), "zzzz{Enter}");
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(onInsert).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
