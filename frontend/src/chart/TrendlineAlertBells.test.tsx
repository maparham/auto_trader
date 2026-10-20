// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import TrendlineAlertBells from "./TrendlineAlertBells";
import { stepPastTags } from "./lineAlertBellPlace";

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

describe("stepPastTags", () => {
  const flat = () => 50;
  it("stays put with no tag in the way", () => {
    expect(stepPastTags(100, flat, [{ x: 200, y: 50, w: 20 }], 0, 16)).toEqual({ x: 100, y: 50 });
  });

  it("walks right past a tag it would cover, staying on its line", () => {
    const rising = (x: number) => 200 - x;
    // Tag spans x 95..120 at y 104 (pane 0): covers the bell at x 100, y 100.
    const out = stepPastTags(100, rising, [{ x: 95, y: 104, w: 25 }], 0, 16);
    expect(out.x).toBe(95 + 25 + 8 + 2);
    expect(out.y).toBe(rising(out.x));
  });

  it("chains past consecutive tags and ignores one on another row", () => {
    const tags = [
      { x: 95, y: 50, w: 20 },
      { x: 120, y: 50, w: 20 },
      { x: 100, y: 90, w: 40 },
    ];
    expect(stepPastTags(100, flat, tags, 0, 16)).toEqual({ x: 150, y: 50 });
  });

  it("offsets pane-pixel tags by the pane top", () => {
    const tag = [{ x: 95, y: 10, w: 20 }];
    expect(stepPastTags(100, flat, tag, 0, 16).x).toBe(100);
    expect(stepPastTags(100, flat, tag, 40, 16).x).toBe(125);
  });
});
