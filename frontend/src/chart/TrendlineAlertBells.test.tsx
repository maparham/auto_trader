// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import TrendlineAlertBells from "./TrendlineAlertBells";

describe("TrendlineAlertBells", () => {
  afterEach(cleanup);

  it("renders a bell at its pixel and edits on double click", () => {
    const onDoubleClick = vi.fn();
    const { container, getByLabelText } = render(
      <TrendlineAlertBells bells={[{ id: "al-l", x: 120, y: 55 }]} onDoubleClick={onDoubleClick} />,
    );
    const bell = container.querySelector(".tl-alert-bell") as HTMLElement;
    expect(bell).not.toBeNull();
    expect(bell.style.left).toBe("120px");
    expect(bell.style.top).toBe("55px");

    // A mouse click (detail 1) does nothing; only the double click edits.
    fireEvent.click(getByLabelText("Trendline alert"), { detail: 1 });
    expect(onDoubleClick).not.toHaveBeenCalled();
    fireEvent.doubleClick(getByLabelText("Trendline alert"));
    expect(onDoubleClick).toHaveBeenCalledWith("al-l");
  });

  it("edits on keyboard activation (a click with no pointer detail)", () => {
    const onDoubleClick = vi.fn();
    const { getByLabelText } = render(
      <TrendlineAlertBells bells={[{ id: "al-l", x: 0, y: 0 }]} onDoubleClick={onDoubleClick} />,
    );
    fireEvent.click(getByLabelText("Trendline alert"), { detail: 0 });
    expect(onDoubleClick).toHaveBeenCalledWith("al-l");
  });
});
