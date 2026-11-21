// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ChartRangeBar from "./ChartRangeBar";

afterEach(cleanup);

function renderBar(onGoToDate = vi.fn()) {
  render(
    <ChartRangeBar activeKey={null} onPick={() => {}} onGoToDate={onGoToDate} />,
  );
  return onGoToDate;
}

const openPicker = () => fireEvent.click(screen.getByLabelText("Open date picker"));
const dateInput = () => screen.getByLabelText("Go to date") as HTMLInputElement;
const timeInput = () => screen.getByLabelText("Go to time") as HTMLInputElement;
const enter = (d: string, t: string) => {
  fireEvent.change(dateInput(), { target: { value: d } });
  fireEvent.change(timeInput(), { target: { value: t } });
};

describe("ChartRangeBar go-to-date", () => {
  it("joins date and time and hands them up on Go", () => {
    const onGoToDate = renderBar();
    openPicker();
    // Separate fields, not datetime-local: WebKit shows a gray placeholder in
    // an empty time part, and the half-filled field then blocks Go.
    expect(dateInput().type).toBe("date");
    expect(timeInput().type).toBe("time");
    enter("2024-03-07", "14:30");
    fireEvent.submit(dateInput().closest("form")!);
    expect(onGoToDate).toHaveBeenCalledWith("2024-03-07T14:30");
  });

  it("accepts a date with no time", () => {
    const onGoToDate = renderBar();
    openPicker();
    fireEvent.change(dateInput(), { target: { value: "2024-03-07" } });
    fireEvent.submit(dateInput().closest("form")!);
    expect(onGoToDate).toHaveBeenCalledWith("2024-03-07");
  });

  it("keeps the entered value between Go runs", () => {
    renderBar();
    openPicker();
    enter("2024-03-07", "14:30");
    fireEvent.submit(dateInput().closest("form")!);
    // Submit closes the popover; reopening must show the last value, so a
    // second jump near the first is an edit, not a re-type. (Session-only:
    // component state, nothing persisted.)
    openPicker();
    expect(dateInput().value).toBe("2024-03-07");
    expect(timeInput().value).toBe("14:30");
  });

  it("keeps the value when the popover is dismissed without submitting", () => {
    renderBar();
    openPicker();
    enter("2024-03-07", "14:30");
    fireEvent.keyDown(document, { key: "Escape" });
    openPicker();
    expect(dateInput().value).toBe("2024-03-07");
    expect(timeInput().value).toBe("14:30");
  });
});
