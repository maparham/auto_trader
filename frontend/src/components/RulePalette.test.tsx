// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RulePalette from "./RulePalette";

afterEach(cleanup);

describe("RulePalette", () => {
  it("inserts an indicator's default snippet on click", async () => {
    const onInsert = vi.fn();
    render(<RulePalette onInsert={onInsert} />);
    await userEvent.click(screen.getByRole("button", { name: /EMA\(length\)/ }));
    expect(onInsert).toHaveBeenCalledWith("EMA(9)");
  });
  it("groups candle fields, indicators, wrappers, crosses, and timeframes", () => {
    render(<RulePalette onInsert={() => {}} />);
    for (const g of ["Candle", "Indicators", "Wrappers", "Crosses", "Timeframes"]) {
      expect(screen.getByText(g)).toBeTruthy();
    }
  });
});
